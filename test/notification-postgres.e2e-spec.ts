import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "src/modules/database/schema";
import { NotificationRepository } from "src/modules/notification/notification.repository";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Notification PostgreSQL outbox", () => {
  const namespace = randomUUID().replaceAll("-", "").slice(0, 12);
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const deviceId = randomUUID();
  const otherDeviceId = randomUUID();
  const token = `ExpoPushToken[${namespace}]`;
  const claimNow = new Date("2001-01-01T01:00:00.000Z");
  let pool: Pool;
  let repository: NotificationRepository;

  const createNotification = (suffix: string, enqueuePush = true) =>
    repository.createWithPushOutbox(
      {
        userId,
        type: "match",
        title: `title-${suffix}`,
        body: `body-${suffix}`,
        sourceId: `${namespace}-${suffix}`,
      },
      enqueuePush,
    );

  const makeOwnJobsDue = () =>
    pool.query(
      `UPDATE push_outbox
       SET "nextAttemptAt" = $2
       WHERE "notificationId" IN (
         SELECT id FROM notifications WHERE "sourceId" LIKE $1
       )`,
      [`${namespace}-%`, "2001-01-01 00:00:00"],
    );

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
      max: 8,
    });
    repository = new NotificationRepository(drizzle(pool, { schema }));
    await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
      userId,
      `${namespace}@example.test`,
      "hash",
      "notification-user",
      "female",
    ]);
    await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
      otherUserId,
      `${namespace}-other@example.test`,
      "hash",
      "notification-other-user",
      "female",
    ]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications WHERE "sourceId" LIKE $1', [`${namespace}-%`]);
    await pool.query('DELETE FROM push_tokens WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await repository.registerPushToken({ userId, deviceId, token, platform: "ios" });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM notifications WHERE "sourceId" LIKE $1', [`${namespace}-%`]);
    await pool.query('DELETE FROM push_tokens WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM users WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.end();
  });

  it("atomically persists an in-app notification and each current-token job", async () => {
    const notification = await createNotification("atomic");
    const persisted = await pool.query<{ notificationId: string; tokenSnapshot: string }>(
      `SELECT o."notificationId", o."tokenSnapshot"
       FROM push_outbox o
       WHERE o."notificationId" = $1`,
      [notification.id],
    );

    expect(persisted.rows).toEqual([{ notificationId: notification.id, tokenSnapshot: token }]);
  });

  it("preserves only the in-app notification when push enqueueing is disabled", async () => {
    const notification = await createNotification("disabled", false);
    const jobs = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );

    expect(jobs.rows).toEqual([{ count: 0 }]);
  });

  it("keeps queued jobs when the same installation registers idempotently", async () => {
    const notification = await createNotification("register-idempotent");
    const before = await pool.query<{ id: string }>(
      'SELECT id FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );

    await repository.registerPushToken({ userId, deviceId, token, platform: "ios" });

    const after = await pool.query<{ id: string }>(
      'SELECT id FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );
    const jobs = await pool.query<{ pushTokenId: string | null; status: string }>(
      'SELECT "pushTokenId", status FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(jobs.rows).toEqual([{ pushTokenId: before.rows[0]?.id, status: "queued" }]);
  });

  it("moves queued jobs to a rotated token for the same installation", async () => {
    const notification = await createNotification("register-rotated");
    const before = await pool.query<{ id: string }>(
      'SELECT id FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );
    const rotatedToken = `ExpoPushToken[${namespace}-rotated]`;

    await repository.registerPushToken({ userId, deviceId, token: rotatedToken, platform: "ios" });

    const after = await pool.query<{ id: string; token: string }>(
      'SELECT id, token FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );
    const jobs = await pool.query<{ pushTokenId: string | null; status: string; tokenSnapshot: string }>(
      'SELECT "pushTokenId", status, "tokenSnapshot" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );
    expect(after.rows).toEqual([{ id: before.rows[0]?.id, token: rotatedToken }]);
    expect(jobs.rows).toEqual([{ pushTokenId: before.rows[0]?.id, status: "queued", tokenSnapshot: rotatedToken }]);
  });

  it("rejects a foreign token rebind from a different installation without mutating token or jobs", async () => {
    const notification = await createNotification("foreign-rebind");
    const beforeToken = await pool.query<{
      deviceId: string;
      id: string;
      token: string;
      userId: string;
    }>('SELECT id, "userId", "deviceId", token FROM push_tokens WHERE token = $1', [token]);
    const beforeJob = await pool.query<{ pushTokenId: string | null; status: string; tokenSnapshot: string }>(
      'SELECT "pushTokenId", status, "tokenSnapshot" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );

    await expect(
      repository.registerPushToken({
        userId: otherUserId,
        deviceId: otherDeviceId,
        token,
        platform: "android",
      }),
    ).rejects.toThrow("PUSH_TOKEN_DEVICE_CONFLICT");

    const afterToken = await pool.query<{
      deviceId: string;
      id: string;
      token: string;
      userId: string;
    }>('SELECT id, "userId", "deviceId", token FROM push_tokens WHERE token = $1', [token]);
    const afterJob = await pool.query<{ pushTokenId: string | null; status: string; tokenSnapshot: string }>(
      'SELECT "pushTokenId", status, "tokenSnapshot" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );
    expect(afterToken.rows).toEqual(beforeToken.rows);
    expect(afterJob.rows).toEqual(beforeJob.rows);
  });

  it("allows an account switch only from the same stored installation", async () => {
    const notification = await createNotification("account-switch");

    await repository.registerPushToken({ userId: otherUserId, deviceId, token, platform: "ios" });

    const rows = await pool.query<{ deviceId: string; token: string; userId: string }>(
      'SELECT "userId", "deviceId", token FROM push_tokens WHERE token = $1',
      [token],
    );
    const jobs = await pool.query<{ status: string }>('SELECT status FROM push_outbox WHERE "notificationId" = $1', [
      notification.id,
    ]);
    expect(rows.rows).toEqual([{ userId: otherUserId, deviceId, token }]);
    expect(jobs.rows).toEqual([{ status: "cancelled" }]);
  });

  it("claims concurrent bounded batches without overlap and exposes remaining work", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, index) => createNotification(`claim-${index}`)));
    await makeOwnJobsDue();
    const eligible = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM push_outbox o
       JOIN notifications n ON n.id = o."notificationId"
       WHERE n."sourceId" LIKE $1 AND o.status = 'queued' AND o."nextAttemptAt" <= $2`,
      [`${namespace}-%`, claimNow],
    );
    expect(eligible.rows).toEqual([{ count: 5 }]);

    const [first, second] = await Promise.all([
      repository.claimSendBatch({ now: claimNow, leaseExpiresAt: new Date("2001-01-01T01:01:00.000Z"), limit: 2 }),
      repository.claimSendBatch({ now: claimNow, leaseExpiresAt: new Date("2001-01-01T01:01:00.000Z"), limit: 2 }),
    ]);
    const firstIds = new Set(first.jobs.map(({ id }) => id));

    expect(first.jobs).toHaveLength(2);
    expect(second.jobs).toHaveLength(2);
    expect(second.jobs.every(({ id }) => !firstIds.has(id))).toBe(true);
    expect(first.hasMore || second.hasMore).toBe(true);
  });

  it("recovers an expired send lease without waiting for the original due time", async () => {
    const notification = await createNotification("lease");
    await pool.query(
      `UPDATE push_outbox
       SET status = 'sending', "sendAttempts" = 1, "nextAttemptAt" = $2, "leaseExpiresAt" = $3
       WHERE "notificationId" = $1`,
      [notification.id, "2099-01-01 00:00:00", "2001-01-01 00:00:00"],
    );
    const eligible = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM push_outbox
       WHERE "notificationId" = $1 AND status = 'sending' AND "leaseExpiresAt" <= $2`,
      [notification.id, claimNow],
    );
    expect(eligible.rows).toEqual([{ count: 1 }]);
    const claimed = await repository.claimSendBatch({
      now: claimNow,
      leaseExpiresAt: new Date("2001-01-01T01:01:00.000Z"),
      limit: 1,
    });

    expect(claimed.jobs).toHaveLength(1);
    expect(claimed.jobs[0]).toEqual(expect.objectContaining({ notificationId: notification.id, sendAttempts: 2 }));
  });

  it("cancels open jobs and repeatedly succeeds when an installation unregisters", async () => {
    const notification = await createNotification("unregister");

    await expect(repository.unregisterPushToken({ userId, deviceId })).resolves.toBe(true);
    await expect(repository.unregisterPushToken({ userId, deviceId })).resolves.toBe(true);
    const state = await pool.query<{ status: string; pushTokenId: string | null }>(
      'SELECT status, "pushTokenId" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );
    const tokens = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );

    expect(state.rows).toEqual([{ status: "cancelled", pushTokenId: null }]);
    expect(tokens.rows).toEqual([{ count: 0 }]);
  });

  it("rejects a foreign unregister without changing the owner's token or queued job", async () => {
    const notification = await createNotification("foreign-unregister");
    const beforeToken = await pool.query<{ deviceId: string; id: string; token: string; userId: string }>(
      'SELECT id, "userId", "deviceId", token FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );
    const beforeJob = await pool.query<{ pushTokenId: string | null; status: string; tokenSnapshot: string }>(
      'SELECT "pushTokenId", status, "tokenSnapshot" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );

    await expect(repository.unregisterPushToken({ userId: otherUserId, deviceId })).resolves.toBe(false);

    const afterToken = await pool.query<{ deviceId: string; id: string; token: string; userId: string }>(
      'SELECT id, "userId", "deviceId", token FROM push_tokens WHERE "userId" = $1 AND "deviceId" = $2',
      [userId, deviceId],
    );
    const afterJob = await pool.query<{ pushTokenId: string | null; status: string; tokenSnapshot: string }>(
      'SELECT "pushTokenId", status, "tokenSnapshot" FROM push_outbox WHERE "notificationId" = $1',
      [notification.id],
    );
    expect(afterToken.rows).toEqual(beforeToken.rows);
    expect(afterJob.rows).toEqual(beforeJob.rows);
  });

  it("removes an invalid token and cancels its other open jobs", async () => {
    const first = await createNotification("invalid-first");
    await makeOwnJobsDue();
    const firstClaim = await repository.claimSendBatch({
      now: claimNow,
      leaseExpiresAt: new Date("2001-01-01T01:01:00.000Z"),
      limit: 1,
    });
    const [staleJob] = firstClaim.jobs;
    if (!staleJob?.pushTokenId) throw new Error("PUSH_JOB_FIXTURE_REQUIRED");
    const second = await createNotification("invalid-second");
    const recovered = await repository.claimSendBatch({
      now: new Date("2001-01-01T01:02:00.000Z"),
      leaseExpiresAt: new Date("2001-01-01T01:03:00.000Z"),
      limit: 1,
    });
    const [job] = recovered.jobs;
    if (!job?.pushTokenId) throw new Error("RECOVERED_PUSH_JOB_FIXTURE_REQUIRED");

    await repository.applySendResults(
      [
        {
          id: staleJob.id,
          attempt: staleJob.sendAttempts,
          kind: "permanent",
          errorCode: "DeviceNotRegistered",
          invalidatePushTokenId: staleJob.pushTokenId,
        },
      ],
      new Date("2001-01-01T01:02:01.000Z"),
    );
    const staleState = await pool.query<{ sendAttempts: number; status: string }>(
      'SELECT "sendAttempts", status FROM push_outbox WHERE id = $1',
      [job.id],
    );
    const tokenBeforeCurrentResult = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM push_tokens WHERE "userId" = $1',
      [userId],
    );
    expect(staleState.rows).toEqual([{ sendAttempts: 2, status: "sending" }]);
    expect(tokenBeforeCurrentResult.rows).toEqual([{ count: 1 }]);

    await repository.applySendResults(
      [
        {
          id: job.id,
          attempt: job.sendAttempts,
          kind: "permanent",
          errorCode: "DeviceNotRegistered",
          invalidatePushTokenId: job.pushTokenId,
        },
      ],
      claimNow,
    );
    const states = await pool.query<{ notificationId: string; status: string }>(
      `SELECT "notificationId", status
       FROM push_outbox
       WHERE "notificationId" = ANY($1::uuid[])
       ORDER BY "notificationId"`,
      [[first.id, second.id]],
    );
    const tokens = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM push_tokens WHERE "userId" = $1',
      [userId],
    );

    expect(states.rows.map(({ status }) => status).sort()).toEqual(["cancelled", "failed_permanent"]);
    expect(tokens.rows).toEqual([{ count: 0 }]);
  });
});
