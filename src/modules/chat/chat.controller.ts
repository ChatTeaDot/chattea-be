import { Controller, Headers, MessageEvent, Param, Req, Sse, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Observable, Subscription, filter } from "rxjs";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ChatService } from "./chat.service";

const SSE_REPLAY_LIMIT = 100;

@UseGuards(AuthGuard("access_token"))
@Controller("api/chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Sse(":roomId/stream")
  stream(
    @Req() req: AuthRequest,
    @Param("roomId") roomId: string,
    @Headers("last-event-id") lastEventId?: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let liveSubscription: Subscription | null = null;
      let active = true;

      const replay = async () => {
        try {
          const missed = await this.loadReplay(req.user.userId, roomId, lastEventId);
          if (!active) return;
          for (const message of missed) {
            subscriber.next({ id: message.id, data: JSON.stringify(message) });
          }
          liveSubscription = this.chatService.messageEvents$
            .pipe(filter((event) => event.roomId === roomId))
            .subscribe({
              next: (event) =>
                subscriber.next({ id: event.message.id, data: JSON.stringify(event.message) }),
              error: (error) => subscriber.error(error),
            });
        } catch (error) {
          subscriber.error(error);
        }
      };

      replay();
      return () => {
        active = false;
        liveSubscription?.unsubscribe();
      };
    });
  }

  private async loadReplay(userId: string, roomId: string, lastEventId?: string) {
    if (lastEventId) {
      try {
        return await this.chatService.messages(userId, { roomId, first: SSE_REPLAY_LIMIT, after: lastEventId });
      } catch (error) {
        if (error instanceof Error && error.message === "MESSAGE_CURSOR_INVALID") {
          return this.chatService.messages(userId, { roomId, first: SSE_REPLAY_LIMIT });
        }
        throw error;
      }
    }
    return this.chatService.messages(userId, { roomId, first: SSE_REPLAY_LIMIT });
  }
}
