import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationType } from "src/modules/database/schema";
import { NotificationRepository } from "./notification.repository";

@Injectable()
export class NotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly configService: ConfigService,
  ) {}

  async list(userId: string) {
    const notifications = await this.notificationRepository.list(userId);
    return notifications.map((notification) => ({
      ...notification,
      route: notification.route ?? undefined,
      readAt: notification.readAt?.toISOString(),
      createdAt: notification.createdAt.toISOString(),
    }));
  }

  async notify(input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    route?: string;
    sourceId?: string;
  }) {
    const notification = await this.notificationRepository.create(input);
    await this.sendPush(input.userId, { title: input.title, body: input.body, route: input.route });
    return notification;
  }

  markRead(userId: string, notificationId: string) {
    return this.notificationRepository.markRead(userId, notificationId);
  }

  async registerPushToken(userId: string, input: { token: string; platform: string }): Promise<boolean> {
    const token = input.token.trim();
    const platform = input.platform.trim().toLowerCase();
    if (!/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)) {
      throw new Error("PUSH_TOKEN_INVALID");
    }
    if (platform !== "ios" && platform !== "android") throw new Error("PUSH_PLATFORM_INVALID");
    await this.notificationRepository.registerPushToken({ userId, token, platform });
    return true;
  }

  private async sendPush(userId: string, input: { title: string; body: string; route?: string }): Promise<void> {
    if (this.configService.get<string>("EXPO_PUSH_ENABLED") !== "true") return;
    const tokens = await this.notificationRepository.listPushTokens(userId);
    if (tokens.length === 0) return;

    const accessToken = this.configService.get<string>("EXPO_PUSH_ACCESS_TOKEN");
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(
          tokens.map(({ token }) => ({
            to: token,
            title: input.title,
            body: input.body,
            data: input.route ? { route: input.route } : undefined,
            sound: "default",
          })),
        ),
      });
    } catch {
      // A push failure must not discard the in-app notification already persisted above.
    }
  }
}
