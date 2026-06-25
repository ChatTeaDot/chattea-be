import { createClient } from "graphql-ws";
import type { Server } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/auth/session-store.js";
import { ChatService } from "../src/chat/chat-service.js";
import { createApp } from "../src/server.js";

describe("GraphQL WebSocket auth", () => {
  let server: Server | null = null;
  const clients: Array<{ dispose: () => void }> = [];

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.dispose());

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  });

  it("uses connection authorization headers for subscriptions", async () => {
    const sessionStore = new SessionStore();
    const chatService = new ChatService();
    const session = await sessionStore.createSession({
      id: "ws-user",
      phoneE164: "+821088887777",
      nickname: "ws",
      intro: "",
    });
    server = createApp({ chatService, sessionStore });

    await new Promise<void>((resolve) => {
      server!.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address missing");
    }

    const client = createClient({
      url: `ws://localhost:${address.port}/graphql`,
      webSocketImpl: WebSocket,
      connectionParams: {
        authorization: `Bearer ${session.session.token}`,
      },
    });
    clients.push(client);
    const received = new Promise<string>((resolve, reject) => {
      let sendTimer: ReturnType<typeof setInterval> | null = null;
      const failTimer = setTimeout(() => {
        if (sendTimer) {
          clearInterval(sendTimer);
        }
        dispose();
        reject(new Error("WEBSOCKET_SUBSCRIPTION_TIMEOUT"));
      }, 2000);
      const dispose = client.subscribe(
        {
          query: `
            subscription {
              messageCreated(roomId: "demo-room") {
                text
              }
            }
          `,
        },
        {
          next(value) {
            if (sendTimer) {
              clearInterval(sendTimer);
            }
            clearTimeout(failTimer);
            dispose();
            const message = value.data?.messageCreated as { text: string } | undefined;
            resolve(message?.text ?? "");
          },
          error(error) {
            if (sendTimer) {
              clearInterval(sendTimer);
            }
            clearTimeout(failTimer);
            reject(error);
          },
          complete: () => undefined,
        },
      );
      sendTimer = setInterval(() => {
        chatService.sendMessage({ roomId: "demo-room", text: "ws" });
      }, 20);
    });

    await expect(received).resolves.toBe("ws");
    client.dispose();
  });
});
