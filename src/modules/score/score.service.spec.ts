import { describe, expect, it, jest } from "@jest/globals";
import { ScoreRepository } from "./score.repository";
import { ScoreService } from "./score.service";

describe("ScoreService", () => {
  const scorerUserId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const scoredUserId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("rejects invalid score values", async () => {
    const service = new ScoreService({} as ScoreRepository);

    await expect(service.rateScore(scorerUserId, scoredUserId, 6)).rejects.toThrow("SCORE_INVALID");
  });

  it("upserts a score and returns the summary", async () => {
    const repository = {
      upsertScore: jest.fn<() => Promise<void>>(),
      summary: jest.fn<() => Promise<{ averageScore: string; scoreCount: number }>>().mockResolvedValue({
        averageScore: "4.5",
        scoreCount: 2,
      }),
    } as unknown as ScoreRepository;
    const service = new ScoreService(repository);

    await expect(service.rateScore(scorerUserId, scoredUserId, 5)).resolves.toEqual({
      userId: scoredUserId,
      averageScore: 4.5,
      scoreCount: 2,
    });
    expect(repository.upsertScore).toHaveBeenCalledWith({ scorerUserId, scoredUserId, score: 5 });
  });
});
