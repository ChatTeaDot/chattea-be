import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../migrations/001_initial_schema.sql", import.meta.url), "utf8");

describe("initial migration", () => {
  it("creates every documented table", () => {
    for (const table of [
      "users",
      "auth_identities",
      "phone_verifications",
      "signup_tokens",
      "sessions",
      "rooms",
      "room_members",
      "messages",
      "message_attachments",
      "read_receipts",
      "user_blocks",
      "message_reports",
      "user_likes",
      "user_subscriptions",
      "user_liked_me_accesses",
      "matches",
      "community_posts",
      "community_comments",
      "community_post_reports",
      "profile_ratings",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("keeps required constraints and indexes for auth, phone, chat, and reads", () => {
    expect(migration).toContain("phone_e164 text UNIQUE");
    expect(migration).toContain("intro text NOT NULL DEFAULT ''");
    expect(migration).toContain("CHECK (char_length(intro) <= 60)");
    expect(migration).toContain("UNIQUE (provider, provider_user_id)");
    expect(migration).toContain("request_ip_hash text");
    expect(migration).toContain("user_agent_hash text");
    expect(migration).toContain("token_hash text NOT NULL UNIQUE");
    expect(migration).toContain("phone_verification_id uuid NOT NULL REFERENCES phone_verifications(id)");
    expect(migration).toContain("idempotency_key text UNIQUE");
    expect(migration).toContain("CHECK (char_length(text) <= 90)");
    expect(migration).toContain("PRIMARY KEY (room_id, user_id)");
    expect(migration).toContain("phone_verifications_ip_created_idx");
    expect(migration).toContain("messages_room_created_idx");
    expect(migration).toContain("CHECK (blocker_user_id <> blocked_user_id)");
    expect(migration).toContain("UNIQUE (message_id, reporter_user_id)");
    expect(migration).toContain("message_reports_created_idx");
    expect(migration).toContain("PRIMARY KEY (liker_user_id, liked_user_id)");
    expect(migration).toContain("user_likes_liked_created_idx");
    expect(migration).toContain("user_liked_me_accesses");
    expect(migration).toContain("user_liked_me_accesses_user_period_idx");
    expect(migration).toContain("CHECK (plan_id IN ('free', 'basic', 'gold', 'black'))");
    expect(migration).toContain("CHECK (status IN ('active', 'canceled', 'expired'))");
    expect(migration).toContain("user_subscriptions_user_status_idx");
    expect(migration).toContain("PRIMARY KEY (user_low_id, user_high_id)");
    expect(migration).toContain("room_id uuid NOT NULL UNIQUE REFERENCES rooms(id)");
    expect(migration).toContain("community_anonymous_nickname_seq");
    expect(migration).toContain("author_user_id uuid NOT NULL REFERENCES users(id)");
    expect(migration).toContain("community_posts_created_idx");
    expect(migration).toContain("community_comments_post_created_idx");
    expect(migration).toContain("UNIQUE (post_id, reporter_user_id)");
    expect(migration).toContain("PRIMARY KEY (rater_user_id, rated_user_id)");
    expect(migration).toContain("CHECK (score BETWEEN 1 AND 5)");
    expect(migration).toContain("profile_ratings_rated_created_idx");
  });
});
