import { Inject, Injectable } from "@nestjs/common";
import { avg, count, eq } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { scores } from "src/modules/database/schema";

@Injectable()
export class ScoreRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 점수를 생성하거나 갱신한다.
   *
   * @param input 채점자 ID, 채점 대상 ID, 점수
   * @returns 저장 완료 Promise
   */
  async upsertScore(input: { scorerUserId: string; scoredUserId: string; score: number }) {
    await this.db
      .insert(scores)
      .values(input)
      .onConflictDoUpdate({
        target: [scores.scorerUserId, scores.scoredUserId],
        set: { score: input.score, updatedAt: new Date() },
      });
  }

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 평균 점수와 채점 수
   */
  async summary(userId: string) {
    const [row] = await this.db
      .select({
        averageScore: avg(scores.score),
        scoreCount: count(),
      })
      .from(scores)
      .where(eq(scores.scoredUserId, userId));

    return row;
  }
}
