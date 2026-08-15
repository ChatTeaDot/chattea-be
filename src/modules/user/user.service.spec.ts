import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, jest } from "@jest/globals";
import { PhoneVerificationToken, User } from "src/modules/database/schema";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";

describe("UserService native profile flow", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";

  it("saves the required profile fields and up to three ordered photos", async () => {
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      replaceProfile: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await service.updateProfile(userId, {
      userName: "차한잔",
      birthDate: "1998-01-01",
      region: "서울",
      interestedGender: "everyone",
      intro: "차분한 대화를 좋아해요.",
      photoUrls: ["https://images.example/profile-1.jpg", "https://images.example/profile-2.jpg"],
    });

    expect(repository.replaceProfile).toHaveBeenCalledWith({
      userId,
      userName: "차한잔",
      birthDate: "1998-01-01",
      region: "서울",
      interestedGender: "everyone",
      intro: "차분한 대화를 좋아해요.",
      photoUrls: ["https://images.example/profile-1.jpg", "https://images.example/profile-2.jpg"],
    });
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
        photoUrls: ["https://images.example/profile-1.jpg"],
      }),
    ).rejects.toThrow("PROFILE_AGE_REQUIRED");
  });

  it("hides an account immediately and schedules a 14-day recovery window", async () => {
    const repository = {
      findUser: jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId }),
      scheduleDeletion: jest.fn<() => Promise<void>>(),
    } as unknown as UserRepository;
    const service = new UserService(repository);
    const now = new Date("2026-01-01T00:00:00.000Z");

    await expect(service.beginAccountDeletion(userId, now)).resolves.toEqual({
      hidden: true,
      scheduledFor: "2026-01-15T00:00:00.000Z",
    });
    expect(repository.scheduleDeletion).toHaveBeenCalledWith(userId, new Date("2026-01-15T00:00:00.000Z"));
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

  it("rejects profile updates with a phoneVerificationToken for another phone", async () => {
    const user = {
      userId,
      email: "user@example.com",
      phone: "+821011111111",
      password: "hash",
      userName: "user",
      gender: "female",
      intro: "",
      birthDate: null,
      region: null,
      interestedGender: null,
      profileCompletedAt: null,
      hiddenAt: null,
      deletionScheduledAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as User;
    const token: PhoneVerificationToken = {
      tokenHash: "token",
      phoneE164: "+821022222222",
      verificationId: "ab9d2c86-8c2c-4d62-8b0f-04aaaf4c4674",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const repository = {
      findUser: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
      findPhoneVerificationToken: jest.fn<() => Promise<PhoneVerificationToken | undefined>>().mockResolvedValue(token),
    } as unknown as UserRepository;
    const service = new UserService(repository);

    await expect(
      service.updateEmail({
        userId: user.userId,
        email: "next@example.com",
        phoneVerificationToken: token.tokenHash,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
