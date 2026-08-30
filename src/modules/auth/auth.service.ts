import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hashToken } from "src/common/security/token-hash";
import { Gender, RefreshToken, User } from "src/modules/database/schema";
import { UserService } from "src/modules/user/user.service";
import { AuthErrorMessage } from "./auth.error";
import {
  normalizeEmail,
  normalizeOptionalEmail,
  normalizeOptionalUserName,
  normalizeSigninEmail,
  normalizeUserName,
  validatePassword,
} from "./auth-input";
import { AUTH_TOKEN_AUDIENCE, AUTH_TOKEN_ISSUER } from "./token-claims";
import {
  AuthRepository,
  KakaoPhoneVerificationTokenConsumeFailedError,
  PhoneVerificationTokenConsumeFailedError,
} from "./auth.repository";
import { KakaoLoginResult, KakaoProfile, SigninAuthInput, SignupAuthInput } from "./auth.types";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  async signup(input: SignupAuthInput, deviceId: string) {
    if (!input.termsAccepted) throw new CustomBadRequestException(AuthErrorMessage.TermsNotAccepted);
    const email = normalizeEmail(input.email);
    const userName = normalizeUserName(input.userName);
    const password = validatePassword(input.password);
    await this.findPhoneVerificationToken(input.phoneVerificationToken);

    const user = await this.mapDuplicateUserError(
      this.authRepository.signupWithPhoneVerificationToken(
        {
          ...input,
          email,
          userName,
          userId: uuidv4(),
          password: await bcrypt.hash(password, 10),
        },
        input.phoneVerificationToken,
      ),
    );
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);

    this.logger.log(JSON.stringify({ event: "auth_signup", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  async signin(input: SigninAuthInput, deviceId: string) {
    const email = normalizeSigninEmail(input.email);
    const password = input.password;
    let user = await this.authRepository.signin({ ...input, email, password });
    if (!user && email !== input.email) user = await this.authRepository.signin(input);
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const phoneVerificationToken = await this.findPhoneVerificationToken(input.phoneVerificationToken);
    if (user.phone !== phoneVerificationToken.phoneE164)
      throw new CustomUnauthorizedException(AuthErrorMessage.PhoneVerificationRequired);

    await this.consumePhoneVerificationToken(input.phoneVerificationToken);
    await this.userService.restoreIfWithinGrace(user.userId);
    this.logger.log(JSON.stringify({ event: "auth_signin", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  async loginWithKakao(profile: KakaoProfile): Promise<KakaoLoginResult> {
    const foundUser = await this.authRepository.findUserByIdentity("kakao", profile.providerUserId);
    this.logger.log(JSON.stringify({ event: "auth_kakao_login", result: "token_issued", existingUser: !!foundUser }));
    return { kakaoPhoneVerificationToken: await this.createKakaoPhoneVerificationToken(profile, foundUser?.userId) };
  }

  async loginWithKakaoAccessToken(accessToken: string, deviceId: string) {
    const profile = await this.getKakaoProfile(accessToken);
    const foundUser = await this.authRepository.findUserByIdentity("kakao", profile.providerUserId);

    if (foundUser?.phone) {
      await this.userService.restoreIfWithinGrace(foundUser.userId);
      return { requiresPhone: false as const, session: await this.issueTokens(foundUser, deviceId) };
    }

    return {
      requiresPhone: true as const,
      kakaoPhoneVerificationToken: await this.createKakaoPhoneVerificationToken(profile, foundUser?.userId),
      userName: foundUser?.userName || profile.userName || null,
    };
  }

  async completeKakaoPhoneSignup(
    input: {
      phoneVerificationToken: string;
      kakaoPhoneVerificationToken: string;
      userName: string;
      gender: Gender;
      termsAccepted: boolean;
    },
    deviceId: string,
  ) {
    if (!input.termsAccepted) throw new CustomBadRequestException(AuthErrorMessage.TermsNotAccepted);

    const [phoneVerificationToken, kakaoToken] = await Promise.all([
      this.findPhoneVerificationToken(input.phoneVerificationToken),
      this.authRepository.findKakaoPhoneVerificationToken(input.kakaoPhoneVerificationToken),
    ]);
    if (!kakaoToken) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidKakaoPhoneVerificationToken);

    if (kakaoToken.userId) {
      const user = await this.authRepository.findUser(kakaoToken.userId);
      if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidKakaoPhoneVerificationToken);
      if (user.phone && user.phone !== phoneVerificationToken.phoneE164)
        throw new CustomUnauthorizedException(AuthErrorMessage.PhoneVerificationRequired);

      const updatedUser = await this.mapDuplicateUserError(
        this.mapTokenConsumeError(
          this.authRepository.attachPhoneWithKakaoPhoneVerificationTokens({
            userId: user.userId,
            phone: phoneVerificationToken.phoneE164,
            phoneVerificationToken: input.phoneVerificationToken,
            kakaoPhoneVerificationToken: input.kakaoPhoneVerificationToken,
          }),
        ),
      );
      if (!updatedUser) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidKakaoPhoneVerificationToken);
      await this.userService.restoreIfWithinGrace(updatedUser.userId);
      return this.issueTokens(updatedUser, deviceId);
    }

    if (!input.gender) throw new CustomBadRequestException(AuthErrorMessage.InvalidGender);
    const email = normalizeEmail(
      kakaoToken.email ?? `kakao_${hashToken(kakaoToken.providerUserId).slice(0, 32)}@kakao.local`,
    );
    const userName = normalizeUserName(input.userName);

    const user = await this.mapDuplicateUserError(
      this.mapTokenConsumeError(
        this.authRepository.createKakaoPhoneUserWithTokens(
          {
            userId: uuidv4(),
            providerUserId: kakaoToken.providerUserId,
            email,
            userName,
            password: await bcrypt.hash(uuidv4(), 10),
            phone: phoneVerificationToken.phoneE164,
            gender: input.gender,
          },
          input,
        ),
      ),
    );

    return this.issueTokens(user, deviceId);
  }

  async refresh(validatedRefreshToken: RefreshToken) {
    const { userId, deviceId } = validatedRefreshToken;
    const user = await this.userService.findUser(userId);
    const accessToken = await this.createAccessToken(user);
    const nextRefreshToken = await this.createRefreshToken(user, deviceId);
    const nextRefreshState = await this.prepareRefreshToken(nextRefreshToken);
    const rotated = await this.authRepository.rotateRefreshToken({
      userId,
      deviceId,
      expectedRefreshToken: validatedRefreshToken.refreshToken,
      ...nextRefreshState,
    });
    if (!rotated) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    this.logger.log(JSON.stringify({ event: "auth_refresh", result: "success" }));
    return { accessToken, refreshToken: nextRefreshToken };
  }

  async logout(userId: string, deviceId: string) {
    await this.authRepository.deleteRefreshToken(userId, deviceId);
    this.logger.log(JSON.stringify({ event: "auth_logout", result: "success" }));
    return true;
  }

  async validateUserRefreshToken(userId: string, deviceId: string, refreshToken: string) {
    const savedToken = await this.authRepository.findRefreshToken(userId, deviceId);
    if (!savedToken) return undefined;
    if (savedToken.refreshTokenExp.getTime() <= Date.now()) return undefined;
    if (!(await bcrypt.compare(refreshToken, savedToken.refreshToken))) return undefined;

    return savedToken;
  }

  issueTokensForUser(user: User, deviceId: string) {
    return this.issueTokens(user, deviceId);
  }

  private async getKakaoProfile(accessToken: string): Promise<KakaoProfile> {
    if (!accessToken.trim()) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    let response: Response;
    try {
      response = await fetch("https://kapi.kakao.com/v2/user/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    }
    if (!response.ok) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    }
    if (typeof value !== "object" || value === null || !("id" in value)) {
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    }

    const providerUserId = value.id;
    if ((typeof providerUserId !== "string" && typeof providerUserId !== "number") || !String(providerUserId)) {
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    }

    const account =
      "kakao_account" in value && typeof value.kakao_account === "object" && value.kakao_account !== null
        ? value.kakao_account
        : undefined;
    const properties =
      "properties" in value && typeof value.properties === "object" && value.properties !== null
        ? value.properties
        : undefined;

    return {
      providerUserId: String(providerUserId),
      email: account && "email" in account && typeof account.email === "string" ? account.email : undefined,
      userName:
        properties && "nickname" in properties && typeof properties.nickname === "string"
          ? normalizeOptionalUserName(properties.nickname)
          : undefined,
    };
  }

  private async createKakaoPhoneVerificationToken(profile: KakaoProfile, userId?: string) {
    const token = await this.jwtService.signAsync(
      { provider: "kakao", providerUserId: profile.providerUserId },
      {
        secret: this.configService.getOrThrow<string>("KAKAO_SIGNUP_TOKEN_SECRET"),
        expiresIn: 15 * 60,
      },
    );

    await this.authRepository.createKakaoPhoneVerificationToken({
      token,
      userId,
      providerUserId: profile.providerUserId,
      email: normalizeOptionalEmail(profile.email),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    return token;
  }

  private async findPhoneVerificationToken(token: string) {
    const phoneVerificationToken = await this.authRepository.findPhoneVerificationToken(token);
    if (!phoneVerificationToken) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);

    return phoneVerificationToken;
  }

  private async consumePhoneVerificationToken(token: string) {
    if (!(await this.authRepository.consumePhoneVerificationToken(token))) {
      throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);
    }
  }

  private async mapTokenConsumeError<T>(operation: Promise<T>) {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof PhoneVerificationTokenConsumeFailedError) {
        throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);
      }
      if (error instanceof KakaoPhoneVerificationTokenConsumeFailedError) {
        throw new CustomUnauthorizedException(AuthErrorMessage.InvalidKakaoPhoneVerificationToken);
      }
      throw error;
    }
  }

  private async mapDuplicateUserError<T>(operation: Promise<T>) {
    try {
      return await operation;
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new CustomBadRequestException(AuthErrorMessage.DuplicateUser);
      throw error;
    }
  }

  private isUniqueViolation(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
  }

  private async issueTokens(user: User, deviceId: string) {
    const accessToken = await this.createAccessToken(user);
    const refreshToken = await this.createRefreshToken(user, deviceId);

    await this.saveRefreshToken(user.userId, deviceId, refreshToken);

    return { accessToken, refreshToken };
  }

  private createAccessToken(user: User) {
    return this.jwtService.signAsync(
      { userId: user.userId, tokenType: "access" },
      {
        audience: AUTH_TOKEN_AUDIENCE,
        issuer: AUTH_TOKEN_ISSUER,
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<number>("JWT_ACCESS_TOKEN_EXP"),
      },
    );
  }

  private createRefreshToken(user: User, deviceId: string) {
    return this.jwtService.signAsync(
      { userId: user.userId, deviceId, tokenType: "refresh" },
      {
        audience: AUTH_TOKEN_AUDIENCE,
        issuer: AUTH_TOKEN_ISSUER,
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<number>("JWT_REFRESH_TOKEN_EXP"),
      },
    );
  }

  private async saveRefreshToken(userId: string, deviceId: string, refreshToken: string) {
    await this.authRepository.saveRefreshToken({ userId, deviceId, ...(await this.prepareRefreshToken(refreshToken)) });
  }

  private async prepareRefreshToken(refreshToken: string) {
    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    if (!decoded?.exp) throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenExpUndefined);

    return {
      refreshToken: await bcrypt.hash(refreshToken, 10),
      refreshTokenExp: new Date(decoded.exp * 1000),
    };
  }
}
