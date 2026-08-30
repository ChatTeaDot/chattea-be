import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { MaintenanceLockService } from "../src/maintenance/maintenance-lock.service";
import { DatabasePool } from "../src/modules/database/database-pool";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

jest.setTimeout(30_000);

describePostgres("maintenance advisory lock", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("allows only one process to execute a maintenance cycle", async () => {
    const firstLock = new MaintenanceLockService(pool);
    const secondLock = new MaintenanceLockService(pool);
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstLock.runExclusive(async () => {
      firstStarted?.();
      await held;
    });
    await started;
    let secondExecuted = false;

    await expect(
      secondLock.runExclusive(async () => {
        secondExecuted = true;
      }),
    ).resolves.toBe("skipped");

    expect(secondExecuted).toBe(false);
    releaseFirst?.();
    await expect(first).resolves.toBe("acquired");
  });

  it("unlocks the session after a failed cycle", async () => {
    const lock = new MaintenanceLockService(pool);
    await expect(
      lock.runExclusive(async () => {
        throw new Error("cycle failed");
      }),
    ).rejects.toThrow("cycle failed");

    let executed = false;
    await expect(
      lock.runExclusive(async () => {
        executed = true;
      }),
    ).resolves.toBe("acquired");
    expect(executed).toBe(true);
  });

  it("closes the managed database pool during application shutdown", async () => {
    const managedPool = new DatabasePool(
      new ConfigService({
        POSTGRES_HOST: process.env.POSTGRES_HOST,
        POSTGRES_PORT: Number(process.env.POSTGRES_PORT ?? 5432),
        POSTGRES_USERNAME: process.env.POSTGRES_USERNAME,
        POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
        POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
        POSTGRES_SSL: false,
      }),
    );
    await expect(managedPool.query("SELECT 1")).resolves.toBeDefined();

    await managedPool.onApplicationShutdown();

    await expect(managedPool.query("SELECT 1")).rejects.toThrow("Cannot use a pool after calling end");
  });
});
