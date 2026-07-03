import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { User } from "src/modules/database/schema";
import { UserService } from "src/modules/user/user.service";
import { AuthErrorMessage } from "./auth.error";
import { AuthRepository, KakaoPhoneVerificationTokenConsumeFailedError, PhoneVerificationTokenConsumeFailedError } from "./auth.repository";
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
    const user = await this.mapDuplicateUserError(
      this.authRepository.signupWithPhoneVerificationToken(
        {
          ...input,
          userId: uuidv4(),
          password: await bcrypt.hash(input.password, 10),
        },
        input.phoneVerificationToken,
      ),
    );
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);

    this.logger.log(JSON.stringify({ event: "auth_signup", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  async signin(input: SigninAuthInput, deviceId: string) {
    const user = await this.authRepository.signin(input);
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const isPasswordValid = await bcrypt.compare(input.password, user.password);
    if (!isPasswordValid) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const phoneVerificationToken = await this.findPhoneVerificationToken(input.phoneVerificationToken);
    if (user.phone !== phoneVerificationToken.phoneE164)
      throw new CustomUnauthorizedException(AuthErrorMessage.PhoneVerificationRequired);

    await this.consumePhoneVerificationToken(input.phoneVerificationToken);
    this.logger.log(JSON.stringify({ event: "auth_signin", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  async signed(email: string) {
    const user = await this.authRepository.signed(email);
    return { isSigned: !!user };
  }

  async loginWithKakao(profile: KakaoProfile): Promise<KakaoLoginResult> {
    const foundUser = await this.authRepository.findUserByIdentity("kakao", profile.providerUserId);
    this.logger.log(JSON.stringify({ event: "auth_kakao_login", result: "token_issued", existingUser: !!foundUser }));
    return { kakaoPhoneVerificationToken: await this.createKakaoPhoneVerificationToken(profile, foundUser?.userId) };
  }

  async completeKakaoPhoneSignup(input: { phoneVerificationToken: string; kakaoPhoneVerificationToken: string }, deviceId: string) {
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
      return this.issueTokens(updatedUser, deviceId);
    }

    const user = await this.mapDuplicateUserError(
      this.mapTokenConsumeError(
        this.authRepository.createKakaoPhoneUserWithTokens(
          {
            userId: uuidv4(),
            providerUserId: kakaoToken.providerUserId,
            email: kakaoToken.email ?? `kakao_${kakaoToken.providerUserId}@kakao.local`,
            password: await bcrypt.hash(uuidv4(), 10),
            phone: phoneVerificationToken.phoneE164,
          },
          input,
        ),
      ),
    );

    return this.issueTokens(user, deviceId);
  }

  async refresh(userId: string, deviceId: string, refreshToken: string) {
    const result = await this.compareUserRefreshToken(userId, deviceId, refreshToken);
    if (!result) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const user = await this.userService.findUser(userId);
    this.logger.log(JSON.stringify({ event: "auth_refresh", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  async logout(userId: string, deviceId: string) {
    await this.authRepository.deleteRefreshToken(userId, deviceId);
    this.logger.log(JSON.stringify({ event: "auth_logout", result: "success" }));
    return true;
  }

  async compareUserRefreshToken(userId: string, deviceId: string, refreshToken: string) {
    const savedToken = await this.authRepository.findRefreshToken(userId, deviceId);
    if (!savedToken) return false;
    if (savedToken.refreshTokenExp.getTime() <= Date.now()) return false;

    return bcrypt.compare(refreshToken, savedToken.refreshToken);
  }

  issueTokensForUser(user: User, deviceId: string) {
    return this.issueTokens(user, deviceId);
  }

  private async createKakaoPhoneVerificationToken(profile: KakaoProfile, userId?: string) {
    const token = await this.jwtService.signAsync(
      { provider: "kakao", providerUserId: profile.providerUserId },
      {
        secret: this.configService.getOrThrow<string>("KAKAO_SIGNUP_TOKEN_SECRET"),
        expiresIn: "15m" as JwtSignOptions["expiresIn"],
      },
    );

    await this.authRepository.createKakaoPhoneVerificationToken({
      token,
      userId,
      providerUserId: profile.providerUserId,
      email: profile.email,
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
      { userId: user.userId },
      {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_EXP") as JwtSignOptions["expiresIn"],
      },
    );
  }

  private createRefreshToken(user: User, deviceId: string) {
    return this.jwtService.signAsync(
      { userId: user.userId, deviceId },
      {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_EXP") as JwtSignOptions["expiresIn"],
      },
    );
  }

  private async saveRefreshToken(userId: string, deviceId: string, refreshToken: string) {
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    if (!decoded?.exp) throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenExpUndefined);

    await this.authRepository.saveRefreshToken({
      userId,
      deviceId,
      refreshToken: hashedRefreshToken,
      refreshTokenExp: new Date(decoded.exp * 1000),
    });
  }
}
