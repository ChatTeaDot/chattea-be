import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomInt, randomUUID } from "crypto";
import {
  CustomBadRequestException,
  CustomServiceUnavailableException,
  CustomTooManyRequestsException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { AuthService } from "src/modules/auth/auth.service";
import { PhoneErrorMessage } from "./phone.error";
import { PhoneRepository } from "./phone.repository";
import {
  AttachPhoneToMeInput,
  CompleteKakaoPhoneSignupInput,
  CompletePhoneSignupInput,
  RequestPhoneCodeInput,
  ResetPasswordWithPhoneInput,
  VerifyPhoneCodeInput,
} from "./phone.types";
import { PhoneVerificationPurpose } from "./phone.types";
import { SmsSender } from "./sms.sender";

@Injectable()
export class PhoneService {
  private readonly logger = new Logger(PhoneService.name);

  /**
   * PhoneService에서 사용할 인증/저장소/SMS 의존성을 주입한다.
   *
   * @param phoneRepository 전화번호 저장소
   * @param authService 인증 서비스
   * @param configService 환경 설정 서비스
   * @param jwtService JWT 서비스
   * @param smsSender SMS 발송기
   */
  constructor(
    private readonly phoneRepository: PhoneRepository,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject("SmsSender")
    private readonly smsSender: SmsSender,
  ) {}

  /**
   * 전화번호 인증 코드를 생성하고 발송 요청을 기록한다.
   *
   * @param input 인증 코드 요청 입력값
   * @param ip 요청 IP
   * @param userAgent 요청 User-Agent
   * @returns 요청 성공 여부
   * @throws {CustomBadRequestException} 전화번호 형식이 올바르지 않을 때
   * @throws {CustomTooManyRequestsException} 요청 제한을 초과했을 때
   */
  async requestPhoneCode(input: RequestPhoneCodeInput, ip?: string, userAgent?: string) {
    if (!Object.values(PhoneVerificationPurpose).includes(input.purpose)) {
      throw new CustomBadRequestException(PhoneErrorMessage.InvalidPhonePurpose);
    }

    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const now = new Date();
    const latest = await this.phoneRepository.latestVerification(phoneE164);
    if (latest && now.getTime() - latest.createdAt.getTime() < 60_000) {
      throw new CustomTooManyRequestsException(PhoneErrorMessage.PhoneCodeRetryTooSoon);
    }

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const requestIpHash = this.sha256(ip || `no-ip:${userAgent ?? "unknown"}`);
    const [phoneRequests, ipRequests] = await Promise.all([
      this.phoneRepository.verificationsSinceByPhone(phoneE164, input.purpose, hourAgo),
      this.phoneRepository.verificationsSinceByIp(requestIpHash, input.purpose, hourAgo),
    ]);

    if (phoneRequests.length >= 5)
      throw new CustomTooManyRequestsException(PhoneErrorMessage.PhoneRequestLimitExceeded);
    if (ipRequests.length >= 20) throw new CustomTooManyRequestsException(PhoneErrorMessage.IpRequestLimitExceeded);

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const verification = await this.phoneRepository.createVerification({
      phoneE164,
      codeHash: await bcrypt.hash(this.pepperedCode(phoneE164, code), 10),
      purpose: input.purpose,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      requestIpHash,
      userAgentHash: this.sha256(userAgent ?? ""),
    });

    try {
      await this.smsSender.sendCode(phoneE164, code);
    } catch {
      try {
        await this.phoneRepository.deleteVerification(verification.id);
      } catch {
        this.logger.error(
          JSON.stringify({ event: "phone_code_request_cleanup", purpose: input.purpose, result: "failed" }),
        );
      }
      this.logger.warn(JSON.stringify({ event: "phone_code_request", purpose: input.purpose, result: "sms_failed" }));
      throw new CustomServiceUnavailableException(PhoneErrorMessage.SmsSendFailed);
    }
    this.logger.log(JSON.stringify({ event: "phone_code_request", purpose: input.purpose, result: "success" }));
    return { ok: true };
  }

  /**
   * 전화번호 인증 코드를 검증하고 기존 사용자 토큰 또는 phoneVerificationToken을 반환한다.
   *
   * @param input 인증 코드 검증 입력값
   * @param deviceId 기기 ID
   * @returns 기존 사용자 토큰 또는 신규 가입용 phoneVerificationToken
   * @throws {CustomUnauthorizedException} 인증 코드가 유효하지 않을 때
   * @throws {CustomTooManyRequestsException} 인증 시도 제한을 초과했을 때
   */
  async verifyPhoneCode(input: VerifyPhoneCodeInput, deviceId: string) {
    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const verification = await this.getUsableVerification(phoneE164);

    const valid = await bcrypt.compare(this.pepperedCode(phoneE164, input.code), verification.codeHash);
    if (!valid) {
      await this.phoneRepository.incrementAttempt(verification.id);
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    }

    const verified = await this.phoneRepository.markVerified(verification.id);
    if (!verified) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    const user = await this.phoneRepository.findUserByPhone(phoneE164);
    if (user) {
      return { existingUser: true, tokenPayload: await this.authService.issueTokensForUser(user, deviceId) };
    }

    const phoneVerificationToken = await this.createPhoneVerificationToken(phoneE164, verified.id);
    return { existingUser: false, phoneVerificationToken };
  }

  async completePhoneSignup(input: CompletePhoneSignupInput, deviceId: string) {
    return this.authService.signup(
      {
        email: input.email,
        password: input.password,
        userName: input.userName?.trim() || input.email.split("@")[0] || "user",
        phoneVerificationToken: input.phoneVerificationToken,
      },
      deviceId,
    );
  }

  async completeKakaoPhoneSignup(input: CompleteKakaoPhoneSignupInput, deviceId: string) {
    return this.authService.completeKakaoPhoneSignup(
      {
        phoneVerificationToken: input.phoneVerificationToken,
        kakaoPhoneVerificationToken: input.kakaoPhoneVerificationToken,
      },
      deviceId,
    );
  }

  /**
   * 현재 사용자에게 인증된 전화번호를 연결한다.
   *
   * @param userId 현재 사용자 ID
   * @param input 전화번호 연결 입력값
   * @returns 연결 성공 여부
   * @throws {CustomUnauthorizedException} 인증 코드가 유효하지 않을 때
   * @throws {CustomTooManyRequestsException} 인증 시도 제한을 초과했을 때
   */
  async attachPhoneToMe(userId: string, input: AttachPhoneToMeInput) {
    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const verification = await this.getUsableVerification(phoneE164);

    const valid = await bcrypt.compare(this.pepperedCode(phoneE164, input.code), verification.codeHash);
    if (!valid) {
      await this.phoneRepository.incrementAttempt(verification.id);
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    }

    const verified = await this.phoneRepository.markVerified(verification.id);
    if (!verified) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    await this.phoneRepository.attachPhone(userId, phoneE164);
    return true;
  }

  /**
   * 전화번호 인증 코드로 비밀번호를 재설정한다.
   *
   * @param input 비밀번호 재설정 입력값
   * @returns 재설정 성공 여부
   * @throws {CustomUnauthorizedException} 인증 코드나 전화번호가 유효하지 않을 때
   * @throws {CustomTooManyRequestsException} 인증 시도 제한을 초과했을 때
   */
  async resetPasswordWithPhone(input: ResetPasswordWithPhoneInput) {
    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const verification = await this.getUsableVerification(phoneE164, "password_reset");

    const valid = await bcrypt.compare(this.pepperedCode(phoneE164, input.code), verification.codeHash);
    if (!valid) {
      await this.phoneRepository.incrementAttempt(verification.id);
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    }

    const verified = await this.phoneRepository.markVerified(verification.id);
    if (!verified) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);

    const password = await bcrypt.hash(input.password, 10);
    const user = await this.phoneRepository.updatePasswordByPhone(phoneE164, password);
    if (!user) throw new CustomUnauthorizedException(PhoneErrorMessage.PhoneVerificationRequired);

    return true;
  }

  private normalizeKoreanPhone(phone: string) {
    const digits = phone.replace(/\D/g, "");
    if (digits.startsWith("010") && digits.length === 11) return `+82${digits.slice(1)}`;
    if (digits.startsWith("8210") && digits.length === 12) return `+${digits}`;
    throw new CustomBadRequestException(PhoneErrorMessage.KoreanPhoneOnly);
  }

  private pepperedCode(phoneE164: string, code: string) {
    return `${phoneE164}:${code}:${this.configService.getOrThrow<string>("PHONE_CODE_PEPPER")}`;
  }

  private sha256(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private async getUsableVerification(phoneE164: string, purpose?: string) {
    const verification = await this.phoneRepository.latestVerification(phoneE164);
    if (!verification || verification.verifiedAt)
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    if (purpose && verification.purpose !== purpose)
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    if (verification.expiresAt.getTime() <= Date.now())
      throw new CustomUnauthorizedException(PhoneErrorMessage.ExpiredPhoneCode);
    if (verification.attemptCount >= 5)
      throw new CustomTooManyRequestsException(PhoneErrorMessage.PhoneCodeAttemptLimitExceeded);

    return verification;
  }

  private async createPhoneVerificationToken(phoneE164: string, verificationId: string) {
    const token = await this.jwtService.signAsync(
      { phoneE164, verificationId, nonce: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>("SIGNUP_TOKEN_SECRET"),
        expiresIn: "15m" as JwtSignOptions["expiresIn"],
      },
    );

    await this.phoneRepository.createPhoneVerificationToken({
      token,
      phoneE164,
      verificationId,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    return token;
  }
}
