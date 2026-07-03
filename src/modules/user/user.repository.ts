import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { phoneVerificationTokens, users, type PhoneVerificationToken, type User } from "src/modules/database/schema";
import { UpdateEmailRepositoryInput, UpdatePasswordRepositoryInput } from "./user.types";

@Injectable()
export class UserRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * userId로 사용자를 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 조회된 사용자 또는 undefined
   */
  findUser(userId: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  }

  findPhoneVerificationToken(token: string): Promise<PhoneVerificationToken | undefined> {
    return this.db.query.phoneVerificationTokens.findFirst({
      where: and(
        eq(phoneVerificationTokens.tokenHash, hashToken(token)),
        isNull(phoneVerificationTokens.usedAt),
        gt(phoneVerificationTokens.expiresAt, new Date()),
      ),
    });
  }

  async consumePhoneVerificationToken(token: string): Promise<PhoneVerificationToken | undefined> {
    const [savedToken] = await this.db
      .update(phoneVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(phoneVerificationTokens.tokenHash, hashToken(token)),
          isNull(phoneVerificationTokens.usedAt),
          gt(phoneVerificationTokens.expiresAt, new Date()),
        ),
      )
      .returning();

    return savedToken;
  }

  /**
   * 사용자의 이메일을 갱신한다.
   *
   * @param input 이메일 변경 입력값
   * @returns 갱신된 사용자 목록
   */
  updateEmail(input: UpdateEmailRepositoryInput): Promise<User[]> {
    const { userId, email } = input;

    return this.db.update(users).set({ email, updatedAt: new Date() }).where(eq(users.userId, userId)).returning();
  }

  /**
   * 사용자의 비밀번호를 갱신한다.
   *
   * @param input 비밀번호 변경 입력값
   * @returns 갱신된 사용자 목록
   */
  updatePassword(input: UpdatePasswordRepositoryInput): Promise<User[]> {
    const { userId, password } = input;

    return this.db.update(users).set({ password, updatedAt: new Date() }).where(eq(users.userId, userId)).returning();
  }
}
