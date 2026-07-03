import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, jest } from "@jest/globals";
import { PhoneVerificationToken, User } from "src/modules/database/schema";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";

describe("UserService", () => {
  it("rejects profile updates with a phoneVerificationToken for another phone", async () => {
    const user: User = {
      userId: "8df07796-671f-48d5-949b-409126504801",
      email: "user@example.com",
      phone: "+821011111111",
      password: "hash",
      userName: "user",
      intro: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
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
