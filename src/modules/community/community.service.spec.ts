import { describe, expect, it, jest } from "@jest/globals";
import { CommunityRepository } from "./community.repository";
import { CommunityService } from "./community.service";

describe("CommunityService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const postId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("trims post title and body before creating a post", async () => {
    const post = {
      id: postId,
      anonymousName: "익명",
      title: "제목",
      body: "본문",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const repository = {
      createPost: jest.fn<() => Promise<typeof post>>().mockResolvedValue(post),
    } as unknown as CommunityRepository;
    const service = new CommunityService(repository);

    await expect(service.createPost(userId, { title: " 제목 ", body: " 본문 " })).resolves.toMatchObject({
      id: postId,
      title: "제목",
      body: "본문",
      commentCount: 0,
    });
    expect(repository.createPost).toHaveBeenCalledWith({ userId, title: "제목", body: "본문" });
  });

  it("rejects comments for missing posts", async () => {
    const repository = {
      findPost: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as CommunityRepository;
    const service = new CommunityService(repository);

    await expect(service.createComment(userId, postId, "댓글")).rejects.toThrow("COMMUNITY_POST_NOT_FOUND");
  });
});
