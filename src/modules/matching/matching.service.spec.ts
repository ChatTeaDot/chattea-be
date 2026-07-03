import { describe, expect, it, jest } from "@jest/globals";
import { MatchingRepository } from "./matching.repository";
import { MatchingService } from "./matching.service";

describe("MatchingService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const likedUserId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("rejects self likes", async () => {
    const service = new MatchingService({} as MatchingRepository);

    await expect(service.likeUser(userId, userId)).rejects.toThrow("LIKE_SELF_NOT_ALLOWED");
  });

  it("limits liked-me access by plan window", async () => {
    const repository = {
      findLikedMeAccess: jest.fn<() => Promise<{ viewedCount: number }>>().mockResolvedValue({ viewedCount: 3 }),
    } as unknown as MatchingRepository;
    const service = new MatchingService(repository);

    await expect(service.likedMeCandidates(userId, "basic", new Date("2026-01-01T04:30:00.000Z"))).rejects.toThrow(
      "LIKED_ME_LIMIT_REACHED",
    );
  });

  it("passes daily like limits to repository", async () => {
    const matched = { matched: false, roomId: undefined };
    const repository = {
      likeUser: jest.fn<() => Promise<{ matched: typeof matched }>>().mockResolvedValue({ matched }),
    } as unknown as MatchingRepository;
    const service = new MatchingService(repository);

    await expect(service.likeUser(userId, likedUserId, "basic", new Date("2026-01-01T04:30:00.000Z"))).resolves.toEqual(matched);
    expect(repository.likeUser).toHaveBeenCalledWith({
      userId,
      likedUserId,
      dailyLimit: 20,
      dayStart: new Date("2026-01-01T00:00:00.000Z"),
      dayEnd: new Date("2026-01-02T00:00:00.000Z"),
    });
  });
});
