import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, gt, isNull } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  phoneVerifications,
  phoneVerificationTokens,
  users,
  type PhoneVerification,
  type PhoneVerificationToken,
  type User,
} from "src/modules/database/schema";

@Injectable()
export class PhoneRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * E.164 전화번호로 사용자를 조회한다.
   *
   * @param phoneE164 E.164 전화번호
   * @returns 조회된 사용자 또는 undefined
   */
  findUserByPhone(phoneE164: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.phone, phoneE164) });
  }

  /**
   * 전화번호 인증 요청 기록을 생성한다.
   *
   * @param input 생성할 전화번호 인증 요청 정보
   * @returns 생성된 전화번호 인증 요청
   */
  async createVerification(input: {
    phoneE164: string;
    codeHash: string;
    purpose: string;
    expiresAt: Date;
    requestIpHash?: string | null;
    userAgentHash?: string;
  }): Promise<PhoneVerification> {
    const [verification] = await this.db.insert(phoneVerifications).values(input).returning();
    return verification;
  }

  async deleteVerification(id: string): Promise<void> {
    await this.db.delete(phoneVerifications).where(eq(phoneVerifications.id, id));
  }

  /**
   * 전화번호의 최신 인증 요청을 조회한다.
   *
   * @param phoneE164 E.164 전화번호
   * @returns 최신 인증 요청 또는 undefined
   */
  latestVerification(phoneE164: string): Promise<PhoneVerification | undefined> {
    return this.db.query.phoneVerifications.findFirst({
      where: eq(phoneVerifications.phoneE164, phoneE164),
      orderBy: desc(phoneVerifications.createdAt),
    });
  }

  /**
   * 특정 시각 이후 같은 전화번호의 인증 요청 목록을 조회한다.
   *
   * @param phoneE164 E.164 전화번호
   * @param since 조회 시작 시각
   * @returns 인증 요청 목록
   */
  verificationsSinceByPhone(phoneE164: string, purpose: string, since: Date): Promise<PhoneVerification[]> {
    return this.db
      .select()
      .from(phoneVerifications)
      .where(
        and(
          eq(phoneVerifications.phoneE164, phoneE164),
          eq(phoneVerifications.purpose, purpose),
          gte(phoneVerifications.createdAt, since),
        ),
      );
  }

  /**
   * 특정 시각 이후 같은 IP 해시의 인증 요청 목록을 조회한다.
   *
   * @param requestIpHash 요청 IP 해시
   * @param since 조회 시작 시각
   * @returns 인증 요청 목록
   */
  async verificationsSinceByIp(requestIpHash: string, purpose: string, since: Date): Promise<PhoneVerification[]> {
    return this.db
      .select()
      .from(phoneVerifications)
      .where(
        and(
          eq(phoneVerifications.requestIpHash, requestIpHash),
          eq(phoneVerifications.purpose, purpose),
          gte(phoneVerifications.createdAt, since),
        ),
      );
  }

  /**
   * 인증 코드 검증 실패 횟수를 1 증가시킨다.
   *
   * @param id 인증 요청 ID
   * @returns 갱신된 인증 요청 또는 null
   */
  async incrementAttempt(id: string): Promise<PhoneVerification | null> {
    const found = await this.db.query.phoneVerifications.findFirst({
      where: eq(phoneVerifications.id, id),
    });
    if (!found) return null;

    const [updated] = await this.db
      .update(phoneVerifications)
      .set({ attemptCount: found.attemptCount + 1 })
      .where(eq(phoneVerifications.id, id))
      .returning();

    return updated;
  }

  /**
   * 아직 검증되지 않은 인증 요청을 검증 완료 처리한다.
   *
   * @param id 인증 요청 ID
   * @returns 갱신된 인증 요청 또는 undefined
   */
  async markVerified(id: string): Promise<PhoneVerification | undefined> {
    const [updated] = await this.db
      .update(phoneVerifications)
      .set({ verifiedAt: new Date() })
      .where(and(eq(phoneVerifications.id, id), isNull(phoneVerifications.verifiedAt)))
      .returning();

    return updated;
  }

  /**
   * 전화번호 가입 토큰을 해시해 저장한다.
   *
   * @param input 저장할 phoneVerificationToken 정보
   * @returns 저장 완료 Promise
   */
  async createPhoneVerificationToken(input: {
    token: string;
    phoneE164: string;
    verificationId: string;
    expiresAt: Date;
  }): Promise<void> {
    const { token, ...values } = input;
    await this.db.insert(phoneVerificationTokens).values({ ...values, tokenHash: hashToken(token) });
  }

  /**
   * 원본 phoneVerificationToken을 해시해 저장된 토큰을 조회한다.
   *
   * @param token 원본 phoneVerificationToken
   * @returns 조회된 phoneVerificationToken 또는 undefined
   */
  findPhoneVerificationToken(token: string): Promise<PhoneVerificationToken | undefined> {
    return this.db.query.phoneVerificationTokens.findFirst({
      where: and(
        eq(phoneVerificationTokens.tokenHash, hashToken(token)),
        isNull(phoneVerificationTokens.usedAt),
        gt(phoneVerificationTokens.expiresAt, new Date()),
      ),
    });
  }

  /**
   * 사용자 계정에 전화번호를 연결한다.
   *
   * @param userId 사용자 ID
   * @param phoneE164 연결할 E.164 전화번호
   * @returns 갱신된 사용자 또는 undefined
   */
  async attachPhone(userId: string, phoneE164: string): Promise<User | undefined> {
    const [user] = await this.db
      .update(users)
      .set({ phone: phoneE164, updatedAt: new Date() })
      .where(eq(users.userId, userId))
      .returning();

    return user;
  }

  /**
   * 전화번호로 사용자를 찾아 비밀번호를 갱신한다.
   *
   * @param phoneE164 E.164 전화번호
   * @param password 해시된 새 비밀번호
   * @returns 갱신된 사용자 또는 undefined
   */
  async updatePasswordByPhone(phoneE164: string, password: string): Promise<User | undefined> {
    const [user] = await this.db
      .update(users)
      .set({ password, updatedAt: new Date() })
      .where(eq(users.phone, phoneE164))
      .returning();

    return user;
  }
}
