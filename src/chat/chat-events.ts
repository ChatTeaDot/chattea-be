import type { Message } from "./chat-service.js";

export type ChatEventMap = {
  messageCreated: Message;
  messageUpdated: Message;
  messageDeleted: { roomId: string; messageId: string };
  typingChanged: { roomId: string; typing: boolean };
  readReceiptUpdated: { roomId: string; read: boolean };
};

type Listener<T> = (event: T) => void;

export class ChatEventBus {
  private readonly listeners = new Map<
    keyof ChatEventMap,
    Set<Listener<ChatEventMap[keyof ChatEventMap]>>
  >();

  publish<K extends keyof ChatEventMap>(
    eventName: K,
    event: ChatEventMap[K],
  ): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }

  subscribe<K extends keyof ChatEventMap>(
    eventName: K,
    roomId: string,
  ): AsyncIterable<ChatEventMap[K]> {
    const queue: ChatEventMap[K][] = [];
    let notify: (() => void) | null = null;
    const listener = (event: ChatEventMap[K]) => {
      if (this.roomIdOf(event) !== roomId) {
        return;
      }
      queue.push(event);
      notify?.();
      notify = null;
    };
    const listeners =
      this.listeners.get(eventName) ??
      new Set<Listener<ChatEventMap[keyof ChatEventMap]>>();

    listeners.add(listener as Listener<ChatEventMap[keyof ChatEventMap]>);
    this.listeners.set(eventName, listeners);

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }

          return { value: queue.shift()!, done: false };
        },
        return: async () => {
          listeners.delete(
            listener as Listener<ChatEventMap[keyof ChatEventMap]>,
          );
          return { value: undefined, done: true };
        },
      }),
    };
  }

  private roomIdOf(event: ChatEventMap[keyof ChatEventMap]): string {
    return "roomId" in event ? event.roomId : "";
  }
}
