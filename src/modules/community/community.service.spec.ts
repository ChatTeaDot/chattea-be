import { describe, expect, it, jest } from "@jest/globals";
import { NotificationService } from "src/modules/notification/notification.service";
import { CommunityRepository } from "./community.repository";
import { CommunityService } from "./community.service";

describe("CommunityService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const postId = "821cc06e-7275-49cf-9d8b-a70e65f78240";
  const idempotencyKey = "d9bba92d-ac5d-4961-9525-b576375176ae";

  it("trims post title and body before creating a post", async () => {
    const post = {
      id: postId,
      authorName: "커뮤닉",
      title: "제목",
      body: "본문",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      findProfile: jest.fn<() => Promise<{ name: string }>>().mockResolvedValue({ name: "커뮤닉" }),
      createPost: jest.fn<() => Promise<{ post: typeof post; created: true }>>().mockResolvedValue({
        post,
        created: true,
      }),
    } as unknown as CommunityRepository;
    const service = new CommunityService(repository);

    await expect(
      service.createPost(userId, { idempotencyKey, title: " 제목 ", body: " 본문 " }),
    ).resolves.toMatchObject({
      id: postId,
      title: "제목",
      body: "본문",
      commentCount: 0,
    });
    expect(repository.createPost).toHaveBeenCalledWith({
      id: idempotencyKey,
      userId,
      title: "제목",
      body: "본문",
    });
  });

  it("rejects comments for missing posts", async () => {
    const repository = {
      findPost: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as CommunityRepository;
    const service = new CommunityService(repository);

    await expect(service.createComment(userId, postId, "댓글", idempotencyKey)).rejects.toThrow(
      "COMMUNITY_POST_NOT_FOUND",
    );
  });

  it("returns a committed comment when notification creation fails", async () => {
    const comment = {
      id: "d9bba92d-ac5d-4961-9525-b576375176ae",
      postId,
      body: "댓글",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      findPost: jest.fn<() => Promise<{ authorUserId: string }>>().mockResolvedValue({
        authorUserId: "f04608aa-632c-4735-ae44-e70846d76ba3",
      }),
      findProfile: jest.fn<() => Promise<{ name: string }>>().mockResolvedValue({ name: "커뮤닉" }),
      createComment: jest
        .fn<() => Promise<{ comment: typeof comment; created: true }>>()
        .mockResolvedValue({ comment, created: true }),
    } as unknown as CommunityRepository;
    const notificationService = {
      notify: jest.fn<() => Promise<never>>().mockRejectedValue(new Error("notification unavailable")),
    } as unknown as NotificationService;
    const service = new CommunityService(repository, notificationService);

    await expect(service.createComment(userId, postId, "댓글", idempotencyKey)).resolves.toMatchObject({
      id: comment.id,
      body: "댓글",
    });
  });
});
