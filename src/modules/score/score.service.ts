import { Injectable } from "@nestjs/common";
import { ScoreRepository } from "./score.repository";
import { ScoreSummaryPayload } from "./score.types";

@Injectable()
export class ScoreService {
  constructor(private readonly scoreRepository: ScoreRepository) {}

  /**
   * 점수를 등록하거나 갱신한다.
   *
   * @param scorerUserId 채점자 ID
   * @param scoredUserId 채점 대상 사용자 ID
   * @param score 점수
   * @returns 점수 요약
   */
  async rateScore(scorerUserId: string, scoredUserId: string, score: number): Promise<ScoreSummaryPayload> {
    validateUuid(scorerUserId);
    validateUuid(scoredUserId);
    if (scorerUserId === scoredUserId) throw new Error("SCORE_SELF_NOT_ALLOWED");
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error("SCORE_INVALID");

    await this.scoreRepository.upsertScore({ scorerUserId, scoredUserId, score });

    return this.summary(scoredUserId);
  }

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 점수 요약
   */
  async summary(userId: string): Promise<ScoreSummaryPayload> {
    validateUuid(userId);
    const result = await this.scoreRepository.summary(userId);

    return {
      userId,
      averageScore: Number(result?.averageScore ?? 0),
      scoreCount: Number(result?.scoreCount ?? 0),
    };
  }
}

const validateUuid = (input: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
};
