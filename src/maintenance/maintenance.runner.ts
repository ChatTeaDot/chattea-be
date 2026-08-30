import { randomUUID } from "crypto";
import { rename, rm, writeFile } from "fs/promises";
import { setTimeout as delay } from "timers/promises";

export type MaintenanceBatchInput = Readonly<{ now: Date; limit: number }>;

export type MaintenanceBatchResult = Readonly<{
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  hasMore: boolean;
}>;

type MaintenanceBatch = (input: MaintenanceBatchInput) => Promise<MaintenanceBatchResult>;

export type MaintenanceServices = {
  userService: { processDueAccountDeletionBatch: MaintenanceBatch };
  notificationService: {
    processPushOutboxBatch: MaintenanceBatch;
    processPushReceiptBatch: MaintenanceBatch;
  };
  uploadService: { cleanupExpiredStagingBatch: MaintenanceBatch };
};

type MaintenanceLock = {
  runExclusive: (task: () => Promise<void>) => Promise<"acquired" | "skipped">;
};

type MaintenanceHeartbeat = { reset?: () => Promise<void>; write: () => Promise<void> };
type MaintenanceLogger = { log: (value: string) => void; error: (value: string) => void };
type MaintenanceSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

type MaintenanceRunnerOptions = {
  services: MaintenanceServices;
  lock: MaintenanceLock;
  heartbeat: MaintenanceHeartbeat;
  logger: MaintenanceLogger;
  now?: () => Date;
  sleep?: MaintenanceSleep;
};

const sleep: MaintenanceSleep = async (milliseconds, signal) => {
  await delay(milliseconds, undefined, { signal });
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "unknown");

export class FileMaintenanceHeartbeat implements MaintenanceHeartbeat {
  constructor(private readonly heartbeatPath: string) {}

  reset = async (): Promise<void> => {
    await rm(this.heartbeatPath, { force: true });
  };

  write = async (): Promise<void> => {
    const temporaryPath = `${this.heartbeatPath}.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporaryPath, "ready\n", { mode: 0o600 });
      await rename(temporaryPath, this.heartbeatPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  };
}

export class MaintenanceRunner {
  private readonly now: () => Date;
  private readonly sleep: MaintenanceSleep;

  constructor(private readonly options: MaintenanceRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? sleep;
  }

  runCycle = async (): Promise<"acquired" | "skipped"> => {
    const now = this.now();
    const jobs: ReadonlyArray<readonly [string, MaintenanceBatch]> = [
      ["account-deletion", this.options.services.userService.processDueAccountDeletionBatch],
      ["push-outbox", this.options.services.notificationService.processPushOutboxBatch],
      ["push-receipts", this.options.services.notificationService.processPushReceiptBatch],
      ["staging-cleanup", this.options.services.uploadService.cleanupExpiredStagingBatch],
    ];
    const outcome = await this.options.lock.runExclusive(async () => {
      for (const [job, execute] of jobs) {
        const startedAt = Date.now();
        try {
          const result = await execute({ now, limit: 100 });
          this.options.logger.log(
            JSON.stringify({ event: "maintenance_job_completed", job, ...result, durationMs: Date.now() - startedAt }),
          );
        } catch (error) {
          this.options.logger.error(
            JSON.stringify({
              event: "maintenance_job_failed",
              job,
              error: errorMessage(error),
              durationMs: Date.now() - startedAt,
            }),
          );
        }
      }
    });
    if (outcome === "skipped") {
      this.options.logger.log(JSON.stringify({ event: "maintenance_cycle_skipped", reason: "lock_unavailable" }));
    }
    await this.options.heartbeat.write();
    return outcome;
  };

  run = async (signal: AbortSignal): Promise<void> => {
    await this.options.heartbeat.reset?.();
    while (!signal.aborted) {
      try {
        await this.runCycle();
      } catch (error) {
        this.options.logger.error(JSON.stringify({ event: "maintenance_cycle_failed", error: errorMessage(error) }));
      }
      if (signal.aborted) return;
      try {
        await this.sleep(60_000, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  };
}
