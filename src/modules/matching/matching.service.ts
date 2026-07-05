import { Injectable } from "@nestjs/common";
import { UserRepository } from "src/modules/user/user.repository";
import { MatchingRepository } from "./matching.repository";
import { LikeUserPayload, MatchCandidatePayload, ScoreSummaryPayload } from "./matching.types";

const DAILY_LIKE_LIMITS_BY_PLAN: Record<string, number | null> = {
  free: 10,
  basic: 20,
  gold: 40,
  black: null,
};

const LIKED_ME_LIMITS_BY_PLAN: Record<string, number | null> = {
  free: null,
  basic: 3,
  gold: 10,
  black: null,
};

const LIKED_ME_WINDOW_HOURS = 3;

@Injectable()
export class MatchingService {
  /**
   * MatchingService에서 사용할 저장소 의존성을 주입한다.
   *
   * @param matchingRepository 매칭 저장소
   * @param userRepository 사용자 저장소
   */
  constructor(
    private readonly matchingRepository: MatchingRepository,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * 매칭 후보 목록을 조회한다.
   *
   * @param userId 조회 사용자 ID
   * @returns 매칭 후보 목록
   */
  async candidates(userId: string): Promise<MatchCandidatePayload[]> {
    validateUuid(userId);
    const result = await this.matchingRepository.candidates(userId);

    return result.map(rowToCandidate);
  }

  /**
   * Black 플랜 전용 후보 목록을 조회한다.
   *
   * @param userId 조회 사용자 ID
   * @returns Black 후보 목록
   */
  async blackCandidates(userId: string): Promise<MatchCandidatePayload[]> {
    const viewerPlanId = await this.currentPlanId(userId);
    if (viewerPlanId !== "black") return [];
    return (await this.candidates(userId)).filter((candidate) => candidate.blackRecommended);
  }

  /**
   * 나를 좋아한 후보 목록을 조회한다.
   *
   * @param userId 조회 사용자 ID
   * @param now 기준 시각
   * @returns 나를 좋아한 후보 목록
   */
  async likedMeCandidates(userId: string, now = new Date()): Promise<MatchCandidatePayload[]> {
    validateUuid(userId);
    const viewerPlanId = await this.currentPlanId(userId);
    if (viewerPlanId === "free") throw new Error("LIKED_ME_NOT_AVAILABLE");
    await this.enforceLikedMeWindow(userId, viewerPlanId, now);
    const limit = getLikedMeLimit(viewerPlanId);
    const result = await this.matchingRepository.likedMeCandidates(userId);
    const rows = limit === null ? result : result.slice(0, limit);
    return rows.map(rowToCandidate);
  }

  /**
   * 사용자를 좋아요 처리하고 상호 좋아요면 매칭한다.
   *
   * @param userId 좋아요를 누른 사용자 ID
   * @param likedUserId 좋아요 대상 사용자 ID
   * @param now 기준 시각
   * @returns 매칭 결과
   */
  async likeUser(userId: string, likedUserId: string, now = new Date()): Promise<LikeUserPayload> {
    validateUuid(userId);
    validateUuid(likedUserId);
    if (userId === likedUserId) throw new Error("LIKE_SELF_NOT_ALLOWED");
    const planId = await this.currentPlanId(userId);

    const result = await this.matchingRepository.likeUser({
      userId,
      likedUserId,
      dailyLimit: getDailyLikeLimit(planId),
      dayStart: startOfUtcDay(now),
      dayEnd: nextUtcDay(now),
    });
    return result.matched;
  }

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

    await this.matchingRepository.upsertScore({ scorerUserId, scoredUserId, score });

    return this.scoreSummary(scoredUserId);
  }

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 점수 요약
   */
  async scoreSummary(userId: string): Promise<ScoreSummaryPayload> {
    validateUuid(userId);
    const result = await this.matchingRepository.scoreSummary(userId);

    return {
      userId,
      averageScore: Number(result?.averageScore ?? 0),
      scoreCount: Number(result?.scoreCount ?? 0),
    };
  }

  /**
   * 나를 좋아한 사람 보기 접근 제한을 검증하고 기록한다.
   *
   * @param userId 사용자 ID
   * @param viewerPlanId 조회 사용자 플랜 ID
   * @param now 기준 시각
   */
  private async enforceLikedMeWindow(userId: string, viewerPlanId: string, now: Date): Promise<void> {
    const limit = getLikedMeLimit(viewerPlanId);
    if (limit === null) return;
    const periodStart = startOfLikedMeWindow(now);
    const current = await this.matchingRepository.findLikedMeAccess(userId, periodStart);
    const next = (current?.viewedCount ?? 0) + 1;
    if (next > limit) throw new Error("LIKED_ME_LIMIT_REACHED");
    await this.matchingRepository.createLikedMeAccess({ userId, periodStart, viewedCount: next });
  }

  /**
   * 사용자의 현재 활성 플랜 ID를 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 현재 플랜 ID
   */
  private async currentPlanId(userId: string): Promise<string> {
    return (await this.userRepository.findCurrentSubscription(userId))?.planId ?? "free";
  }
}

type CandidateRow = {
  id: string;
  userName: string;
  gender: string;
  intro: string;
  likedByMe: boolean;
  planId: string;
};

const validateUuid = (input: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
};

const getDailyLikeLimit = (planId: string): number | null =>
  DAILY_LIKE_LIMITS_BY_PLAN[planId] ?? DAILY_LIKE_LIMITS_BY_PLAN.free;

const getLikedMeLimit = (planId: string): number | null =>
  LIKED_ME_LIMITS_BY_PLAN[planId] ?? LIKED_ME_LIMITS_BY_PLAN.basic;

const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const nextUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 24));

const startOfLikedMeWindow = (now: Date): Date => {
  const windowStartHour = Math.floor(now.getUTCHours() / LIKED_ME_WINDOW_HOURS) * LIKED_ME_WINDOW_HOURS;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), windowStartHour));
};

const rowToCandidate = (row: CandidateRow): MatchCandidatePayload => ({
  id: row.id,
  userName: row.userName,
  gender: row.gender,
  intro: row.intro,
  likedByMe: row.likedByMe,
  planId: row.planId,
  blackRecommended: row.planId === "black",
});
