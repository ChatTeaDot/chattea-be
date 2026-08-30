import { Pool } from "pg";

const maintenanceLockName = "chattea:maintenance";

export class MaintenanceLockService {
  constructor(private readonly pool: Pool) {}

  runExclusive = async (task: () => Promise<void>): Promise<"acquired" | "skipped"> => {
    const client = await this.pool.connect();
    let acquired = false;
    let destroyClient = false;
    let taskError: unknown;
    let unlockError: unknown;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [maintenanceLockName],
      );
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired) return "skipped";
      try {
        await task();
      } catch (error) {
        taskError = error;
      }
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [maintenanceLockName],
        );
        destroyClient = unlock.rows[0]?.unlocked !== true;
      } catch (error) {
        destroyClient = true;
        unlockError = error;
      }
      if (taskError) throw taskError;
      if (unlockError) throw unlockError;
      return "acquired";
    } finally {
      client.release(destroyClient);
    }
  };
}
