import { describe, expect, it, jest } from "@jest/globals";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";

const createDeferred = () => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      if (!resolvePromise) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise();
    },
  };
};

describe("UserService native profile flow", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const firstUploadId = "123e4567-e89b-42d3-a456-426614174000";
  const secondUploadId = "0198f26b-f32b-7fc8-93c5-a67b827ecb27";
  const profileInput = (photoUploadIds: string[]) => ({
    userName: "차한잔",
    birthDate: "1998-01-01",
    region: "서울",
    interestedGender: "everyone",
    intro: "차분한 대화를 좋아해요.",
    photoUploadIds,
  });

  it("passes only verified-upload identities into the atomic profile replacement", async () => {
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      replaceProfile: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await service.updateProfile(userId, profileInput([firstUploadId, secondUploadId]));

    expect(repository.replaceProfile).toHaveBeenCalledWith({
      userId,
      userName: "차한잔",
      birthDate: "1998-01-01",
      region: "서울",
      interestedGender: "everyone",
      intro: "차분한 대화를 좋아해요.",
      photoUploadIds: [firstUploadId, secondUploadId],
    });
  });

  it.each([
    ["raw URL", ["https://images.example.com/profiles/user/photo.jpg"]],
    ["duplicate", [firstUploadId, firstUploadId]],
    ["whitespace", [` ${firstUploadId}`]],
    ["empty", []],
    ["too many", [firstUploadId, secondUploadId, "8df07796-671f-48d5-949b-409126504801", userId]],
  ])("rejects %s profile photo authority", async (_label, photoUploadIds) => {
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      replaceProfile: jest.fn(),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await expect(service.updateProfile(userId, profileInput(photoUploadIds))).rejects.toThrow(
      /PROFILE_PHOTO_(UPLOAD|COUNT)_INVALID/,
    );
    expect(repository.replaceProfile).not.toHaveBeenCalled();
  });

  it("rejects a profile for a person under 18", async () => {
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
    } as unknown as UserRepository;
    const service = new UserService(repository);
    const today = new Date();
    const birthDate = `${today.getUTCFullYear() - 17}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

    await expect(
      service.updateProfile(userId, {
        userName: "차한잔",
        birthDate,
        region: "서울",
        interestedGender: "female",
        intro: "소개",
        photoUploadIds: [firstUploadId],
      }),
    ).rejects.toThrow("PROFILE_AGE_REQUIRED");
  });

  it("hides an account immediately and schedules a 14-day recovery window", async () => {
    const scheduledFor = new Date("2026-01-15T00:00:00.000Z");
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      scheduleDeletion: jest.fn<() => Promise<Date>>().mockResolvedValue(scheduledFor),
    } as unknown as UserRepository;
    const service = new UserService(repository);
    const now = new Date("2026-01-01T00:00:00.000Z");

    await expect(service.beginAccountDeletion(userId, now)).resolves.toEqual({
      hidden: true,
      scheduledFor: "2026-01-15T00:00:00.000Z",
    });
    expect(repository.scheduleDeletion).toHaveBeenCalledWith(userId, scheduledFor);
  });

  it("keeps the original deletion deadline when the request is retried", async () => {
    const originalDeadline = new Date("2026-01-15T00:00:00.000Z");
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      scheduleDeletion: jest.fn(async () => originalDeadline),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await expect(service.beginAccountDeletion(userId, new Date("2026-01-02T00:00:00.000Z"))).resolves.toEqual({
      hidden: true,
      scheduledFor: "2026-01-15T00:00:00.000Z",
    });
  });

  it("processes claimed deletions with structural success and retry results", async () => {
    const retryUserId = "8df07796-671f-48d5-949b-409126504801";
    const now = new Date("2026-08-29T00:00:00.000Z");
    const repository = {
      anonymizeDeletedAccount: jest
        .fn<UserRepository["anonymizeDeletedAccount"]>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("transient")),
      claimDueDeletionBatch: jest.fn<UserRepository["claimDueDeletionBatch"]>().mockResolvedValue({
        jobs: [userId, retryUserId].map((claimedUserId) => ({
          userId: claimedUserId,
          deletionLeaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
        })),
        hasMore: true,
      }),
      releaseDeletionLease: jest.fn<UserRepository["releaseDeletionLease"]>().mockResolvedValue(undefined),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await expect(service.processDueAccountDeletionBatch({ now, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retryScheduled: 1,
      permanentlyFailed: 0,
      hasMore: true,
    });
    expect(repository.claimDueDeletionBatch).toHaveBeenCalledWith({
      now,
      limit: 2,
      leaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
    });
    expect(repository.releaseDeletionLease).toHaveBeenCalledWith({
      userId: retryUserId,
      deletionLeaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
      now,
    });
    expect("onModuleInit" in service).toBe(false);
    expect("onModuleDestroy" in service).toBe(false);
  });

  it("waits for every claimed deletion job before propagating a lease release failure", async () => {
    const failedUserId = "8df07796-671f-48d5-949b-409126504801";
    const deferredUserId = "8df07796-671f-48d5-949b-409126504802";
    const now = new Date("2026-08-29T00:00:00.000Z");
    const siblingStarted = createDeferred();
    const sibling = createDeferred();
    const repository = {
      anonymizeDeletedAccount: jest.fn<UserRepository["anonymizeDeletedAccount"]>().mockImplementation((input) => {
        if (input.userId === failedUserId) return Promise.reject(new Error("ACCOUNT_ANONYMIZE_FAILED"));
        siblingStarted.resolve();
        return sibling.promise;
      }),
      claimDueDeletionBatch: jest.fn<UserRepository["claimDueDeletionBatch"]>().mockResolvedValue({
        jobs: [failedUserId, deferredUserId].map((claimedUserId) => ({
          userId: claimedUserId,
          deletionLeaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
        })),
        hasMore: false,
      }),
      releaseDeletionLease: jest
        .fn<UserRepository["releaseDeletionLease"]>()
        .mockRejectedValue(new Error("ACCOUNT_DELETION_RELEASE_FAILED")),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    const batch = service.processDueAccountDeletionBatch({ now, limit: 2 });
    let settled = false;
    void batch.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await siblingStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    sibling.resolve();
    await expect(batch).rejects.toThrow("ACCOUNT_DELETION_RELEASE_FAILED");
    expect(settled).toBe(true);
  });
});

describe("UserService account security", () => {
  const userId = "8df07796-671f-48d5-949b-409126504801";

  it("defaults current subscription to free", async () => {
    const repository = {
      findCurrentSubscription: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await expect(service.currentSubscription(userId)).resolves.toEqual({ planId: "free" });
  });
});
