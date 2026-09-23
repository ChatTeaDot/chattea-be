import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Expo, ExpoPushMessage } from "expo-server-sdk";
import { ExpoGatewayReceipt, ExpoGatewayTicket } from "./push-delivery.types";

@Injectable()
export class ExpoPushGateway {
  private readonly client: Expo;

  constructor(configService: ConfigService) {
    const accessToken = configService.get<string>("EXPO_PUSH_ACCESS_TOKEN")?.trim();
    this.client = new Expo(accessToken ? { accessToken } : undefined);
  }

  isValidToken = (token: string): boolean => Expo.isExpoPushToken(token);

  send = async (messages: readonly ExpoPushMessage[]): Promise<readonly ExpoGatewayTicket[]> =>
    (await this.client.sendPushNotificationsAsync([...messages])).map((ticket) =>
      ticket.status === "ok"
        ? { status: "ok", id: ticket.id }
        : {
            status: "error",
            message: ticket.message,
            ...(ticket.details?.error ? { errorCode: ticket.details.error } : {}),
          },
    );

  getReceipts = async (ticketIds: readonly string[]): Promise<ReadonlyMap<string, ExpoGatewayReceipt>> => {
    const receipts = await this.client.getPushNotificationReceiptsAsync([...ticketIds]);
    return new Map(
      Object.entries(receipts).map(([ticketId, receipt]) => [
        ticketId,
        receipt.status === "ok"
          ? { status: "ok" as const }
          : {
              status: "error" as const,
              message: receipt.message,
              ...(receipt.details?.error ? { errorCode: receipt.details.error } : {}),
            },
      ]),
    );
  };
}
