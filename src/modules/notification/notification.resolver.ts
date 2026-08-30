import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { deviceIdFromRequest } from "src/modules/auth/device-id";
import { NotificationService } from "./notification.service";
import { NotificationPayload, RegisterPushTokenInput } from "./notification.types";

@Resolver()
export class NotificationResolver {
  constructor(private readonly notificationService: NotificationService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [NotificationPayload])
  notifications(@Context("req") req: AuthRequest) {
    return this.notificationService.list(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  markNotificationRead(@Context("req") req: AuthRequest, @Args("notificationId") notificationId: string) {
    return this.notificationService.markRead(req.user.userId, notificationId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  registerPushToken(@Context("req") req: AuthRequest, @Args("input") input: RegisterPushTokenInput) {
    return this.notificationService.registerPushToken(req.user.userId, deviceIdFromRequest(req), input);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  unregisterPushToken(@Context("req") req: AuthRequest) {
    return this.notificationService.unregisterPushToken(req.user.userId, deviceIdFromRequest(req));
  }
}
