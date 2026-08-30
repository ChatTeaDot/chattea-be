import { Injectable } from "@nestjs/common";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { isInterestedGender } from "src/modules/database/schema";
import { validate as isUuid } from "uuid";
import { UserErrorMessage } from "./user.error";
import { UserRepository } from "./user.repository";
import { AccountDeletionPayload, CurrentSubscriptionPayload, UpdateUserProfileInput } from "./user.types";

const PROFILE_INTRO_MAX_LENGTH = 60;
const PROFILE_PHOTO_MIN_COUNT = 1;
const PROFILE_PHOTO_MAX_COUNT = 3;
const DELETION_GRACE_DAYS = 14;
const DELETION_LEASE_MS = 5 * 60 * 1000;

export type AccountDeletionBatchResult = Readonly<{
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  hasMore: boolean;
}>;

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
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  findUser = async (userId: string) => {
    const user = await this.userRepository.findUser(userId);
    if (!user) throw new CustomNotFoundException(UserErrorMessage.InvalidUserId);
    return user;
  };

  profile = async (userId: string) => {
    validateUuid(userId);
    const user = await this.userRepository.findUserProfile(userId);
    if (!user) throw new CustomNotFoundException(UserErrorMessage.InvalidUserId);
    return user;
  };

  currentSubscription = async (userId: string): Promise<CurrentSubscriptionPayload> => {
    validateUuid(userId);
    return { planId: (await this.userRepository.findCurrentSubscription(userId))?.planId ?? "free" };
  };

  updateProfile = async (userId: string, input: UpdateUserProfileInput) => {
    validateUuid(userId);
    await this.findUser(userId);
    const profile = validateProfileInput(input);
    return this.userRepository.replaceProfile({ userId, ...profile });
  };

  beginAccountDeletion = async (userId: string, now = new Date()): Promise<AccountDeletionPayload> => {
    validateUuid(userId);
    await this.findUser(userId);
    const scheduledFor = new Date(now);
    scheduledFor.setUTCDate(scheduledFor.getUTCDate() + DELETION_GRACE_DAYS);
    const deadline = await this.userRepository.scheduleDeletion(userId, scheduledFor);
    return { hidden: true, scheduledFor: deadline.toISOString() };
  };

  restoreIfWithinGrace = async (userId: string): Promise<boolean> => {
    validateUuid(userId);
    return this.userRepository.restoreScheduledDeletion(userId);
  };

  processDueAccountDeletionBatch = async (input: { now: Date; limit: number }): Promise<AccountDeletionBatchResult> => {
    const limit = validateBatchLimit(input.limit);
    const claimed = await this.userRepository.claimDueDeletionBatch({
      now: input.now,
      limit,
      leaseExpiresAt: new Date(input.now.getTime() + DELETION_LEASE_MS),
    });
    const settledOutcomes = await Promise.allSettled(
      claimed.jobs.map(async (job) => {
        try {
          await this.userRepository.anonymizeDeletedAccount({ ...job, now: input.now });
          return "succeeded" as const;
        } catch {
          await this.userRepository.releaseDeletionLease({ ...job, now: input.now });
          return "retry" as const;
        }
      }),
    );
    const outcomes = settledOutcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    return {
      claimed: outcomes.length,
      succeeded: outcomes.filter((outcome) => outcome === "succeeded").length,
      retryScheduled: outcomes.filter((outcome) => outcome === "retry").length,
      permanentlyFailed: 0,
      hasMore: claimed.hasMore,
    };
  };
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
  const photoUploadIds = input.photoUploadIds.map((id) => id.trim());
  if (photoUploadIds.length < PROFILE_PHOTO_MIN_COUNT || photoUploadIds.length > PROFILE_PHOTO_MAX_COUNT) {
    throw new CustomBadRequestException("PROFILE_PHOTO_COUNT_INVALID");
  }
  if (
    new Set(photoUploadIds).size !== photoUploadIds.length ||
    photoUploadIds.some((id, index) => !isUuid(id) || id !== input.photoUploadIds[index])
  ) {
    throw new CustomBadRequestException("PROFILE_PHOTO_UPLOAD_INVALID");
  }
  return { userName, birthDate, region, interestedGender, intro, photoUploadIds };
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

const validateBatchLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ACCOUNT_DELETION_BATCH_LIMIT_INVALID");
  }
  return limit;
};

const validateUuid = (input: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new CustomBadRequestException("USER_ID_INVALID");
  }
};
