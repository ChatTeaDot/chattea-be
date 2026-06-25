import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat-service.js";

describe("Chat subscriptions", () => {
  it("publishes created, updated, deleted, typing, and read receipt events", async () => {
    const service = new ChatService();
    const created = service
      .subscribeMessageCreated("demo-room")
      [Symbol.asyncIterator]();
    const updated = service
      .subscribeMessageUpdated("demo-room")
      [Symbol.asyncIterator]();
    const deleted = service
      .subscribeMessageDeleted("demo-room")
      [Symbol.asyncIterator]();
    const typing = service
      .subscribeTypingChanged("demo-room")
      [Symbol.asyncIterator]();
    const read = service
      .subscribeReadReceiptUpdated("demo-room")
      [Symbol.asyncIterator]();

    const message = service.sendMessage({
      roomId: "demo-room",
      text: "created",
    });
    service.editMessage({ messageId: message.id, text: "updated" });
    service.setTyping("demo-room", true);
    service.markRoomRead("demo-room");
    service.deleteMessage(message.id);

    await expect(created.next()).resolves.toMatchObject({
      value: { text: "created" },
    });
    await expect(updated.next()).resolves.toMatchObject({
      value: { text: "updated" },
    });
    await expect(typing.next()).resolves.toMatchObject({
      value: { typing: true },
    });
    await expect(read.next()).resolves.toMatchObject({ value: { read: true } });
    await expect(deleted.next()).resolves.toMatchObject({
      value: { messageId: message.id },
    });

    await created.return?.();
    await updated.return?.();
    await deleted.return?.();
    await typing.return?.();
    await read.return?.();
  });
});
