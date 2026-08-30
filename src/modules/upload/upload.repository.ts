import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { profileUploads } from "src/modules/database/schema";
import { CleanupUploadClaim, FinalizeUploadClaim } from "./upload-state.types";

@Injectable()
export class UploadRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  createPending = async (input: {
    id: string;
    userId: string;
    stagingKey: string;
    expectedContentType: string;
    expectedSizeBytes: number;
    expiresAt: Date;
    now: Date;
  }) => {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-create:${input.userId}`}, 0))`);
      const cutoff = new Date(input.now.getTime() - UPLOAD_CREATE_WINDOW_MS);
      const [counts] = await tx
        .select({
          active: sql<number>`count(*) FILTER (
            WHERE ${inArray(profileUploads.status, ["pending", "processing"])}
              AND ${gt(profileUploads.expiresAt, input.now)}
          )::int`,
          recent: sql<number>`count(*) FILTER (WHERE ${gte(profileUploads.createdAt, cutoff)})::int`,
        })
        .from(profileUploads)
        .where(and(eq(profileUploads.userId, input.userId), gte(profileUploads.createdAt, cutoff)));
      if (!counts) throw new Error("UPLOAD_QUOTA_CHECK_FAILED");
      const activeCount = Number(counts.active);
      const recentCount = Number(counts.recent);
      if (!Number.isSafeInteger(activeCount) || !Number.isSafeInteger(recentCount)) {
        throw new Error("UPLOAD_QUOTA_CHECK_FAILED");
      }
      if (activeCount >= MAX_ACTIVE_UPLOADS_PER_USER) {
        throw new HttpException("UPLOAD_ACTIVE_LIMIT_EXCEEDED", HttpStatus.TOO_MANY_REQUESTS);
      }
      if (recentCount >= MAX_UPLOAD_CREATES_PER_WINDOW) {
        throw new HttpException("UPLOAD_RATE_LIMIT_EXCEEDED", HttpStatus.TOO_MANY_REQUESTS);
      }
      const [upload] = await tx
        .insert(profileUploads)
        .values({
          id: input.id,
          userId: input.userId,
          stagingKey: input.stagingKey,
          expectedContentType: input.expectedContentType,
          expectedSizeBytes: input.expectedSizeBytes,
          expiresAt: input.expiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (!upload) throw new Error("UPLOAD_CREATE_FAILED");
      return upload;
    });
  };

  claimFinalize = (input: {
    uploadId: string;
    userId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<FinalizeUploadClaim> =>
    this.db.transaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(profileUploads)
        .where(and(eq(profileUploads.id, input.uploadId), eq(profileUploads.userId, input.userId)))
        .for("update");
      if (!upload) throw new Error("UPLOAD_NOT_FOUND");
      if (upload.status === "verified") return { kind: "verified", upload };
      if (upload.status === "failed") throw new Error(upload.failureCode ?? "UPLOAD_FINALIZE_FAILED");
      if (upload.expiresAt.getTime() <= input.now.getTime()) {
        const [expired] = await tx
          .update(profileUploads)
          .set({
            status: "failed",
            failureCode: "UPLOAD_EXPIRED",
            processingLeaseExpiresAt: null,
            updatedAt: input.now,
          })
          .where(eq(profileUploads.id, upload.id))
          .returning();
        if (!expired) throw new Error("UPLOAD_STATE_CONFLICT");
        return { kind: "expired", upload: expired };
      }
      if (
        upload.status === "processing" &&
        upload.processingLeaseExpiresAt &&
        upload.processingLeaseExpiresAt.getTime() > input.now.getTime()
      ) {
        return { kind: "busy", upload };
      }
      const [claimed] = await tx
        .update(profileUploads)
        .set({
          status: "processing",
          processingLeaseExpiresAt: input.leaseExpiresAt,
          cleanupLeaseExpiresAt: sql`CASE
            WHEN ${profileUploads.finalDeletionPendingAt} IS NOT NULL THEN ${input.leaseExpiresAt}
            ELSE ${profileUploads.cleanupLeaseExpiresAt}
          END`,
          updatedAt: input.now,
        })
        .where(eq(profileUploads.id, upload.id))
        .returning();
      if (!claimed) throw new Error("UPLOAD_STATE_CONFLICT");
      return { kind: "claimed", upload: claimed };
    });

  prepareFinalObject = async (input: {
    uploadId: string;
    userId: string;
    finalKey: string;
    publicUrl: string;
    finalContentType: string;
    finalSizeBytes: number;
    processingLeaseExpiresAt: Date;
    now: Date;
  }): Promise<void> => {
    const [prepared] = await this.db
      .update(profileUploads)
      .set({
        finalKey: input.finalKey,
        publicUrl: input.publicUrl,
        finalContentType: input.finalContentType,
        finalSizeBytes: input.finalSizeBytes,
        finalDeletionPendingAt: sql`COALESCE(${profileUploads.finalDeletionPendingAt}, ${input.now})`,
        finalDeletedAt: null,
        cleanupLeaseExpiresAt: input.processingLeaseExpiresAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(profileUploads.id, input.uploadId),
          eq(profileUploads.userId, input.userId),
          eq(profileUploads.status, "processing"),
          eq(profileUploads.processingLeaseExpiresAt, input.processingLeaseExpiresAt),
          or(isNull(profileUploads.finalKey), eq(profileUploads.finalKey, input.finalKey)),
          isNull(profileUploads.finalDeletedAt),
        ),
      )
      .returning({ id: profileUploads.id });
    if (!prepared) throw new Error("UPLOAD_STATE_CONFLICT");
  };

  markVerified = async (input: {
    uploadId: string;
    userId: string;
    finalKey: string;
    publicUrl: string;
    finalContentType: string;
    finalSizeBytes: number;
    processingLeaseExpiresAt: Date;
    now: Date;
  }) => {
    const [upload] = await this.db
      .update(profileUploads)
      .set({
        status: "verified",
        finalKey: input.finalKey,
        publicUrl: input.publicUrl,
        finalContentType: input.finalContentType,
        finalSizeBytes: input.finalSizeBytes,
        verifiedAt: input.now,
        processingLeaseExpiresAt: null,
        cleanupLeaseExpiresAt: null,
        finalDeletionPendingAt: null,
        finalDeletedAt: null,
        failureCode: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(profileUploads.id, input.uploadId),
          eq(profileUploads.userId, input.userId),
          eq(profileUploads.status, "processing"),
          eq(profileUploads.processingLeaseExpiresAt, input.processingLeaseExpiresAt),
          eq(profileUploads.finalKey, input.finalKey),
          isNotNull(profileUploads.finalDeletionPendingAt),
        ),
      )
      .returning();
    if (upload) return upload;
    const existing = await this.db.query.profileUploads.findFirst({
      where: and(eq(profileUploads.id, input.uploadId), eq(profileUploads.userId, input.userId)),
    });
    if (existing?.status === "verified" && existing.finalKey === input.finalKey) return existing;
    throw new Error("UPLOAD_STATE_CONFLICT");
  };

  markFailed = async (input: {
    uploadId: string;
    failureCode: string;
    processingLeaseExpiresAt: Date;
    now: Date;
  }): Promise<void> => {
    await this.db
      .update(profileUploads)
      .set({
        status: "failed",
        failureCode: input.failureCode,
        processingLeaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(profileUploads.id, input.uploadId),
          eq(profileUploads.status, "processing"),
          eq(profileUploads.processingLeaseExpiresAt, input.processingLeaseExpiresAt),
        ),
      );
  };

  releaseFinalizeLease = async (input: {
    uploadId: string;
    processingLeaseExpiresAt: Date;
    now: Date;
  }): Promise<void> => {
    await this.db
      .update(profileUploads)
      .set({ status: "pending", processingLeaseExpiresAt: null, updatedAt: input.now })
      .where(
        and(
          eq(profileUploads.id, input.uploadId),
          eq(profileUploads.status, "processing"),
          eq(profileUploads.processingLeaseExpiresAt, input.processingLeaseExpiresAt),
        ),
      );
  };

  markStagingDeleted = async (uploadId: string, now: Date): Promise<void> => {
    await this.db
      .update(profileUploads)
      .set({ stagingDeletedAt: now, cleanupLeaseExpiresAt: null, updatedAt: now })
      .where(eq(profileUploads.id, uploadId));
  };

  claimCleanupBatch = (input: { now: Date; leaseExpiresAt: Date; limit: number }): Promise<CleanupUploadClaim> =>
    this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(profileUploads)
        .where(cleanupDue(input.now))
        .orderBy(
          asc(profileUploads.finalDeletionPendingAt),
          asc(profileUploads.expiresAt),
          asc(profileUploads.createdAt),
          asc(profileUploads.id),
        )
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const selected = candidates;
      if (selected.length === 0) return { jobs: [], hasMore: false };
      const jobs = await tx
        .update(profileUploads)
        .set({
          status: sql`CASE WHEN ${profileUploads.status} IN ('pending', 'processing') THEN 'failed' ELSE ${profileUploads.status} END`,
          failureCode: sql`CASE WHEN ${profileUploads.status} IN ('pending', 'processing') THEN 'UPLOAD_EXPIRED' ELSE ${profileUploads.failureCode} END`,
          processingLeaseExpiresAt: null,
          cleanupLeaseExpiresAt: input.leaseExpiresAt,
          cleanupAttempts: sql`${profileUploads.cleanupAttempts} + 1`,
          updatedAt: input.now,
        })
        .where(
          sql`${profileUploads.id} IN (${sql.join(
            selected.map(({ id }) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .returning();
      const [remaining] = await tx
        .select({ id: profileUploads.id })
        .from(profileUploads)
        .where(cleanupDue(input.now))
        .limit(1);
      return { jobs, hasMore: Boolean(remaining) };
    });

  applyCleanupResult = async (input: {
    uploadId: string;
    cleanupLeaseExpiresAt: Date;
    stagingDeleted: boolean;
    finalDeleted: boolean;
    nextAttemptAt: Date | null;
    now: Date;
  }): Promise<void> => {
    await this.db
      .update(profileUploads)
      .set({
        ...(input.stagingDeleted ? { stagingDeletedAt: input.now } : {}),
        ...(input.finalDeleted
          ? {
              finalKey: null,
              publicUrl: null,
              finalContentType: null,
              finalSizeBytes: null,
              verifiedAt: null,
              finalDeletedAt: input.now,
            }
          : {}),
        cleanupLeaseExpiresAt: input.nextAttemptAt,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(profileUploads.id, input.uploadId),
          eq(profileUploads.cleanupLeaseExpiresAt, input.cleanupLeaseExpiresAt),
        ),
      );
  };
}

const MAX_ACTIVE_UPLOADS_PER_USER = 5;
const MAX_UPLOAD_CREATES_PER_WINDOW = 20;
const UPLOAD_CREATE_WINDOW_MS = 60 * 60 * 1000;

const cleanupDue = (now: Date) =>
  and(
    or(isNull(profileUploads.cleanupLeaseExpiresAt), lte(profileUploads.cleanupLeaseExpiresAt, now)),
    or(
      and(
        isNull(profileUploads.stagingDeletedAt),
        or(
          eq(profileUploads.status, "failed"),
          eq(profileUploads.status, "verified"),
          and(eq(profileUploads.status, "pending"), lte(profileUploads.expiresAt, now)),
          and(
            eq(profileUploads.status, "processing"),
            lte(profileUploads.expiresAt, now),
            lte(profileUploads.processingLeaseExpiresAt, now),
          ),
        ),
      ),
      and(isNotNull(profileUploads.finalDeletionPendingAt), isNull(profileUploads.finalDeletedAt)),
    ),
  );
