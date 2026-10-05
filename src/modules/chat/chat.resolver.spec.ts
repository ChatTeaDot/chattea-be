import { describe, expect, it, jest } from "@jest/globals";
import { PubSub } from "graphql-subscriptions";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ChatResolver } from "./chat.resolver";
import { ChatService } from "./chat.service";

describe("ChatResolver chatEvent", () => {
  const roomId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const userId = "821cc06e-7275-49cf-9d8b-a70e65f78240";
  const req = { user: { userId, tokenType: "access" } } as AuthRequest;

  it("rejects the subscription for a user outside the room", async () => {
    const service = {
      assertRoomMember: jest.fn<() => Promise<void>>().mockRejectedValue(new Error("FORBIDDEN")),
    } as unknown as ChatService;
    const resolver = new ChatResolver(service, new PubSub() as never);

    await expect(resolver.chatEvent(roomId, req)).rejects.toThrow("FORBIDDEN");
    expect(service.assertRoomMember).toHaveBeenCalledWith(roomId, userId);
  });

  it("yields only events for the subscribed room", async () => {
    const pubSub = new PubSub();
    const service = {
      assertRoomMember: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as ChatService;
    const resolver = new ChatResolver(service, pubSub as never);
    const iterator = await resolver.chatEvent(roomId, req);
    const pending = iterator.next();

    await pubSub.publish("chatEvent", {
      chatEvent: {
        type: "added",
        message: { id: "other-room", roomId: "4f29b801-2c88-4b0a-97db-f68bbfa03270" },
      },
    });
    await pubSub.publish("chatEvent", {
      chatEvent: { type: "added", message: { id: "m-1", roomId } },
    });

    const next = await pending;
    expect(next.done).toBe(false);
    expect(next.value).toEqual({ chatEvent: { type: "added", message: { id: "m-1", roomId } } });
    await iterator.return?.();
  });
});
