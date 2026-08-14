import { integer, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const genders = ["male", "female"] as const;
export type Gender = (typeof genders)[number];
export const isGender = (value: string): value is Gender => genders.includes(value as Gender);

export const users = pgTable("users", {
  userId: uuid("userId").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }).unique(),
  password: text("password").notNull(),
  userName: varchar("userName", { length: 40 }).notNull().default(""),
  gender: varchar("gender", { length: 20, enum: genders }).notNull(),
  intro: text("intro").notNull().default(""),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

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
  (table) => [primaryKey({ columns: [table.blockerUserId, table.blockedUserId] })],
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

export const userSubscriptions = pgTable("user_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.userId),
  planId: text("planId").notNull(),
  status: text("status").notNull(),
  currentPeriodStartsAt: timestamp("currentPeriodStartsAt"),
  currentPeriodEndsAt: timestamp("currentPeriodEndsAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

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
  (table) => [primaryKey({ columns: [table.userLowId, table.userHighId] })],
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

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type PhoneVerification = typeof phoneVerifications.$inferSelect;
export type PhoneVerificationToken = typeof phoneVerificationTokens.$inferSelect;
export type KakaoPhoneVerificationToken = typeof kakaoPhoneVerificationTokens.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type UserLike = typeof userLikes.$inferSelect;
export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type CommunityPost = typeof communityPosts.$inferSelect;
export type CommunityProfile = typeof communityProfiles.$inferSelect;
export type CommunityComment = typeof communityComments.$inferSelect;
export type Score = typeof scores.$inferSelect;
