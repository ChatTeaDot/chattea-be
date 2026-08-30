import { mkdtemp, readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import {
  FileMaintenanceHeartbeat,
  MaintenanceBatchResult,
  MaintenanceRunner,
  MaintenanceServices,
} from "./maintenance.runner";

const completedBatch: MaintenanceBatchResult = {
  claimed: 1,
  succeeded: 1,
  retryScheduled: 0,
  permanentlyFailed: 0,
  hasMore: false,
};

const createServices = (events: string[]): MaintenanceServices => ({
  userService: {
    processDueAccountDeletionBatch: async () => {
      events.push("account-deletion");
      return completedBatch;
    },
  },
  notificationService: {
    processPushOutboxBatch: async () => {
      events.push("push-outbox");
      return completedBatch;
    },
    processPushReceiptBatch: async () => {
      events.push("push-receipts");
      return completedBatch;
    },
  },
  uploadService: {
    cleanupExpiredStagingBatch: async () => {
      events.push("staging-cleanup");
      return completedBatch;
    },
  },
});

describe("MaintenanceRunner", () => {
  it("runs every bounded job immediately in a fixed order with one timestamp", async () => {
    const events: string[] = [];
    const inputs: Array<{ now: Date; limit: number }> = [];
    const services = createServices(events);
    const now = new Date("2026-08-29T00:00:00.000Z");
    services.userService.processDueAccountDeletionBatch = async (input) => {
      inputs.push(input);
      events.push("account-deletion");
      return completedBatch;
    };
    services.notificationService.processPushOutboxBatch = async (input) => {
      inputs.push(input);
      events.push("push-outbox");
      return completedBatch;
    };
    services.notificationService.processPushReceiptBatch = async (input) => {
      inputs.push(input);
      events.push("push-receipts");
      return completedBatch;
    };
    services.uploadService.cleanupExpiredStagingBatch = async (input) => {
      inputs.push(input);
      events.push("staging-cleanup");
      return completedBatch;
    };
    let heartbeatCount = 0;
    const runner = new MaintenanceRunner({
      services,
      lock: {
        runExclusive: async (task) => {
          await task();
          return "acquired";
        },
      },
      heartbeat: { write: async () => void (heartbeatCount += 1) },
      logger: { log: () => undefined, error: () => undefined },
      now: () => now,
    });

    await expect(runner.runCycle()).resolves.toBe("acquired");

    expect(events).toEqual(["account-deletion", "push-outbox", "push-receipts", "staging-cleanup"]);
    expect(inputs).toEqual(Array.from({ length: 4 }, () => ({ now, limit: 100 })));
    expect(heartbeatCount).toBe(1);
  });

  it("isolates a failed job and writes a completed-cycle heartbeat", async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const services = createServices(events);
    services.notificationService.processPushOutboxBatch = async () => {
      events.push("push-outbox");
      throw new Error("expo unavailable");
    };
    let heartbeatCount = 0;
    const runner = new MaintenanceRunner({
      services,
      lock: {
        runExclusive: async (task) => {
          await task();
          return "acquired";
        },
      },
      heartbeat: { write: async () => void (heartbeatCount += 1) },
      logger: { log: () => undefined, error: (value) => void errors.push(value) },
    });

    await expect(runner.runCycle()).resolves.toBe("acquired");

    expect(events).toEqual(["account-deletion", "push-outbox", "push-receipts", "staging-cleanup"]);
    expect(errors).toHaveLength(1);
    expect(heartbeatCount).toBe(1);
  });

  it("writes a heartbeat without invoking jobs when another process owns the lock", async () => {
    const events: string[] = [];
    let heartbeatCount = 0;
    const runner = new MaintenanceRunner({
      services: createServices(events),
      lock: { runExclusive: async () => "skipped" },
      heartbeat: { write: async () => void (heartbeatCount += 1) },
      logger: { log: () => undefined, error: () => undefined },
    });

    await expect(runner.runCycle()).resolves.toBe("skipped");

    expect(events).toEqual([]);
    expect(heartbeatCount).toBe(1);
  });

  it("waits for a running cycle before scheduling the next one", async () => {
    const events: string[] = [];
    const services = createServices(events);
    let releaseFirstJob: (() => void) | undefined;
    services.userService.processDueAccountDeletionBatch = async () => {
      events.push("account-deletion");
      await new Promise<void>((resolve) => {
        releaseFirstJob = resolve;
      });
      return completedBatch;
    };
    const controller = new AbortController();
    let sleeps = 0;
    const runner = new MaintenanceRunner({
      services,
      lock: {
        runExclusive: async (task) => {
          await task();
          return "acquired";
        },
      },
      heartbeat: { write: async () => undefined },
      logger: { log: () => undefined, error: () => undefined },
      sleep: async () => {
        sleeps += 1;
        controller.abort();
      },
    });

    const running = runner.run(controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sleeps).toBe(0);
    releaseFirstJob?.();
    await expect(running).resolves.toBeUndefined();
    expect(sleeps).toBe(1);
  });

  it("removes a stale heartbeat before the immediate cycle", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const runner = new MaintenanceRunner({
      services: createServices(events),
      lock: {
        runExclusive: async (task) => {
          await task();
          return "acquired";
        },
      },
      heartbeat: {
        reset: async () => void events.push("heartbeat-reset"),
        write: async () => void events.push("heartbeat-write"),
      },
      logger: { log: () => undefined, error: () => undefined },
      sleep: async () => controller.abort(),
    });

    await runner.run(controller.signal);

    expect(events).toEqual([
      "heartbeat-reset",
      "account-deletion",
      "push-outbox",
      "push-receipts",
      "staging-cleanup",
      "heartbeat-write",
    ]);
  });
});

describe("FileMaintenanceHeartbeat", () => {
  it("atomically refreshes the configured heartbeat file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chattea-maintenance-"));
    const heartbeatPath = path.join(directory, "heartbeat");
    const heartbeat = new FileMaintenanceHeartbeat(heartbeatPath);

    await heartbeat.write();

    expect(await readFile(heartbeatPath, "utf8")).toBe("ready\n");
    expect((await stat(heartbeatPath)).isFile()).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });
});
