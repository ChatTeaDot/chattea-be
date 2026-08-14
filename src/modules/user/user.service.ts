import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import {
  CustomBadRequestException,
  CustomNotFoundException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { isInterestedGender } from "src/modules/database/schema";
import { UserErrorMessage } from "./user.error";
import { UserRepository } from "./user.repository";
import {
  AccountDeletionPayload,
  CurrentSubscriptionPayload,
  UpdateEmailRepositoryInput,
  UpdatePasswordRepositoryInput,
  UpdateUserProfileInput,
} from "./user.types";

const PROFILE_INTRO_MAX_LENGTH = 60;
const PROFILE_PHOTO_MIN_COUNT = 1;
const PROFILE_PHOTO_MAX_COUNT = 3;
const DELETION_GRACE_DAYS = 14;
const DELETION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const KOREAN_REGIONS = [
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "세종",
  "경기",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
] as const;

@Injectable()
export class UserService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly userRepository: UserRepository) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupDueDeletedAccounts().catch(() => undefined);
    }, DELETION_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async findUser(userId: string) {
    const user = await this.userRepository.findUser(userId);
    if (!user) throw new CustomNotFoundException(UserErrorMessage.InvalidUserId);
    return user;
  }

  async profile(userId: string) {
    validateUuid(userId);
    const user = await this.userRepository.findUserProfile(userId);
    if (!user) throw new CustomNotFoundException(UserErrorMessage.InvalidUserId);
    return user;
  }

  async currentSubscription(userId: string): Promise<CurrentSubscriptionPayload> {
    validateUuid(userId);
    return { planId: (await this.userRepository.findCurrentSubscription(userId))?.planId ?? "free" };
  }

  async updateEmail(input: UpdateEmailRepositoryInput) {
    await this.assertVerifiedPhoneToken(input.userId, input.phoneVerificationToken);
    return this.userRepository.updateEmail(input);
  }

  async updatePassword(input: UpdatePasswordRepositoryInput) {
    await this.assertVerifiedPhoneToken(input.userId, input.phoneVerificationToken);
    const password = await bcrypt.hash(input.password, 10);
    return this.userRepository.updatePassword({ ...input, password });
  }

  async updateProfile(userId: string, input: UpdateUserProfileInput) {
    validateUuid(userId);
    await this.findUser(userId);
    const profile = validateProfileInput(input);
    return this.userRepository.replaceProfile({ userId, ...profile });
  }

  async beginAccountDeletion(userId: string, now = new Date()): Promise<AccountDeletionPayload> {
    validateUuid(userId);
    await this.findUser(userId);
    const scheduledFor = new Date(now);
    scheduledFor.setUTCDate(scheduledFor.getUTCDate() + DELETION_GRACE_DAYS);
    await this.userRepository.scheduleDeletion(userId, scheduledFor);
    return { hidden: true, scheduledFor: scheduledFor.toISOString() };
  }

  async restoreIfWithinGrace(userId: string): Promise<boolean> {
    validateUuid(userId);
    return this.userRepository.restoreScheduledDeletion(userId);
  }

  async cleanupDueDeletedAccounts(now = new Date()): Promise<number> {
    const users = await this.userRepository.findDueDeletionUserIds(now);
    await Promise.all(users.map(({ userId }) => this.userRepository.anonymizeDeletedAccount(userId)));
    return users.length;
  }

  private async assertVerifiedPhoneToken(userId: string, phoneVerificationToken: string) {
    const [user, token] = await Promise.all([
      this.userRepository.findUser(userId),
      this.userRepository.findPhoneVerificationToken(phoneVerificationToken),
    ]);
    if (!token || token.expiresAt.getTime() <= Date.now()) {
      throw new CustomUnauthorizedException(UserErrorMessage.InvalidPhoneVerificationToken);
    }
    if (!user?.phone || user.phone !== token.phoneE164) {
      throw new CustomUnauthorizedException(UserErrorMessage.PhoneVerificationRequired);
    }
    if (!(await this.userRepository.consumePhoneVerificationToken(phoneVerificationToken))) {
      throw new CustomUnauthorizedException(UserErrorMessage.InvalidPhoneVerificationToken);
    }
  }
}

const validateProfileInput = (input: UpdateUserProfileInput) => {
  const userName = validateRequiredText(input.userName, 40, "PROFILE_NAME");
  const intro = input.intro.trim();
  if (intro.length > PROFILE_INTRO_MAX_LENGTH) throw new CustomBadRequestException("PROFILE_INTRO_TOO_LONG");
  const birthDate = validateBirthDate(input.birthDate);
  const region = input.region.trim();
  if (!KOREAN_REGIONS.includes(region as (typeof KOREAN_REGIONS)[number])) {
    throw new CustomBadRequestException("PROFILE_REGION_INVALID");
  }
  const interestedGender = input.interestedGender.trim();
  if (!isInterestedGender(interestedGender)) {
    throw new CustomBadRequestException("PROFILE_INTERESTED_GENDER_INVALID");
  }
  const photoUrls = input.photoUrls.map((url) => url.trim()).filter(Boolean);
  if (photoUrls.length < PROFILE_PHOTO_MIN_COUNT || photoUrls.length > PROFILE_PHOTO_MAX_COUNT) {
    throw new CustomBadRequestException("PROFILE_PHOTO_COUNT_INVALID");
  }
  if (new Set(photoUrls).size !== photoUrls.length || photoUrls.some((url) => !isHttpUrl(url))) {
    throw new CustomBadRequestException("PROFILE_PHOTO_URL_INVALID");
  }

  return { userName, birthDate, region, interestedGender, intro, photoUrls };
};

const validateRequiredText = (input: string, maxLength: number, field: string): string => {
  const value = input.trim();
  if (!value) throw new CustomBadRequestException(`${field}_REQUIRED`);
  if (value.length > maxLength) throw new CustomBadRequestException(`${field}_TOO_LONG`);
  return value;
};

const validateBirthDate = (input: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new CustomBadRequestException("PROFILE_BIRTH_DATE_INVALID");
  }
  const birthDate = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== input) {
    throw new CustomBadRequestException("PROFILE_BIRTH_DATE_INVALID");
  }
  const today = new Date();
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birthDate.getUTCDate())) age -= 1;
  if (age < 18) throw new CustomBadRequestException("PROFILE_AGE_REQUIRED");
  return input;
};

const isHttpUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  } catch {
    return false;
  }
};

const validateUuid = (input: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new CustomBadRequestException("USER_ID_INVALID");
  }
};
