import { describe, expect, it, jest } from "@jest/globals";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

describe("ChatService", () => {
  const roomId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const userId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("keeps empty matched rooms with a null last message", async () => {
    const repository = {
      rooms: jest
        .fn<() => Promise<{ id: string; name: string; lastMessage: string | null; unreadCount: number }[]>>()
        .mockResolvedValue([{ id: roomId, name: "차한잔", lastMessage: null, unreadCount: 0 }]),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.rooms(userId)).resolves.toEqual([
      { id: roomId, name: "차한잔", lastMessage: null, unreadCount: 0 },
    ]);
    expect(repository.rooms).toHaveBeenCalledWith(userId);
  });

  it("rejects an oversized first message", async () => {
    const repository = {
      hasRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      activeMessageCount: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.sendMessage({ roomId, senderUserId: userId, text: "a".repeat(31) })).rejects.toThrow(
      "FIRST_MESSAGE_TEXT_TOO_LONG",
    );
  });

  it("returns an existing message for the same idempotency key", async () => {
    const message = {
      id: "821cc06e-7275-49cf-9d8b-a70e65f78240",
      roomId,
      senderUserId: null,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      hasRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageByIdempotencyKey: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
      activeMessageCount: jest.fn<() => Promise<number>>(),
      createMessage: jest.fn<() => Promise<typeof message>>(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(
      service.sendMessage({ roomId, senderUserId: userId, text: "hello", idempotencyKey: "same-key" }),
    ).resolves.toEqual({
      id: message.id,
      roomId,
      senderUserId: undefined,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(repository.createMessage).not.toHaveBeenCalled();
  });

  it("blocks unread summaries for unsupported plans", () => {
    const service = new ChatService({} as ChatRepository);

    expect(service.unreadMessageSummary({ planId: "basic", unreadTexts: ["a".repeat(40)], enabled: true })).toEqual({
      available: false,
      reason: "SUMMARY_PLAN_REQUIRED",
      sourceText: "",
    });
  });

  it("allows reports only from a room member", async () => {
    const repository = {
      findActiveMessage: jest.fn<() => Promise<{ id: string; roomId: string }>>().mockResolvedValue({
        id: "0dfb6d38-9152-4916-91af-af2bb529fcee",
        roomId,
      }),
      hasRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
      reportMessage: jest.fn<() => Promise<void>>(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.reportMessage(userId, "0dfb6d38-9152-4916-91af-af2bb529fcee", "사용자 신고")).rejects.toThrow(
      "ROOM_ACCESS_DENIED",
    );
    expect(repository.reportMessage).not.toHaveBeenCalled();
  });
});
