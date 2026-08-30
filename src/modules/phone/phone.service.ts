import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomInt, randomUUID } from "crypto";
import {
  CustomBadRequestException,
  CustomServiceUnavailableException,
  CustomTooManyRequestsException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { validatePassword } from "src/modules/auth/auth-input";
import { AuthService } from "src/modules/auth/auth.service";
import { isGender } from "src/modules/database/schema";
import { PhoneErrorMessage } from "./phone.error";
import { PhoneRepository } from "./phone.repository";
import {
  CompleteKakaoPhoneSignupInput,
  CompletePhoneSignupInput,
  RequestPhoneCodeInput,
  ResetPasswordWithPhoneInput,
  VerifyPhoneCodeInput,
} from "./phone.types";
import { PhoneVerificationPurpose } from "./phone.types";
import { SmsSender } from "./sms.sender";

const reservationErrors = {
  retry_too_soon: PhoneErrorMessage.PhoneCodeRetryTooSoon,
  phone_limit: PhoneErrorMessage.PhoneRequestLimitExceeded,
  ip_limit: PhoneErrorMessage.IpRequestLimitExceeded,
} as const;

@Injectable()
export class PhoneService {
  private readonly logger = new Logger(PhoneService.name);

  constructor(
    private readonly phoneRepository: PhoneRepository,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject("SmsSender")
    private readonly smsSender: SmsSender,
  ) {}

  requestPhoneCode = async (input: RequestPhoneCodeInput, ip?: string, userAgent?: string) => {
    if (!Object.values(PhoneVerificationPurpose).includes(input.purpose)) {
      throw new CustomBadRequestException(PhoneErrorMessage.InvalidPhonePurpose);
    }

    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const requestIpHash = this.sha256(ip || "no-ip");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const reservation = await this.phoneRepository.reserveVerification({
      phoneE164,
      purpose: input.purpose,
      requestIpHash,
      userAgentHash: this.sha256(userAgent ?? ""),
      cooldownMs: 60_000,
      phoneLimit: 5,
      ipLimit: 20,
    });
    if (reservation.status !== "reserved") {
      throw new CustomTooManyRequestsException(reservationErrors[reservation.status]);
    }
    const verification = reservation.verification;

    try {
      const codeHash = await bcrypt.hash(this.pepperedCode(phoneE164, code), 10);
      await this.smsSender.sendCode(phoneE164, code);
      const activated = await this.phoneRepository.activateVerification(verification.id, codeHash, 5 * 60_000);
      if (!activated) throw new Error("PHONE_VERIFICATION_ACTIVATION_FAILED");
    } catch {
      try {
        await this.phoneRepository.deleteVerification(verification.id);
      } catch {
        this.logger.error(
          JSON.stringify({ event: "phone_code_request_cleanup", purpose: input.purpose, result: "failed" }),
        );
      }
      this.logger.warn(JSON.stringify({ event: "phone_code_request", purpose: input.purpose, result: "failed" }));
      throw new CustomServiceUnavailableException(PhoneErrorMessage.SmsSendFailed);
    }
    this.logger.log(JSON.stringify({ event: "phone_code_request", purpose: input.purpose, result: "success" }));
    return { ok: true };
  };

  async verifyPhoneCode(input: VerifyPhoneCodeInput, deviceId: string) {
    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const verification = await this.getUsableVerification(phoneE164);
    if (verification.purpose !== "signup" && verification.purpose !== "login") {
      throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    }

    const claimed = await this.phoneRepository.claimVerificationAttempt({
      id: verification.id,
      phoneE164,
      purposes: ["signup", "login"],
    });
    if (!claimed) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    const valid = await bcrypt.compare(this.pepperedCode(phoneE164, input.code), claimed.codeHash);
    if (!valid) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);

    const verified = await this.phoneRepository.markVerified(claimed.id);
    if (!verified) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    const user = await this.phoneRepository.findUserByPhone(phoneE164);
    if (user) {
      return { existingUser: true, tokenPayload: await this.authService.issueTokensForUser(user, deviceId) };
    }

    const phoneVerificationToken = await this.createPhoneVerificationToken(phoneE164, verified.id);
    return { existingUser: false, phoneVerificationToken };
  }

  async completePhoneSignup(input: CompletePhoneSignupInput, deviceId: string) {
    const gender = input.gender?.trim() ?? "";
    if (!isGender(gender)) throw new CustomBadRequestException(PhoneErrorMessage.InvalidGender);

    return this.authService.signup(
      {
        email: input.email,
        password: input.password,
        userName: input.userName?.trim() || input.email.split("@")[0] || "user",
        gender,
        phoneVerificationToken: input.phoneVerificationToken,
        termsAccepted: input.termsAccepted,
      },
      deviceId,
    );
  }

  async completeKakaoPhoneSignup(input: CompleteKakaoPhoneSignupInput, deviceId: string) {
    const gender = input.gender?.trim() ?? "";
    if (!isGender(gender)) throw new CustomBadRequestException(PhoneErrorMessage.InvalidGender);

    return this.authService.completeKakaoPhoneSignup(
      {
        phoneVerificationToken: input.phoneVerificationToken,
        kakaoPhoneVerificationToken: input.kakaoPhoneVerificationToken,
        userName: input.userName,
        gender,
        termsAccepted: input.termsAccepted,
      },
      deviceId,
    );
  }

  async resetPasswordWithPhone(input: ResetPasswordWithPhoneInput) {
    const nextPassword = validatePassword(input.password);
    const phoneE164 = this.normalizeKoreanPhone(input.phone);
    const verification = await this.getUsableVerification(phoneE164, "password_reset");

    const claimed = await this.phoneRepository.claimVerificationAttempt({
      id: verification.id,
      phoneE164,
      purposes: ["password_reset"],
    });
    if (!claimed) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);
    const valid = await bcrypt.compare(this.pepperedCode(phoneE164, input.code), claimed.codeHash);
    if (!valid) throw new CustomUnauthorizedException(PhoneErrorMessage.InvalidPhoneCode);

    const password = await bcrypt.hash(nextPassword, 10);
    const user = await this.phoneRepository.resetPasswordWithVerification({
      verificationId: claimed.id,
      phoneE164,
      password,
    });
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
    if (verification.attemptCount >= 5)
      throw new CustomTooManyRequestsException(PhoneErrorMessage.PhoneCodeAttemptLimitExceeded);

    return verification;
  }

  private async createPhoneVerificationToken(phoneE164: string, verificationId: string) {
    const token = await this.jwtService.signAsync(
      { phoneE164, verificationId, nonce: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>("SIGNUP_TOKEN_SECRET"),
        expiresIn: 15 * 60,
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
