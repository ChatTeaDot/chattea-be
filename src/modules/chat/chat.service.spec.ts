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
        .mockResolvedValue([{ id: roomId, name: "차한잔", lastMessage: null, unreadCount: 3 }]),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.rooms(userId)).resolves.toEqual([
      { id: roomId, name: "차한잔", lastMessage: null, unreadCount: 3 },
    ]);
    expect(repository.rooms).toHaveBeenCalledWith(userId);
  });

  it("rejects an oversized first message", async () => {
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      activeMessageCount: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.sendMessage(userId, { roomId, text: "a".repeat(31) })).rejects.toThrow(
      "FIRST_MESSAGE_TEXT_TOO_LONG",
    );
  });

  it("returns an existing message for the same idempotency key", async () => {
    const message = {
      id: "821cc06e-7275-49cf-9d8b-a70e65f78240",
      roomId,
      senderUserId: userId,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageByIdempotencyKey: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
      activeMessageCount: jest.fn<() => Promise<number>>(),
      createMessage: jest.fn<() => Promise<typeof message>>(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.sendMessage(userId, { roomId, text: "hello", idempotencyKey: "same-key" })).resolves.toEqual({
      id: message.id,
      roomId,
      senderUserId: userId,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(repository.findMessageByIdempotencyKey).toHaveBeenCalledWith("same-key", roomId, userId);
    expect(repository.createMessage).not.toHaveBeenCalled();
  });

  it("rejects message access for a user outside the room", async () => {
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
      messages: jest.fn(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.messages(userId, { roomId })).rejects.toThrow("채팅방에 접근할 수 없습니다.");
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it("rejects a malformed message-id cursor", async () => {
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      messages: jest.fn(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.messages(userId, { roomId, after: "not-a-cursor" })).rejects.toThrow("MESSAGE_CURSOR_INVALID");
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it("keeps message-id cursor compatibility and passes the id after validation", async () => {
    const id = "f234994b-67ab-4387-9ac6-38f1b85c7027";
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageCursor: jest.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id }),
      messages: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await service.messages(userId, { roomId, after: id });
    expect(repository.findMessageCursor).toHaveBeenCalledWith(id, roomId);
    expect(repository.messages).toHaveBeenCalledWith({ roomId, limit: 50, after: id });
  });

  it("rejects a malformed before cursor", async () => {
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      messages: jest.fn(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.messages(userId, { roomId, before: "not-a-cursor" })).rejects.toThrow(
      "MESSAGE_CURSOR_INVALID",
    );
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it("rejects a request mixing after and before cursors", async () => {
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      messages: jest.fn(),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(
      service.messages(userId, {
        roomId,
        after: "f234994b-67ab-4387-9ac6-38f1b85c7027",
        before: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
      }),
    ).rejects.toThrow("MESSAGE_CURSOR_INVALID");
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it("passes a before cursor to the repository after validation", async () => {
    const id = "f234994b-67ab-4387-9ac6-38f1b85c7027";
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageCursor: jest.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id }),
      messages: jest.fn<() => Promise<never[]>>().mockResolvedValue([]),
    } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await service.messages(userId, { roomId, before: id });
    expect(repository.findMessageCursor).toHaveBeenCalledWith(id, roomId);
    expect(repository.messages).toHaveBeenCalledWith({ roomId, limit: 50, before: id });
  });

  it("rejects a malformed message id before editing", async () => {
    const repository = { editMessage: jest.fn() } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.editMessage(userId, { messageId: "invalid", text: "hello" })).rejects.toThrow(
      "MESSAGE_ID_INVALID",
    );
    expect(repository.editMessage).not.toHaveBeenCalled();
  });

  it("rejects a malformed message id before deleting", async () => {
    const repository = { deleteMessage: jest.fn() } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.deleteMessage(userId, "invalid")).rejects.toThrow("MESSAGE_ID_INVALID");
    expect(repository.deleteMessage).not.toHaveBeenCalled();
  });

  it("publishes an added event when a message is created", async () => {
    const message = {
      id: "f234994b-67ab-4387-9ac6-38f1b85c7027",
      roomId,
      senderUserId: userId,
      text: "hello",
      idempotencyKey: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageByIdempotencyKey: jest.fn(),
      activeMessageCount: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      createMessage: jest
        .fn<() => Promise<{ message: typeof message; created: boolean }>>()
        .mockResolvedValue({ message, created: true }),
      otherRoomMemberIds: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    } as unknown as ChatRepository;
    const pubSub = {
      publish: jest.fn<(trigger: string, payload: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };
    const service = new ChatService(repository, undefined, pubSub as never);

    await service.sendMessage(userId, { roomId, text: "hello" });
    expect(pubSub.publish).toHaveBeenCalledWith("chatEvent", {
      chatEvent: {
        type: "added",
        message: {
          id: message.id,
          roomId,
          senderUserId: userId,
          text: "hello",
          idempotencyKey: undefined,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
  });

  it("does not publish when the idempotency replay returns an existing message", async () => {
    const message = {
      id: "f234994b-67ab-4387-9ac6-38f1b85c7027",
      roomId,
      senderUserId: userId,
      text: "hello",
      idempotencyKey: "same-key",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      isRoomMember: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      findMessageByIdempotencyKey: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
    } as unknown as ChatRepository;
    const pubSub = { publish: jest.fn() };
    const service = new ChatService(repository, undefined, pubSub as never);

    await service.sendMessage(userId, { roomId, text: "hello", idempotencyKey: "same-key" });
    expect(pubSub.publish).not.toHaveBeenCalled();
  });

  it("publishes an edited event when a message is edited", async () => {
    const message = {
      id: "f234994b-67ab-4387-9ac6-38f1b85c7027",
      roomId,
      senderUserId: userId,
      text: "edited",
      idempotencyKey: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      editMessage: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
    } as unknown as ChatRepository;
    const pubSub = {
      publish: jest.fn<(trigger: string, payload: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };
    const service = new ChatService(repository, undefined, pubSub as never);

    await service.editMessage(userId, { messageId: message.id, text: "edited" });
    expect(pubSub.publish).toHaveBeenCalledWith("chatEvent", {
      chatEvent: { type: "edited", message: expect.objectContaining({ id: message.id, text: "edited" }) },
    });
  });

  it("publishes a deleted event when a message is deleted", async () => {
    const message = {
      id: "f234994b-67ab-4387-9ac6-38f1b85c7027",
      roomId,
      senderUserId: userId,
      text: "gone",
      idempotencyKey: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: new Date("2026-01-01T00:01:00.000Z"),
    };
    const repository = {
      deleteMessage: jest.fn<() => Promise<typeof message>>().mockResolvedValue(message),
    } as unknown as ChatRepository;
    const pubSub = {
      publish: jest.fn<(trigger: string, payload: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };
    const service = new ChatService(repository, undefined, pubSub as never);

    await service.deleteMessage(userId, message.id);
    expect(pubSub.publish).toHaveBeenCalledWith("chatEvent", {
      chatEvent: { type: "deleted", message: expect.objectContaining({ id: message.id }) },
    });
  });

  it("assertRoomMember rejects a malformed room id", async () => {
    const repository = { isRoomMember: jest.fn() } as unknown as ChatRepository;
    const service = new ChatService(repository);

    await expect(service.assertRoomMember("not-a-room", userId)).rejects.toThrow("ROOM_ID_INVALID");
    expect(repository.isRoomMember).not.toHaveBeenCalled();
  });
});
