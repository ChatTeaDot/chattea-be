import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const genders = ["male", "female"] as const;
export type Gender = (typeof genders)[number];
export const isGender = (value: string): value is Gender => genders.includes(value as Gender);
export const interestedGenders = ["male", "female", "everyone"] as const;
export type InterestedGender = (typeof interestedGenders)[number];
export const isInterestedGender = (value: string): value is InterestedGender =>
  interestedGenders.includes(value as InterestedGender);

export const users = pgTable(
  "users",
  {
    userId: uuid("userId").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    phone: varchar("phone", { length: 20 }).unique(),
    password: text("password").notNull(),
    userName: varchar("userName", { length: 40 }).notNull().default(""),
    gender: varchar("gender", { length: 20, enum: genders }).notNull(),
    intro: text("intro").notNull().default(""),
    birthDate: date("birthDate", { mode: "string" }),
    region: varchar("region", { length: 20 }),
    interestedGender: varchar("interestedGender", { length: 20, enum: interestedGenders }),
    profileCompletedAt: timestamp("profileCompletedAt"),
    hiddenAt: timestamp("hiddenAt"),
    deletionScheduledAt: timestamp("deletionScheduledAt"),
    deletionLeaseExpiresAt: timestamp("deletionLeaseExpiresAt"),
    deletionAttempts: integer("deletionAttempts").notNull().default(0),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("users_matching_visible_created_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.profileCompletedAt} IS NOT NULL AND ${table.hiddenAt} IS NULL AND ${table.deletedAt} IS NULL`),
  ],
);

export const profileUploadStatuses = ["pending", "processing", "verified", "failed"] as const;
export type ProfileUploadStatus = (typeof profileUploadStatuses)[number];

export const profileUploads = pgTable(
  "profile_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    status: varchar("status", { length: 20, enum: profileUploadStatuses }).notNull().default("pending"),
    stagingKey: text("stagingKey").notNull().unique(),
    finalKey: text("finalKey").unique(),
    expectedContentType: varchar("expectedContentType", { length: 30 }).notNull(),
    expectedSizeBytes: integer("expectedSizeBytes").notNull(),
    finalContentType: varchar("finalContentType", { length: 30 }),
    finalSizeBytes: integer("finalSizeBytes"),
    publicUrl: text("publicUrl"),
    expiresAt: timestamp("expiresAt").notNull(),
    processingLeaseExpiresAt: timestamp("processingLeaseExpiresAt"),
    cleanupLeaseExpiresAt: timestamp("cleanupLeaseExpiresAt"),
    cleanupAttempts: integer("cleanupAttempts").notNull().default(0),
    failureCode: text("failureCode"),
    stagingDeletedAt: timestamp("stagingDeletedAt"),
    finalDeletionPendingAt: timestamp("finalDeletionPendingAt"),
    finalDeletedAt: timestamp("finalDeletedAt"),
    verifiedAt: timestamp("verifiedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("profile_uploads_user_status_idx").on(table.userId, table.status, table.createdAt),
    index("profile_uploads_user_created_idx").on(table.userId, table.createdAt),
    index("profile_uploads_cleanup_due_idx")
      .on(table.expiresAt, table.cleanupLeaseExpiresAt, table.createdAt)
      .where(sql`${table.stagingDeletedAt} IS NULL`),
    index("profile_uploads_final_deletion_due_idx")
      .on(table.finalDeletionPendingAt, table.cleanupLeaseExpiresAt, table.createdAt)
      .where(sql`${table.finalDeletionPendingAt} IS NOT NULL AND ${table.finalDeletedAt} IS NULL`),
    check(
      "profile_uploads_final_deletion_state_check",
      sql`(${table.finalDeletionPendingAt} IS NULL AND ${table.finalDeletedAt} IS NULL)
        OR (${table.finalDeletionPendingAt} IS NOT NULL AND (${table.finalKey} IS NOT NULL OR ${table.finalDeletedAt} IS NOT NULL))`,
    ),
  ],
);

export const userProfilePhotos = pgTable(
  "user_profile_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    uploadId: uuid("uploadId").references(() => profileUploads.id, { onDelete: "restrict" }),
    url: text("url").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("user_profile_photos_user_position_unique").on(table.userId, table.position),
    uniqueIndex("user_profile_photos_upload_unique")
      .on(table.uploadId)
      .where(sql`${table.uploadId} IS NOT NULL`),
  ],
);

export const refreshTokens = pgTable(
  "refreshToken",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    deviceId: varchar("deviceId", { length: 255 }).notNull(),
    refreshToken: text("refreshToken").notNull(),
    refreshTokenExp: timestamp("refreshTokenExp").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [unique("refreshToken_userId_deviceId_unique").on(table.userId, table.deviceId)],
);

export const authIdentities = pgTable(
  "authIdentity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerUserId: varchar("providerUserId", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [unique("authIdentity_provider_providerUserId_unique").on(table.provider, table.providerUserId)],
);

export const phoneVerifications = pgTable("phoneVerification", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneE164: varchar("phoneE164", { length: 20 }).notNull(),
  codeHash: text("codeHash").notNull(),
  purpose: varchar("purpose", { length: 50 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  verifiedAt: timestamp("verifiedAt"),
  attemptCount: integer("attemptCount").notNull().default(0),
  requestIpHash: text("requestIpHash"),
  userAgentHash: text("userAgentHash"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const phoneVerificationTokens = pgTable("phoneVerificationToken", {
  tokenHash: text("tokenHash").primaryKey(),
  phoneE164: varchar("phoneE164", { length: 20 }).notNull(),
  verificationId: uuid("verificationId")
    .notNull()
    .references(() => phoneVerifications.id),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const kakaoPhoneVerificationTokens = pgTable("kakaoPhoneVerificationToken", {
  tokenHash: text("tokenHash").primaryKey(),
  userId: uuid("userId").references(() => users.userId),
  providerUserId: varchar("providerUserId", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("대화"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("roomId")
      .notNull()
      .references(() => rooms.id),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    joinedAt: timestamp("joinedAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("roomId")
      .notNull()
      .references(() => rooms.id),
    senderUserId: uuid("senderUserId").references(() => users.userId),
    text: text("text").notNull(),
    idempotencyKey: text("idempotencyKey"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("messages_room_sender_idempotency_unique").on(table.roomId, table.senderUserId, table.idempotencyKey),
  ],
);

export const readReceipts = pgTable(
  "read_receipts",
  {
    roomId: uuid("roomId")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    lastReadMessageId: uuid("lastReadMessageId").references(() => messages.id, { onDelete: "set null" }),
    readAt: timestamp("readAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerUserId: uuid("blockerUserId")
      .notNull()
      .references(() => users.userId),
    blockedUserId: uuid("blockedUserId")
      .notNull()
      .references(() => users.userId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerUserId, table.blockedUserId] }),
    index("user_blocks_blocked_blocker_idx").on(table.blockedUserId, table.blockerUserId),
  ],
);

export const messageReports = pgTable(
  "message_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => messages.id),
    reporterUserId: uuid("reporterUserId")
      .notNull()
      .references(() => users.userId),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [unique("message_reports_messageId_reporterUserId_unique").on(table.messageId, table.reporterUserId)],
);

export const userLikes = pgTable(
  "user_likes",
  {
    likerUserId: uuid("likerUserId")
      .notNull()
      .references(() => users.userId),
    likedUserId: uuid("likedUserId")
      .notNull()
      .references(() => users.userId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.likerUserId, table.likedUserId] })],
);

export const userLikedMeAccesses = pgTable(
  "user_liked_me_accesses",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    periodStart: timestamp("periodStart").notNull(),
    viewedCount: integer("viewedCount").notNull().default(0),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.periodStart] })],
);

export const userSubscriptions = pgTable(
  "user_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    planId: text("planId").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    providerCustomerId: text("providerCustomerId"),
    providerProductId: text("providerProductId"),
    providerEventTimestampMs: bigint("providerEventTimestampMs", { mode: "number" }),
    currentPeriodStartsAt: timestamp("currentPeriodStartsAt"),
    currentPeriodEndsAt: timestamp("currentPeriodEndsAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [unique("user_subscriptions_user_provider_unique").on(table.userId, table.provider)],
);

export const userConsumableBalances = pgTable("user_consumable_balances", {
  userId: uuid("userId")
    .primaryKey()
    .references(() => users.userId, { onDelete: "cascade" }),
  superLikeCredits: integer("superLikeCredits").notNull().default(0),
  boostCredits: integer("boostCredits").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const userBoosts = pgTable(
  "user_boosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    source: text("source").notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("user_boosts_user_active_idx").on(table.userId, table.endsAt.desc())],
);

export const matchActions = pgTable("match_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actorUserId")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  targetUserId: uuid("targetUserId")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  action: varchar("action", { length: 20 }).notNull(),
  revertedAt: timestamp("revertedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const notificationTypes = ["like", "match", "message", "comment", "purchase"] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.userId, { onDelete: "cascade" }),
  type: varchar("type", { length: 20, enum: notificationTypes }).notNull(),
  title: varchar("title", { length: 80 }).notNull(),
  body: text("body").notNull(),
  route: text("route"),
  sourceId: text("sourceId"),
  readAt: timestamp("readAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    deviceId: uuid("deviceId").notNull(),
    token: text("token").notNull(),
    platform: varchar("platform", { length: 20 }).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("push_tokens_token_unique").on(table.token),
    unique("push_tokens_user_device_unique").on(table.userId, table.deviceId),
    index("push_tokens_user_idx").on(table.userId),
  ],
);

export const pushOutboxStatuses = [
  "queued",
  "sending",
  "receipt_pending",
  "receipt_checking",
  "delivered",
  "failed_permanent",
  "exhausted",
  "cancelled",
] as const;
export type PushOutboxStatus = (typeof pushOutboxStatuses)[number];

export const pushOutbox = pgTable(
  "push_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notificationId")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    pushTokenId: uuid("pushTokenId").references(() => pushTokens.id, { onDelete: "set null" }),
    tokenSnapshot: text("tokenSnapshot").notNull(),
    title: varchar("title", { length: 80 }).notNull(),
    body: text("body").notNull(),
    route: text("route"),
    status: varchar("status", { length: 30, enum: pushOutboxStatuses }).notNull().default("queued"),
    ticketId: text("ticketId"),
    sendAttempts: integer("sendAttempts").notNull().default(0),
    receiptAttempts: integer("receiptAttempts").notNull().default(0),
    nextAttemptAt: timestamp("nextAttemptAt").defaultNow().notNull(),
    receiptAvailableAt: timestamp("receiptAvailableAt"),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    lastErrorCode: text("lastErrorCode"),
    lastErrorMessage: text("lastErrorMessage"),
    sentAt: timestamp("sentAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("push_outbox_notification_token_unique").on(table.notificationId, table.pushTokenId),
    unique("push_outbox_ticket_unique").on(table.ticketId),
    index("push_outbox_send_due_idx").on(table.nextAttemptAt, table.createdAt),
    index("push_outbox_receipt_due_idx").on(table.receiptAvailableAt, table.nextAttemptAt, table.createdAt),
  ],
);

export const billingEvents = pgTable("billing_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerEventId: text("providerEventId").notNull().unique(),
  provider: varchar("provider", { length: 30 }).notNull(),
  payloadHash: text("payloadHash").notNull(),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
});

export const revenueCatTransactions = pgTable(
  "revenuecat_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 30 }).notNull(),
    providerTransactionId: text("providerTransactionId").notNull(),
    originalTransactionId: text("originalTransactionId").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    canonicalProductId: text("canonicalProductId").notNull(),
    providerProductId: text("providerProductId").notNull(),
    superLikeUnits: integer("superLikeUnits").notNull(),
    boostUnits: integer("boostUnits").notNull(),
    state: varchar("state", { length: 20, enum: ["granted", "refunded"] }).notNull(),
    stateEventTimestampMs: bigint("stateEventTimestampMs", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("revenuecat_transactions_provider_transaction_unique").on(table.provider, table.providerTransactionId),
  ],
);

export const revenueCatTransactionLedger = pgTable(
  "revenuecat_transaction_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("providerEventId")
      .notNull()
      .unique()
      .references(() => billingEvents.providerEventId),
    revenuecatTransactionId: uuid("revenuecatTransactionId")
      .notNull()
      .references(() => revenueCatTransactions.id),
    eventTimestampMs: bigint("eventTimestampMs", { mode: "number" }).notNull(),
    requestedState: varchar("requestedState", { length: 20, enum: ["granted", "refunded"] }).notNull(),
    effectiveState: varchar("effectiveState", { length: 20, enum: ["granted", "refunded"] }).notNull(),
    superLikeDelta: integer("superLikeDelta").notNull(),
    boostDelta: integer("boostDelta").notNull(),
    applied: boolean("applied").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("revenuecat_transaction_ledger_transaction_timestamp_idx").on(
      table.revenuecatTransactionId,
      table.eventTimestampMs,
      table.createdAt,
    ),
  ],
);

export const matches = pgTable(
  "matches",
  {
    userLowId: uuid("userLowId")
      .notNull()
      .references(() => users.userId),
    userHighId: uuid("userHighId")
      .notNull()
      .references(() => users.userId),
    roomId: uuid("roomId")
      .notNull()
      .unique()
      .references(() => rooms.id),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userLowId, table.userHighId] }),
    index("matches_user_high_low_idx").on(table.userHighId, table.userLowId),
  ],
);

export const communityPosts = pgTable("community_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorUserId: uuid("authorUserId")
    .notNull()
    .references(() => users.userId),
  title: text("title").notNull(),
  body: text("body").notNull(),
  deletedAt: timestamp("deletedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const communityProfiles = pgTable("community_profiles", {
  userId: uuid("userId")
    .primaryKey()
    .references(() => users.userId),
  name: varchar("name", { length: 20 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const communityComments = pgTable("community_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("postId")
    .notNull()
    .references(() => communityPosts.id),
  authorUserId: uuid("authorUserId")
    .notNull()
    .references(() => users.userId),
  body: text("body").notNull(),
  deletedAt: timestamp("deletedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const communityPostReports = pgTable(
  "community_post_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("postId")
      .notNull()
      .references(() => communityPosts.id),
    reporterUserId: uuid("reporterUserId")
      .notNull()
      .references(() => users.userId),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [unique("community_post_reports_postId_reporterUserId_unique").on(table.postId, table.reporterUserId)],
);

export const communityCommentReports = pgTable(
  "community_comment_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commentId: uuid("commentId")
      .notNull()
      .references(() => communityComments.id),
    reporterUserId: uuid("reporterUserId")
      .notNull()
      .references(() => users.userId),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("community_comment_reports_commentId_reporterUserId_unique").on(table.commentId, table.reporterUserId),
  ],
);

export const scores = pgTable(
  "scores",
  {
    scorerUserId: uuid("scorerUserId")
      .notNull()
      .references(() => users.userId),
    scoredUserId: uuid("scoredUserId")
      .notNull()
      .references(() => users.userId),
    score: integer("score").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scorerUserId, table.scoredUserId] })],
);

export type User = Omit<typeof users.$inferSelect, "deletionLeaseExpiresAt" | "deletionAttempts">;
export type ProfileUpload = typeof profileUploads.$inferSelect;
export type UserProfilePhoto = typeof userProfilePhotos.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type PhoneVerification = typeof phoneVerifications.$inferSelect;
export type PhoneVerificationToken = typeof phoneVerificationTokens.$inferSelect;
export type KakaoPhoneVerificationToken = typeof kakaoPhoneVerificationTokens.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ReadReceipt = typeof readReceipts.$inferSelect;
export type UserLike = typeof userLikes.$inferSelect;
export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type UserConsumableBalance = typeof userConsumableBalances.$inferSelect;
export type UserBoost = typeof userBoosts.$inferSelect;
export type MatchAction = typeof matchActions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type PushToken = typeof pushTokens.$inferSelect;
export type PushOutbox = typeof pushOutbox.$inferSelect;
export type BillingEvent = typeof billingEvents.$inferSelect;
export type RevenueCatTransaction = typeof revenueCatTransactions.$inferSelect;
export type RevenueCatTransactionLedgerEntry = typeof revenueCatTransactionLedger.$inferSelect;
export type CommunityPost = typeof communityPosts.$inferSelect;
export type CommunityProfile = typeof communityProfiles.$inferSelect;
export type CommunityComment = typeof communityComments.$inferSelect;
export type CommunityCommentReport = typeof communityCommentReports.$inferSelect;
export type Score = typeof scores.$inferSelect;
