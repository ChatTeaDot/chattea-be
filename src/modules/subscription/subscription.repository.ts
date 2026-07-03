import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { userSubscriptions, type UserSubscription } from "src/modules/database/schema";

@Injectable()
export class SubscriptionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 사용자의 현재 활성 구독을 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 현재 활성 구독 또는 undefined
   */
  async findCurrent(userId: string): Promise<UserSubscription | undefined> {
    return this.db.query.userSubscriptions.findFirst({
      where: and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.status, "active"),
        or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, new Date())),
      ),
      orderBy: desc(userSubscriptions.createdAt),
    });
  }
}
