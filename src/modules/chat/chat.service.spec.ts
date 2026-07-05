import { describe, expect, it, jest } from "@jest/globals";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

describe("ChatService", () => {
  const roomId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const userId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("keeps empty matched rooms with a null last message", async () => {
    const repository = {
      rooms: jest.fn<() => Promise<{ id: string; name: string; lastMessage: string | null }[]>>().mockResolvedValue([
        { id: roomId, name: "차한잔", lastMessage: null },
      ]),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.rooms(userId)).resolves.toEqual([{ id: roomId, name: "차한잔", lastMessage: null }]);
    expect(repository.rooms).toHaveBeenCalledWith(userId);
  });

  it("rejects an oversized first message", async () => {
    const repository = {
      ensureRoom: jest.fn<() => Promise<void>>(),
      activeMessageCount: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.sendMessage({ roomId, text: "a".repeat(31) })).rejects.toThrow("FIRST_MESSAGE_TEXT_TOO_LONG");
  });

  it("returns an existing message for the same idempotency key", async () => {
    const message = {
      id: "821cc06e-7275-49cf-9d8b-a70e65f78240",
      roomId,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      ensureRoom: jest.fn<() => Promise<void>>(),
      findMessageByIdempotencyKey: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
      activeMessageCount: jest.fn<() => Promise<number>>(),
      createMessage: jest.fn<() => Promise<typeof message>>(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.sendMessage({ roomId, text: "hello", idempotencyKey: "same-key" })).resolves.toEqual({
      id: message.id,
      roomId,
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
});
