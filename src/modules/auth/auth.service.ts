import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { Gender, User } from "src/modules/database/schema";
import { UserService } from "src/modules/user/user.service";
import { AuthErrorMessage } from "./auth.error";
import {
  AuthRepository,
  KakaoPhoneVerificationTokenConsumeFailedError,
  PhoneVerificationTokenConsumeFailedError,
} from "./auth.repository";
import { KakaoLoginResult, KakaoProfile, SigninAuthInput, SignupAuthInput } from "./auth.types";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * AuthService에서 사용할 인증 의존성을 주입한다.
   *
   * @param authRepository 인증 저장소
   * @param jwtService JWT 서비스
   * @param configService 환경 설정 서비스
   * @param userService 사용자 서비스
   */
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  /**
   * 전화번호 인증 토큰으로 신규 사용자를 가입시키고 토큰을 발급한다.
   *
   * @param input 가입 입력값
   * @param deviceId 기기 ID
   * @returns 인증 토큰
   */
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

  /**
   * 이메일/비밀번호와 전화번호 인증 토큰으로 로그인한다.
   *
   * @param input 로그인 입력값
   * @param deviceId 기기 ID
   * @returns 인증 토큰
   */
  async signin(input: SigninAuthInput, deviceId: string) {
    const user = await this.authRepository.signin(input);
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const isPasswordValid = await bcrypt.compare(input.password, user.password);
    if (!isPasswordValid) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const phoneVerificationToken = await this.findPhoneVerificationToken(input.phoneVerificationToken);
    if (user.phone !== phoneVerificationToken.phoneE164)
      throw new CustomUnauthorizedException(AuthErrorMessage.PhoneVerificationRequired);

    await this.consumePhoneVerificationToken(input.phoneVerificationToken);
    await this.userService.restoreIfWithinGrace(user.userId);
    this.logger.log(JSON.stringify({ event: "auth_signin", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  /**
   * 이메일 가입 여부를 조회한다.
   *
   * @param email 이메일
   * @returns 가입 여부
   */
  async signed(email: string) {
    const user = await this.authRepository.signed(email);
    return { isSigned: !!user };
  }

  /**
   * 카카오 프로필로 전화번호 가입 토큰을 발급한다.
   *
   * @param profile 카카오 프로필
   * @returns 카카오 로그인 결과
   */
  async loginWithKakao(profile: KakaoProfile): Promise<KakaoLoginResult> {
    const foundUser = await this.authRepository.findUserByIdentity("kakao", profile.providerUserId);
    this.logger.log(JSON.stringify({ event: "auth_kakao_login", result: "token_issued", existingUser: !!foundUser }));
    return { kakaoPhoneVerificationToken: await this.createKakaoPhoneVerificationToken(profile, foundUser?.userId) };
  }

  /**
   * 카카오 전화번호 가입을 완료하고 인증 토큰을 발급한다.
   *
   * @param input 전화번호 인증 토큰과 카카오 전화번호 인증 토큰
   * @param deviceId 기기 ID
   * @returns 인증 토큰
   */
  async completeKakaoPhoneSignup(
    input: { phoneVerificationToken: string; kakaoPhoneVerificationToken: string; gender?: Gender },
    deviceId: string,
  ) {
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

    const user = await this.mapDuplicateUserError(
      this.mapTokenConsumeError(
        this.authRepository.createKakaoPhoneUserWithTokens(
          {
            userId: uuidv4(),
            providerUserId: kakaoToken.providerUserId,
            email: kakaoToken.email ?? `kakao_${kakaoToken.providerUserId}@kakao.local`,
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

  /**
   * refresh token으로 인증 토큰을 재발급한다.
   *
   * @param userId 사용자 ID
   * @param deviceId 기기 ID
   * @param refreshToken refresh token
   * @returns 인증 토큰
   */
  async refresh(userId: string, deviceId: string, refreshToken: string) {
    const result = await this.compareUserRefreshToken(userId, deviceId, refreshToken);
    if (!result) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);

    const user = await this.userService.findUser(userId);
    this.logger.log(JSON.stringify({ event: "auth_refresh", result: "success" }));
    return this.issueTokens(user, deviceId);
  }

  /**
   * 현재 기기의 refresh token을 삭제한다.
   *
   * @param userId 사용자 ID
   * @param deviceId 기기 ID
   * @returns 로그아웃 성공 여부
   */
  async logout(userId: string, deviceId: string) {
    await this.authRepository.deleteRefreshToken(userId, deviceId);
    this.logger.log(JSON.stringify({ event: "auth_logout", result: "success" }));
    return true;
  }

  /**
   * 저장된 refresh token과 입력 refresh token을 비교한다.
   *
   * @param userId 사용자 ID
   * @param deviceId 기기 ID
   * @param refreshToken refresh token
   * @returns refresh token 유효 여부
   */
  async compareUserRefreshToken(userId: string, deviceId: string, refreshToken: string) {
    const savedToken = await this.authRepository.findRefreshToken(userId, deviceId);
    if (!savedToken) return false;
    if (savedToken.refreshTokenExp.getTime() <= Date.now()) return false;

    return bcrypt.compare(refreshToken, savedToken.refreshToken);
  }

  /**
   * 사용자에게 인증 토큰을 발급한다.
   *
   * @param user 사용자
   * @param deviceId 기기 ID
   * @returns 인증 토큰
   */
  issueTokensForUser(user: User, deviceId: string) {
    return this.issueTokens(user, deviceId);
  }

  /**
   * 카카오 전화번호 가입 토큰을 생성하고 저장한다.
   *
   * @param profile 카카오 프로필
   * @param userId 기존 사용자 ID
   * @returns 카카오 전화번호 인증 토큰
   */
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

  /**
   * 전화번호 인증 토큰을 조회하고 없으면 예외를 던진다.
   *
   * @param token 전화번호 인증 토큰
   * @returns 전화번호 인증 토큰 레코드
   */
  private async findPhoneVerificationToken(token: string) {
    const phoneVerificationToken = await this.authRepository.findPhoneVerificationToken(token);
    if (!phoneVerificationToken) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);

    return phoneVerificationToken;
  }

  /**
   * 전화번호 인증 토큰을 사용 처리한다.
   *
   * @param token 전화번호 인증 토큰
   */
  private async consumePhoneVerificationToken(token: string) {
    if (!(await this.authRepository.consumePhoneVerificationToken(token))) {
      throw new CustomUnauthorizedException(AuthErrorMessage.InvalidPhoneVerificationToken);
    }
  }

  /**
   * 인증 토큰 사용 실패를 인증 예외로 변환한다.
   *
   * @param operation 실행할 저장소 작업
   * @returns 작업 결과
   */
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

  /**
   * 중복 사용자 저장소 에러를 요청 예외로 변환한다.
   *
   * @param operation 실행할 저장소 작업
   * @returns 작업 결과
   */
  private async mapDuplicateUserError<T>(operation: Promise<T>) {
    try {
      return await operation;
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new CustomBadRequestException(AuthErrorMessage.DuplicateUser);
      throw error;
    }
  }

  /**
   * PostgreSQL unique violation 여부를 확인한다.
   *
   * @param error 확인할 에러
   * @returns unique violation 여부
   */
  private isUniqueViolation(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
  }

  /**
   * access token과 refresh token을 발급하고 refresh token을 저장한다.
   *
   * @param user 사용자
   * @param deviceId 기기 ID
   * @returns 인증 토큰
   */
  private async issueTokens(user: User, deviceId: string) {
    const accessToken = await this.createAccessToken(user);
    const refreshToken = await this.createRefreshToken(user, deviceId);

    await this.saveRefreshToken(user.userId, deviceId, refreshToken);

    return { accessToken, refreshToken };
  }

  /**
   * access token을 생성한다.
   *
   * @param user 사용자
   * @returns access token
   */
  private createAccessToken(user: User) {
    return this.jwtService.signAsync(
      { userId: user.userId },
      {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_EXP") as JwtSignOptions["expiresIn"],
      },
    );
  }

  /**
   * refresh token을 생성한다.
   *
   * @param user 사용자
   * @param deviceId 기기 ID
   * @returns refresh token
   */
  private createRefreshToken(user: User, deviceId: string) {
    return this.jwtService.signAsync(
      { userId: user.userId, deviceId },
      {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_EXP") as JwtSignOptions["expiresIn"],
      },
    );
  }

  /**
   * refresh token을 해시해서 저장한다.
   *
   * @param userId 사용자 ID
   * @param deviceId 기기 ID
   * @param refreshToken refresh token
   */
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
