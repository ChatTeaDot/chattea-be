import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat-service.js";

describe("ChatService", () => {
  it("stores messages and returns the same server message for duplicate idempotency key", () => {
    const service = new ChatService();

    const first = service.sendMessage(
      { roomId: "demo-room", text: "안녕하세요", idempotencyKey: "temp-1" },
      new Date("2026-06-25T00:00:01.000Z"),
    );
    const duplicate = service.sendMessage(
      { roomId: "demo-room", text: "안녕하세요", idempotencyKey: "temp-1" },
      new Date("2026-06-25T00:00:02.000Z"),
    );

    expect(duplicate).toEqual(first);
    expect(service.listMessages({ roomId: "demo-room" }).filter((message) => message.text === "안녕하세요")).toHaveLength(1);
    expect(service.listRooms()[0]!.lastMessage).toBe("안녕하세요");
  });

  it("rejects empty and overlong messages", () => {
    const service = new ChatService();

    expect(() => service.sendMessage({ roomId: "demo-room", text: "   " })).toThrow("MESSAGE_TEXT_REQUIRED");
    expect(() => service.sendMessage({ roomId: "demo-room", text: "a".repeat(91) })).toThrow("MESSAGE_TEXT_TOO_LONG");
  });

  it("limits the first message in a new room to 30 characters", () => {
    const service = new ChatService();

    expect(() => service.sendMessage({ roomId: "new-room", text: "a".repeat(31) })).toThrow(
      "FIRST_MESSAGE_TEXT_TOO_LONG",
    );
    expect(service.sendMessage({ roomId: "new-room", text: "a".repeat(30) }).text).toHaveLength(30);
  });

  it("edits, deletes, and marks rooms read", () => {
    const service = new ChatService();
    const message = service.sendMessage({ roomId: "demo-room", text: "before" });

    expect(service.editMessage({ messageId: message.id, text: "after" }).text).toBe("after");
    expect(service.listRooms()[0]!.lastMessage).toBe("after");
    expect(service.markRoomRead("demo-room")).toBe(true);
    expect(service.isRoomRead("demo-room")).toBe(true);
    expect(service.deleteMessage(message.id)).toBe(true);
    expect(service.listMessages({ roomId: "demo-room" }).some((item) => item.id === message.id)).toBe(false);
  });

  it("blocks users and reports messages", () => {
    const service = new ChatService();
    const message = service.sendMessage({ roomId: "demo-room", text: "신고 대상" });

    expect(service.blockUser("user-1", "user-2")).toBe(true);
    expect(() => service.blockUser("user-1", "user-1")).toThrow("BLOCK_SELF_NOT_ALLOWED");
    expect(service.reportMessage("user-1", message.id, "불쾌한 메시지")).toBe(true);
    expect(() => service.reportMessage("user-1", message.id, " ")).toThrow("REPORT_REASON_REQUIRED");
  });
});
