import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { notifications, pushTokens, type NotificationType } from "src/modules/database/schema";

@Injectable()
export class NotificationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list(userId: string) {
    return this.db.query.notifications.findMany({
      where: eq(notifications.userId, userId),
      orderBy: [desc(notifications.createdAt)],
      limit: 100,
    });
  }

  create(input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    route?: string;
    sourceId?: string;
  }) {
    return this.db
      .insert(notifications)
      .values(input)
      .returning()
      .then(([notification]) => notification);
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const [notification] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return Boolean(notification);
  }

  registerPushToken(input: { userId: string; token: string; platform: string }) {
    return this.db
      .insert(pushTokens)
      .values(input)
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId: input.userId, platform: input.platform, updatedAt: new Date() },
      });
  }

  listPushTokens(userId: string) {
    return this.db.query.pushTokens.findMany({
      columns: { token: true },
      where: eq(pushTokens.userId, userId),
    });
  }
}
