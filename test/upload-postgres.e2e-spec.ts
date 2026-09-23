import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import * as schema from "src/modules/database/schema";
import { UploadRepository } from "src/modules/upload/upload.repository";
import { R2ObjectStore } from "src/modules/upload/r2-object-store";
import { UploadService } from "src/modules/upload/upload.service";
import { UserRepository } from "src/modules/user/user.repository";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Verified upload PostgreSQL state", () => {
  const namespace = randomUUID().replaceAll("-", "").slice(0, 12);
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const retryDeletionUserId = randomUUID();
  const deletionUserIds = [randomUUID(), randomUUID()];
  const finalDeletionUserId = randomUUID();
  const finalizeDeletionRaceUserId = randomUUID();
  const finalizeMarkFailureUserId = randomUUID();
  const finalizeUnknownCommitUserId = randomUUID();
  const now = new Date("2026-08-29T00:00:00.000Z");
  const databaseQueries: string[] = [];
  let pool: Pool;
  let uploadRepository: UploadRepository;
  let userRepository: UserRepository;

  const createPending = (
    input: {
      id?: string;
      ownerId?: string;
      expiresAt?: Date;
      contentType?: string;
      sizeBytes?: number;
    } = {},
  ) => {
    const id = input.id ?? randomUUID();
    const ownerId = input.ownerId ?? userId;
    return uploadRepository.createPending({
      id,
      userId: ownerId,
      stagingKey: `profile-staging/${ownerId}/${id}.png`,
      expectedContentType: input.contentType ?? "image/png",
      expectedSizeBytes: input.sizeBytes ?? 68,
      expiresAt: input.expiresAt ?? new Date("2026-08-29T00:05:00.000Z"),
      now,
    });
  };

  const verifyUpload = async (ownerId = userId) => {
    const pending = await createPending({ ownerId });
    const finalKey = `profiles/${ownerId}/${pending.id}.jpg`;
    const publicUrl = `https://images.example.com/${finalKey}`;
    const processingLeaseExpiresAt = new Date("2026-08-29T00:02:00.000Z");
    await uploadRepository.claimFinalize({
      uploadId: pending.id,
      userId: ownerId,
      now,
      leaseExpiresAt: processingLeaseExpiresAt,
    });
    await uploadRepository.prepareFinalObject({
      uploadId: pending.id,
      userId: ownerId,
      finalKey,
      publicUrl,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      processingLeaseExpiresAt,
      now,
    });
    return uploadRepository.markVerified({
      uploadId: pending.id,
      userId: ownerId,
      finalKey,
      publicUrl,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      processingLeaseExpiresAt,
      now,
    });
  };

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
      max: 8,
    });
    const db = drizzle(pool, {
      schema,
      logger: {
        logQuery: (query: string, _params: unknown[]): void => {
          databaseQueries.push(query);
        },
      },
    });
    uploadRepository = new UploadRepository(db);
    userRepository = new UserRepository(db);
    const fixtureUsers = [
      userId,
      otherUserId,
      retryDeletionUserId,
      ...deletionUserIds,
      finalDeletionUserId,
      finalizeDeletionRaceUserId,
      finalizeMarkFailureUserId,
      finalizeUnknownCommitUserId,
    ];
    for (const [index, fixtureUserId] of fixtureUsers.entries()) {
      await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
        fixtureUserId,
        `${namespace}-${index}@example.test`,
        "hash",
        `upload-user-${index}`,
        "female",
      ]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM user_profile_photos WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM profile_uploads WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.query(
      `UPDATE users
       SET "userName" = 'upload-user', intro = '', "profileCompletedAt" = NULL
       WHERE "userId" = ANY($1::uuid[])`,
      [[userId, otherUserId]],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    const allUserIds = [
      userId,
      otherUserId,
      retryDeletionUserId,
      ...deletionUserIds,
      finalDeletionUserId,
      finalizeDeletionRaceUserId,
      finalizeMarkFailureUserId,
      finalizeUnknownCommitUserId,
    ];
    await pool.query('DELETE FROM user_profile_photos WHERE "userId" = ANY($1::uuid[])', [allUserIds]);
    await pool.query('DELETE FROM profile_uploads WHERE "userId" = ANY($1::uuid[])', [allUserIds]);
    await pool.query('DELETE FROM users WHERE "userId" = ANY($1::uuid[])', [allUserIds]);
    await pool.end();
  });

  it("hides upload existence from another owner and leases one finalizer", async () => {
    const pending = await createPending();

    await expect(
      uploadRepository.claimFinalize({
        uploadId: pending.id,
        userId: otherUserId,
        now,
        leaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
      }),
    ).rejects.toThrow("UPLOAD_NOT_FOUND");
    await expect(
      uploadRepository.claimFinalize({
        uploadId: pending.id,
        userId,
        now,
        leaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "claimed" }));
    await expect(
      uploadRepository.claimFinalize({
        uploadId: pending.id,
        userId,
        now: new Date("2026-08-29T00:01:00.000Z"),
        leaseExpiresAt: new Date("2026-08-29T00:03:00.000Z"),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "busy" }));
  });

  it("recovers an expired processing lease and returns verification idempotently", async () => {
    const pending = await createPending();
    await uploadRepository.claimFinalize({
      uploadId: pending.id,
      userId,
      now,
      leaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
    });

    await expect(
      uploadRepository.claimFinalize({
        uploadId: pending.id,
        userId,
        now: new Date("2026-08-29T00:01:01.000Z"),
        leaseExpiresAt: new Date("2026-08-29T00:03:01.000Z"),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "claimed" }));
    await uploadRepository.markFailed({
      uploadId: pending.id,
      failureCode: "STALE_WORKER",
      processingLeaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
      now: new Date("2026-08-29T00:01:02.000Z"),
    });
    await uploadRepository.releaseFinalizeLease({
      uploadId: pending.id,
      processingLeaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
      now: new Date("2026-08-29T00:01:02.000Z"),
    });
    const finalKey = `profiles/${userId}/${pending.id}.jpg`;
    const publicUrl = `https://images.example.com/${finalKey}`;
    const recoveredLeaseExpiresAt = new Date("2026-08-29T00:03:01.000Z");
    await uploadRepository.prepareFinalObject({
      uploadId: pending.id,
      userId,
      finalKey,
      publicUrl,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      processingLeaseExpiresAt: recoveredLeaseExpiresAt,
      now: new Date("2026-08-29T00:01:02.000Z"),
    });
    await expect(
      uploadRepository.markVerified({
        uploadId: pending.id,
        userId,
        finalKey,
        publicUrl,
        finalContentType: "image/jpeg",
        finalSizeBytes: 299,
        processingLeaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
        now: new Date("2026-08-29T00:01:02.000Z"),
      }),
    ).rejects.toThrow("UPLOAD_STATE_CONFLICT");
    const verified = await uploadRepository.markVerified({
      uploadId: pending.id,
      userId,
      finalKey,
      publicUrl,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      processingLeaseExpiresAt: recoveredLeaseExpiresAt,
      now: new Date("2026-08-29T00:01:02.000Z"),
    });
    await expect(
      uploadRepository.claimFinalize({
        uploadId: pending.id,
        userId,
        now: new Date("2026-08-29T00:01:03.000Z"),
        leaseExpiresAt: new Date("2026-08-29T00:03:03.000Z"),
      }),
    ).resolves.toEqual({ kind: "verified", upload: verified });
  });

  it("claims cleanup rows concurrently without overlap and recovers cleanup leases", async () => {
    const expired = new Date("2026-08-28T00:00:00.000Z");
    await Promise.all(Array.from({ length: 3 }, () => createPending({ expiresAt: expired })));

    const [first, second] = await Promise.all([
      uploadRepository.claimCleanupBatch({
        now,
        leaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
        limit: 1,
      }),
      uploadRepository.claimCleanupBatch({
        now,
        leaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
        limit: 1,
      }),
    ]);

    expect(first.jobs).toHaveLength(1);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]?.id).not.toBe(first.jobs[0]?.id);
    expect(first.hasMore || second.hasMore).toBe(true);
    const recovered = await uploadRepository.claimCleanupBatch({
      now: new Date("2026-08-29T00:01:01.000Z"),
      leaseExpiresAt: new Date("2026-08-29T00:02:01.000Z"),
      limit: 3,
    });
    expect(recovered.jobs).toHaveLength(3);
  });

  it("atomically enforces the active upload cap under concurrent creates", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createPending()));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(expect.objectContaining({ message: "UPLOAD_ACTIVE_LIMIT_EXCEEDED" }));
    const persisted = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM profile_uploads WHERE "userId" = $1',
      [userId],
    );
    expect(persisted.rows).toEqual([{ count: 5 }]);
  });

  it("does not count expired or completed rows toward the active upload cap", async () => {
    const expired = await Promise.all(
      Array.from({ length: 3 }, () => createPending({ expiresAt: new Date("2026-08-28T00:00:00.000Z") })),
    );
    const completed = await Promise.all(Array.from({ length: 2 }, () => createPending()));
    await pool.query(
      `UPDATE profile_uploads
       SET status = 'failed', "failureCode" = 'TEST_COMPLETED'
       WHERE id = ANY($1::uuid[])`,
      [completed.map(({ id }) => id)],
    );

    const active = await Promise.all(Array.from({ length: 5 }, () => createPending()));

    expect(expired).toHaveLength(3);
    expect(active).toHaveLength(5);
  });

  it("rejects impossible final deletion state combinations at the database boundary", async () => {
    const pending = await createPending();

    await expect(
      pool.query('UPDATE profile_uploads SET "finalDeletedAt" = $2 WHERE id = $1', [pending.id, now]),
    ).rejects.toThrow("profile_uploads_final_deletion_state_check");
    await expect(
      pool.query('UPDATE profile_uploads SET "finalDeletionPendingAt" = $2 WHERE id = $1', [pending.id, now]),
    ).rejects.toThrow("profile_uploads_final_deletion_state_check");
  });

  it("enforces a rolling create quota while allowing rows outside the window", async () => {
    for (let index = 0; index < 20; index += 1) {
      const created = await createPending();
      await pool.query(
        `UPDATE profile_uploads
         SET status = 'failed', "failureCode" = 'TEST_COMPLETED'
         WHERE id = $1`,
        [created.id],
      );
    }

    await expect(createPending()).rejects.toThrow("UPLOAD_RATE_LIMIT_EXCEEDED");
    await pool.query(
      `UPDATE profile_uploads
       SET "createdAt" = $2
       WHERE "userId" = $1`,
      [userId, "2026-08-28 22:59:59"],
    );
    await expect(createPending()).resolves.toEqual(expect.objectContaining({ status: "pending" }));
  });

  it("bounds the quota query scan to the rolling createdAt window", async () => {
    const historical = await createPending();
    await pool.query(
      `UPDATE profile_uploads
       SET status = 'failed', "failureCode" = 'TEST_HISTORY', "createdAt" = $2
       WHERE id = $1`,
      [historical.id, "2025-08-29 00:00:00"],
    );
    databaseQueries.length = 0;

    await expect(createPending()).resolves.toEqual(expect.objectContaining({ status: "pending" }));

    const quotaQuery = databaseQueries.find((query) => query.includes("count(*) FILTER"));
    if (!quotaQuery) throw new Error("UPLOAD_QUOTA_QUERY_REQUIRED");
    const whereClause = quotaQuery.slice(quotaQuery.lastIndexOf(" where ") + 7);
    expect(whereClause).toMatch(
      /^\("profile_uploads"\."userId" = \$\d+ and "profile_uploads"\."createdAt" >= \$\d+\)$/,
    );
  });

  it("atomically replaces a profile only with verified uploads owned by that user", async () => {
    const first = await verifyUpload(userId);
    const second = await verifyUpload(userId);
    const foreign = await verifyUpload(otherUserId);
    const profileInput = {
      userId,
      userName: "verified-profile",
      birthDate: "1998-01-01",
      region: "서울",
      interestedGender: "everyone" as const,
      intro: "verified",
      photoUploadIds: [second.id, first.id],
    };

    const profile = await userRepository.replaceProfile(profileInput);
    expect(profile.photos.map(({ uploadId, url, position }) => ({ uploadId, url, position }))).toEqual([
      { uploadId: second.id, url: second.publicUrl, position: 0 },
      { uploadId: first.id, url: first.publicUrl, position: 1 },
    ]);
    await expect(
      userRepository.replaceProfile({
        ...profileInput,
        userName: "must-rollback",
        photoUploadIds: [first.id, foreign.id],
      }),
    ).rejects.toThrow("PROFILE_PHOTO_UPLOAD_INVALID");
    const persisted = await pool.query<{ userName: string; uploadId: string }>(
      `SELECT u."userName", p."uploadId"
       FROM users u
       JOIN user_profile_photos p ON p."userId" = u."userId"
       WHERE u."userId" = $1
       ORDER BY p.position`,
      [userId],
    );
    expect(persisted.rows).toEqual([
      { userName: "verified-profile", uploadId: second.id },
      { userName: "verified-profile", uploadId: first.id },
    ]);
  });

  it("preserves an owned legacy photo identity but rejects a foreign legacy identity atomically", async () => {
    const verified = await verifyUpload(userId);
    const ownLegacy = await pool.query<{ id: string; url: string }>(
      `INSERT INTO user_profile_photos ("userId", url, position)
       VALUES ($1, $2, 0)
       RETURNING id, url`,
      [userId, `https://legacy.example.com/${userId}.jpg`],
    );
    const foreignLegacy = await pool.query<{ id: string }>(
      `INSERT INTO user_profile_photos ("userId", url, position)
       VALUES ($1, $2, 0)
       RETURNING id`,
      [otherUserId, `https://legacy.example.com/${otherUserId}.jpg`],
    );
    const ownLegacyPhoto = ownLegacy.rows[0];
    const foreignLegacyPhoto = foreignLegacy.rows[0];
    if (!ownLegacyPhoto || !foreignLegacyPhoto) throw new Error("LEGACY_PHOTO_FIXTURE_REQUIRED");
    const profileInput = {
      userId,
      userName: "legacy-preserved",
      birthDate: "1998-01-01",
      region: "서울",
      interestedGender: "everyone" as const,
      intro: "legacy",
      photoUploadIds: [ownLegacyPhoto.id, verified.id],
    };

    const profile = await userRepository.replaceProfile(profileInput);
    expect(profile.photos.map(({ id, uploadId, url }) => ({ id, uploadId, url }))).toEqual([
      { id: ownLegacyPhoto.id, uploadId: null, url: ownLegacyPhoto.url },
      { id: expect.any(String), uploadId: verified.id, url: verified.publicUrl },
    ]);
    await expect(
      userRepository.replaceProfile({
        ...profileInput,
        userName: "must-rollback",
        photoUploadIds: [foreignLegacyPhoto.id, verified.id],
      }),
    ).rejects.toThrow("PROFILE_PHOTO_UPLOAD_INVALID");
    const persisted = await pool.query<{ id: string; uploadId: string | null; userName: string }>(
      `SELECT p.id, p."uploadId", u."userName"
       FROM user_profile_photos p
       JOIN users u ON u."userId" = p."userId"
       WHERE p."userId" = $1
       ORDER BY p.position`,
      [userId],
    );
    expect(persisted.rows).toEqual([
      { id: ownLegacyPhoto.id, uploadId: null, userName: "legacy-preserved" },
      { id: expect.any(String), uploadId: verified.id, userName: "legacy-preserved" },
    ]);
  });

  it("keeps the first account deletion deadline when scheduling is retried", async () => {
    const firstDeadline = new Date("2026-09-12T00:00:00.000Z");

    await expect(userRepository.scheduleDeletion(retryDeletionUserId, firstDeadline)).resolves.toEqual(firstDeadline);
    await expect(
      userRepository.scheduleDeletion(retryDeletionUserId, new Date("2026-09-13T00:00:00.000Z")),
    ).resolves.toEqual(firstDeadline);
  });

  it("claims due account deletion rows once and requires the active lease for anonymization", async () => {
    for (const deletionUserId of deletionUserIds) {
      await userRepository.scheduleDeletion(deletionUserId, new Date("2026-08-28T00:00:00.000Z"));
    }
    const [first, second] = await Promise.all([
      userRepository.claimDueDeletionBatch({
        now,
        leaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
        limit: 1,
      }),
      userRepository.claimDueDeletionBatch({
        now,
        leaseExpiresAt: new Date("2026-08-29T00:05:00.000Z"),
        limit: 1,
      }),
    ]);
    expect(first.jobs).toHaveLength(1);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]?.userId).not.toBe(first.jobs[0]?.userId);
    const claimedJob = first.jobs[0];
    if (!claimedJob) throw new Error("DELETION_CLAIM_FIXTURE_REQUIRED");

    await userRepository.anonymizeDeletedAccount({ ...claimedJob, now });
    const deleted = await pool.query<{ deletedAt: Date | null; deletionLeaseExpiresAt: Date | null }>(
      'SELECT "deletedAt", "deletionLeaseExpiresAt" FROM users WHERE "userId" = $1',
      [claimedJob.userId],
    );
    expect(deleted.rows[0]?.deletedAt).toBeInstanceOf(Date);
    expect(deleted.rows[0]?.deletionLeaseExpiresAt).toBeNull();

    const staleJob = second.jobs[0];
    if (!staleJob) throw new Error("STALE_DELETION_FIXTURE_REQUIRED");
    const recovered = await userRepository.claimDueDeletionBatch({
      now: new Date("2026-08-29T00:05:01.000Z"),
      leaseExpiresAt: new Date("2026-08-29T00:10:01.000Z"),
      limit: 1,
    });
    const recoveredJob = recovered.jobs[0];
    if (!recoveredJob) throw new Error("RECOVERED_DELETION_FIXTURE_REQUIRED");
    await expect(
      userRepository.anonymizeDeletedAccount({ ...staleJob, now: new Date("2026-08-29T00:05:01.000Z") }),
    ).rejects.toThrow("ACCOUNT_DELETION_CLAIM_REQUIRED");
    await userRepository.releaseDeletionLease({ ...staleJob, now: new Date("2026-08-29T00:05:01.000Z") });
    const lease = await pool.query<{ leasePresent: boolean }>(
      'SELECT "deletionLeaseExpiresAt" IS NOT NULL AS "leasePresent" FROM users WHERE "userId" = $1',
      [recoveredJob.userId],
    );
    expect(lease.rows).toEqual([{ leasePresent: true }]);
    await userRepository.anonymizeDeletedAccount({ ...recoveredJob, now: new Date("2026-08-29T00:05:02.000Z") });
  });

  it("durably discovers and cleans a final object after the verification database write fails", async () => {
    const inputBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .png()
      .toBuffer();
    const pending = await createPending({
      ownerId: finalizeMarkFailureUserId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      sizeBytes: inputBytes.byteLength,
    });
    const objectStore = new R2ObjectStore(new ConfigService({}));
    jest.spyOn(objectStore, "readStagingObject").mockResolvedValue(inputBytes);
    const putFinalObject = jest.spyOn(objectStore, "putFinalObject").mockResolvedValue(undefined);
    const deleteObject = jest.spyOn(objectStore, "deleteObject").mockResolvedValue(undefined);
    const markVerified = jest
      .spyOn(uploadRepository, "markVerified")
      .mockRejectedValueOnce(new Error("DATABASE_WRITE_UNAVAILABLE"));
    const uploadService = new UploadService(
      uploadRepository,
      objectStore,
      new ConfigService({ R2_PUBLIC_BASE_URL: "https://images.example.com" }),
    );

    await expect(uploadService.finalizeUpload(finalizeMarkFailureUserId, pending.id)).rejects.toThrow(
      "DATABASE_WRITE_UNAVAILABLE",
    );
    markVerified.mockRestore();
    const finalWrite = putFinalObject.mock.calls[0]?.[0];
    if (!finalWrite) throw new Error("FINAL_WRITE_FIXTURE_REQUIRED");
    const prepared = await pool.query<{
      cleanupLeaseExpiresAt: Date | null;
      finalDeletionPendingAt: Date | null;
      finalKey: string | null;
      processingLeaseExpiresAt: Date | null;
      status: string;
    }>(
      `SELECT status, "finalKey", "finalDeletionPendingAt", "processingLeaseExpiresAt", "cleanupLeaseExpiresAt"
       FROM profile_uploads
       WHERE id = $1`,
      [pending.id],
    );
    expect(prepared.rows).toEqual([
      {
        status: "processing",
        finalKey: finalWrite.key,
        finalDeletionPendingAt: expect.any(Date),
        processingLeaseExpiresAt: expect.any(Date),
        cleanupLeaseExpiresAt: expect.any(Date),
      },
    ]);
    const cleanupNow = new Date(Date.now() + 3 * 60 * 1000);

    await expect(uploadService.cleanupExpiredStagingBatch({ now: cleanupNow, limit: 100 })).resolves.toEqual(
      expect.objectContaining({ claimed: 1, succeeded: 1 }),
    );
    expect(deleteObject).toHaveBeenCalledWith(pending.stagingKey);
    expect(deleteObject).toHaveBeenCalledWith(finalWrite.key);
    const cleaned = await pool.query<{
      finalDeletedAt: Date | null;
      finalKey: string | null;
      publicUrl: string | null;
    }>('SELECT "finalDeletedAt", "finalKey", "publicUrl" FROM profile_uploads WHERE id = $1', [pending.id]);
    expect(cleaned.rows).toEqual([{ finalDeletedAt: expect.any(Date), finalKey: null, publicUrl: null }]);
  });

  it("fences cleanup until an in-flight final write finishes after account anonymization", async () => {
    const inputBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 80, g: 100, b: 120 } },
    })
      .png()
      .toBuffer();
    const pending = await createPending({
      ownerId: finalizeDeletionRaceUserId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      sizeBytes: inputBytes.byteLength,
    });
    const putStarted = createDeferred();
    const allowPut = createDeferred();
    const objectStore = new R2ObjectStore(new ConfigService({}));
    jest.spyOn(objectStore, "readStagingObject").mockResolvedValue(inputBytes);
    const putFinalObject = jest.spyOn(objectStore, "putFinalObject").mockImplementation(async () => {
      putStarted.resolve();
      await allowPut.promise;
    });
    const deleteObject = jest.spyOn(objectStore, "deleteObject").mockResolvedValue(undefined);
    const uploadService = new UploadService(
      uploadRepository,
      objectStore,
      new ConfigService({ R2_PUBLIC_BASE_URL: "https://images.example.com" }),
    );
    const finalize = uploadService.finalizeUpload(finalizeDeletionRaceUserId, pending.id);
    await putStarted.promise;
    const finalWrite = putFinalObject.mock.calls[0]?.[0];
    if (!finalWrite) throw new Error("FINAL_WRITE_FIXTURE_REQUIRED");
    const deletionNow = new Date();
    const deletionLeaseExpiresAt = new Date(deletionNow.getTime() + 5 * 60 * 1000);
    await userRepository.scheduleDeletion(finalizeDeletionRaceUserId, new Date(deletionNow.getTime() - 1000));
    const deletionClaims = await userRepository.claimDueDeletionBatch({
      now: deletionNow,
      leaseExpiresAt: deletionLeaseExpiresAt,
      limit: 100,
    });
    const deletionClaim = deletionClaims.jobs.find(
      ({ userId: claimedUserId }) => claimedUserId === finalizeDeletionRaceUserId,
    );
    if (!deletionClaim) throw new Error("ACCOUNT_DELETION_CLAIM_FIXTURE_REQUIRED");

    await userRepository.anonymizeDeletedAccount({
      ...deletionClaim,
      now: deletionNow,
    });
    const deletedOwnerState = await pool.query<{
      cleanupLeaseExpiresAt: Date | null;
      finalDeletionPendingAt: Date | null;
      finalKey: string | null;
      status: string;
    }>(
      `SELECT status, "finalKey", "finalDeletionPendingAt", "cleanupLeaseExpiresAt"
       FROM profile_uploads
       WHERE id = $1`,
      [pending.id],
    );
    expect(deletedOwnerState.rows).toEqual([
      {
        status: "failed",
        finalKey: finalWrite.key,
        finalDeletionPendingAt: expect.any(Date),
        cleanupLeaseExpiresAt: expect.any(Date),
      },
    ]);
    await uploadService.cleanupExpiredStagingBatch({ now: deletionNow, limit: 100 });
    expect(deleteObject).not.toHaveBeenCalledWith(pending.stagingKey);
    expect(deleteObject).not.toHaveBeenCalledWith(finalWrite.key);

    allowPut.resolve();
    await expect(finalize).rejects.toThrow("UPLOAD_STATE_CONFLICT");
    await uploadService.cleanupExpiredStagingBatch({
      now: new Date(deletionNow.getTime() + 3 * 60 * 1000),
      limit: 100,
    });
    expect(deleteObject).toHaveBeenCalledWith(pending.stagingKey);
    expect(deleteObject).toHaveBeenCalledWith(finalWrite.key);
    const cleaned = await pool.query<{ finalDeletedAt: Date | null; finalKey: string | null }>(
      'SELECT "finalDeletedAt", "finalKey" FROM profile_uploads WHERE id = $1',
      [pending.id],
    );
    expect(cleaned.rows).toEqual([{ finalDeletedAt: expect.any(Date), finalKey: null }]);
  });

  it("does not compensate a final object when verification committed before the client observed failure", async () => {
    const inputBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 140, g: 160, b: 180 } },
    })
      .png()
      .toBuffer();
    const pending = await createPending({
      ownerId: finalizeUnknownCommitUserId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      sizeBytes: inputBytes.byteLength,
    });
    const markStarted = createDeferred();
    const allowMark = createDeferred();
    const objectStore = new R2ObjectStore(new ConfigService({}));
    jest.spyOn(objectStore, "readStagingObject").mockResolvedValue(inputBytes);
    const putFinalObject = jest.spyOn(objectStore, "putFinalObject").mockResolvedValue(undefined);
    const deleteObject = jest.spyOn(objectStore, "deleteObject").mockResolvedValue(undefined);
    const committedMarkVerified = uploadRepository.markVerified.bind(uploadRepository);
    const markVerified = jest.spyOn(uploadRepository, "markVerified").mockImplementation(async (input) => {
      markStarted.resolve();
      await allowMark.promise;
      await committedMarkVerified(input);
      throw new Error("DATABASE_COMMIT_OUTCOME_UNKNOWN");
    });
    const uploadService = new UploadService(
      uploadRepository,
      objectStore,
      new ConfigService({ R2_PUBLIC_BASE_URL: "https://images.example.com" }),
    );
    const finalize = uploadService.finalizeUpload(finalizeUnknownCommitUserId, pending.id);
    await markStarted.promise;
    const finalWrite = putFinalObject.mock.calls[0]?.[0];
    if (!finalWrite) throw new Error("FINAL_WRITE_FIXTURE_REQUIRED");
    let intermediateAssertion: unknown;
    try {
      const prepared = await pool.query<{
        finalDeletionPendingAt: Date | null;
        finalKey: string | null;
        status: string;
      }>('SELECT status, "finalKey", "finalDeletionPendingAt" FROM profile_uploads WHERE id = $1', [pending.id]);
      expect(prepared.rows).toEqual([
        { status: "processing", finalKey: finalWrite.key, finalDeletionPendingAt: expect.any(Date) },
      ]);
    } catch (error) {
      intermediateAssertion = error;
    } finally {
      allowMark.resolve();
      await finalize.catch(() => undefined);
      markVerified.mockRestore();
    }
    if (intermediateAssertion) throw intermediateAssertion;

    const verified = await pool.query<{
      finalDeletionPendingAt: Date | null;
      finalKey: string | null;
      status: string;
    }>('SELECT status, "finalKey", "finalDeletionPendingAt" FROM profile_uploads WHERE id = $1', [pending.id]);
    expect(verified.rows).toEqual([{ status: "verified", finalKey: finalWrite.key, finalDeletionPendingAt: null }]);
    await uploadService.cleanupExpiredStagingBatch({ now: new Date(Date.now() + 20 * 60 * 1000), limit: 100 });
    expect(deleteObject).toHaveBeenCalledWith(pending.stagingKey);
    expect(deleteObject).not.toHaveBeenCalledWith(finalWrite.key);
    const retained = await pool.query<{ finalKey: string | null }>(
      'SELECT "finalKey" FROM profile_uploads WHERE id = $1',
      [pending.id],
    );
    expect(retained.rows).toEqual([{ finalKey: finalWrite.key }]);
  });

  it("durably cleans staging-only and finalized uploads after account anonymization", async () => {
    const stagingOnly = await createPending({ ownerId: finalDeletionUserId });
    const verified = await verifyUpload(finalDeletionUserId);
    await pool.query(
      `INSERT INTO user_profile_photos ("userId", "uploadId", url, position)
       VALUES ($1, $2, $3, 0)`,
      [finalDeletionUserId, verified.id, verified.publicUrl],
    );
    const deletionLeaseExpiresAt = new Date("2026-08-29T00:05:00.000Z");
    await pool.query(
      `UPDATE users
       SET "deletionScheduledAt" = $2, "deletionLeaseExpiresAt" = $3
       WHERE "userId" = $1`,
      [finalDeletionUserId, "2026-08-28 00:00:00", "2026-08-29 00:05:00"],
    );

    await userRepository.anonymizeDeletedAccount({ userId: finalDeletionUserId, deletionLeaseExpiresAt, now });

    const state = await pool.query<{
      failureCode: string | null;
      finalDeletionPendingAt: Date | null;
      finalKey: string | null;
      id: string;
      publicUrl: string | null;
      status: string;
    }>(
      `SELECT id, status, "failureCode", "finalKey", "publicUrl", "finalDeletionPendingAt"
       FROM profile_uploads
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[stagingOnly.id, verified.id]],
    );
    expect(state.rows.find(({ id }) => id === stagingOnly.id)).toEqual({
      id: stagingOnly.id,
      status: "failed",
      failureCode: "UPLOAD_OWNER_DELETED",
      finalKey: null,
      publicUrl: null,
      finalDeletionPendingAt: null,
    });
    expect(state.rows.find(({ id }) => id === verified.id)).toEqual({
      id: verified.id,
      status: "failed",
      failureCode: "UPLOAD_OWNER_DELETED",
      finalKey: verified.finalKey,
      publicUrl: verified.publicUrl,
      finalDeletionPendingAt: expect.any(Date),
    });

    const objectStore = new R2ObjectStore(new ConfigService({}));
    let failedFinalDelete = false;
    const deleteObject = jest.spyOn(objectStore, "deleteObject").mockImplementation(async (key) => {
      if (key === verified.finalKey && !failedFinalDelete) {
        failedFinalDelete = true;
        throw new Error("R2 unavailable");
      }
    });
    const uploadService = new UploadService(uploadRepository, objectStore, new ConfigService({}));
    await expect(uploadService.cleanupExpiredStagingBatch({ now, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retryScheduled: 1,
      permanentlyFailed: 0,
      hasMore: false,
    });
    expect(deleteObject).toHaveBeenCalledWith(stagingOnly.stagingKey);
    expect(deleteObject).toHaveBeenCalledWith(verified.stagingKey);
    expect(deleteObject).toHaveBeenCalledWith(verified.finalKey);
    const retryState = await pool.query<{
      finalDeletedAt: Date | null;
      finalKey: string | null;
      id: string;
      publicUrl: string | null;
      stagingDeletedAt: Date | null;
    }>(
      `SELECT id, "stagingDeletedAt", "finalDeletedAt", "finalKey", "publicUrl"
       FROM profile_uploads
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[stagingOnly.id, verified.id]],
    );
    expect(retryState.rows.find(({ id }) => id === stagingOnly.id)).toEqual({
      id: stagingOnly.id,
      stagingDeletedAt: expect.any(Date),
      finalDeletedAt: null,
      finalKey: null,
      publicUrl: null,
    });
    expect(retryState.rows.find(({ id }) => id === verified.id)).toEqual({
      id: verified.id,
      stagingDeletedAt: expect.any(Date),
      finalDeletedAt: null,
      finalKey: verified.finalKey,
      publicUrl: verified.publicUrl,
    });

    await expect(
      uploadService.cleanupExpiredStagingBatch({ now: new Date("2026-08-29T00:00:31.000Z"), limit: 1 }),
    ).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      retryScheduled: 0,
      permanentlyFailed: 0,
      hasMore: false,
    });
    const deleted = await pool.query<{
      finalDeletedAt: Date | null;
      finalKey: string | null;
      publicUrl: string | null;
    }>(
      `SELECT "finalDeletedAt", "finalKey", "publicUrl"
       FROM profile_uploads
       WHERE id = $1`,
      [verified.id],
    );
    expect(deleted.rows).toEqual([{ finalDeletedAt: expect.any(Date), finalKey: null, publicUrl: null }]);
    expect(deleteObject.mock.calls.filter(([key]) => key === verified.finalKey)).toHaveLength(2);
  });
});

const createDeferred = () => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      if (!resolvePromise) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise();
    },
  };
};
