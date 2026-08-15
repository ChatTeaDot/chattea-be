import { Injectable, Optional } from "@nestjs/common";
import { NotificationService } from "src/modules/notification/notification.service";
import { UserRepository } from "src/modules/user/user.repository";
import {
  BoostPayload,
  LikeUserPayload,
  MatchCandidatePayload,
  ScoreSummaryPayload,
  UndoMatchActionPayload,
} from "./matching.types";
import { MatchingRepository } from "./matching.repository";

const DAILY_LIKE_LIMITS_BY_PLAN: Record<string, number | null> = {
  free: 10,
  basic: 20,
  gold: 40,
  black: null,
};
const LIKED_ME_LIMITS_BY_PLAN: Record<string, number | null> = { free: null, basic: 3, gold: 10, black: null };
const LIKED_ME_WINDOW_HOURS = 3;

@Injectable()
export class MatchingService {
  constructor(
    private readonly matchingRepository: MatchingRepository,
    private readonly userRepository: UserRepository,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  async candidates(userId: string): Promise<MatchCandidatePayload[]> {
    validateUuid(userId);
    await this.requireCompletedProfile(userId);
    return (await this.matchingRepository.candidates(userId)).map(rowToCandidate);
  }

  async blackCandidates(userId: string): Promise<MatchCandidatePayload[]> {
    if ((await this.currentPlanId(userId)) !== "black") return [];
    return (await this.candidates(userId)).filter((candidate) => candidate.blackRecommended);
  }

  async likedMeCandidates(userId: string, now = new Date()): Promise<MatchCandidatePayload[]> {
    validateUuid(userId);
    await this.requireCompletedProfile(userId);
    const viewerPlanId = await this.currentPlanId(userId);
    if (viewerPlanId === "free") throw new Error("LIKED_ME_NOT_AVAILABLE");
    await this.enforceLikedMeWindow(userId, viewerPlanId, now);
    const limit = getLikedMeLimit(viewerPlanId);
    const result = await this.matchingRepository.likedMeCandidates(userId);
    return (limit === null ? result : result.slice(0, limit)).map(rowToCandidate);
  }

  async likeUser(userId: string, likedUserId: string, now = new Date()): Promise<LikeUserPayload> {
    return this.actOnCandidate(userId, likedUserId, "like", now);
  }

  async skipCandidate(userId: string, targetUserId: string): Promise<boolean> {
    const result = await this.actOnCandidate(userId, targetUserId, "skip", new Date());
    return !result.matched;
  }

  async superLikeUser(userId: string, targetUserId: string, now = new Date()): Promise<LikeUserPayload> {
    return this.actOnCandidate(userId, targetUserId, "superlike", now);
  }

  async undoLastAction(userId: string): Promise<UndoMatchActionPayload> {
    validateUuid(userId);
    await this.requireCompletedProfile(userId);
    const action = await this.matchingRepository.undoLastAction(userId);
    return { reverted: Boolean(action), targetUserId: action?.targetUserId };
  }

  async activateBoost(userId: string, now = new Date()): Promise<BoostPayload> {
    validateUuid(userId);
    await this.requireCompletedProfile(userId);
    const boost = await this.matchingRepository.activateBoost(userId, now);
    return { activeUntil: boost.endsAt.toISOString(), remainingBoostCredits: boost.remainingBoostCredits };
  }

  async rateScore(scorerUserId: string, scoredUserId: string, score: number): Promise<ScoreSummaryPayload> {
    validateUuid(scorerUserId);
    validateUuid(scoredUserId);
    if (scorerUserId === scoredUserId) throw new Error("SCORE_SELF_NOT_ALLOWED");
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error("SCORE_INVALID");
    await this.matchingRepository.upsertScore({ scorerUserId, scoredUserId, score });
    return this.scoreSummary(scoredUserId);
  }

  async scoreSummary(userId: string): Promise<ScoreSummaryPayload> {
    validateUuid(userId);
    const result = await this.matchingRepository.scoreSummary(userId);
    return { userId, averageScore: Number(result?.averageScore ?? 0), scoreCount: Number(result?.scoreCount ?? 0) };
  }

  private async actOnCandidate(
    userId: string,
    targetUserId: string,
    action: "skip" | "like" | "superlike",
    now: Date,
  ): Promise<LikeUserPayload> {
    validateUuid(userId);
    validateUuid(targetUserId);
    if (userId === targetUserId) throw new Error(action === "skip" ? "SKIP_SELF_NOT_ALLOWED" : "LIKE_SELF_NOT_ALLOWED");
    await this.requireCompletedProfile(userId);
    const planId = await this.currentPlanId(userId);
    const result = await this.matchingRepository.actOnCandidate({
      userId,
      targetUserId,
      action,
      dailyLimit: getDailyLikeLimit(planId),
      dayStart: startOfUtcDay(now),
      dayEnd: nextUtcDay(now),
    });

    if (action !== "skip") {
      await this.notifyInteraction({ userId, targetUserId, matched: result.matched, roomId: result.roomId });
    }
    return { matched: result.matched, roomId: result.roomId, undoAvailable: !result.matched };
  }

  private async notifyInteraction(input: { userId: string; targetUserId: string; matched: boolean; roomId?: string }) {
    if (!this.notificationService) return;
    if (input.matched) {
      await Promise.all([
        this.notificationService.notify({
          userId: input.userId,
          type: "match",
          title: "서로 관심이 닿았어요",
          body: "이제 대화를 시작할 수 있어요.",
          route: input.roomId ? `/rooms/${input.roomId}` : "/rooms",
          sourceId: input.roomId,
        }),
        this.notificationService.notify({
          userId: input.targetUserId,
          type: "match",
          title: "서로 관심이 닿았어요",
          body: "이제 대화를 시작할 수 있어요.",
          route: input.roomId ? `/rooms/${input.roomId}` : "/rooms",
          sourceId: input.roomId,
        }),
      ]);
      return;
    }
    await this.notificationService.notify({
      userId: input.targetUserId,
      type: "like",
      title: "새 관심을 받았어요",
      body: "나를 좋아한 사람에서 확인해 보세요.",
      route: "/likes",
      sourceId: input.userId,
    });
  }

  private async requireCompletedProfile(userId: string): Promise<void> {
    if (!(await this.matchingRepository.profileIsComplete(userId))) throw new Error("PROFILE_COMPLETION_REQUIRED");
  }

  private async enforceLikedMeWindow(userId: string, viewerPlanId: string, now: Date): Promise<void> {
    const limit = getLikedMeLimit(viewerPlanId);
    if (limit === null) return;
    const periodStart = startOfLikedMeWindow(now);
    const current = await this.matchingRepository.findLikedMeAccess(userId, periodStart);
    const next = (current?.viewedCount ?? 0) + 1;
    if (next > limit) throw new Error("LIKED_ME_LIMIT_REACHED");
    await this.matchingRepository.createLikedMeAccess({ userId, periodStart, viewedCount: next });
  }

  private async currentPlanId(userId: string): Promise<string> {
    return (await this.userRepository.findCurrentSubscription(userId))?.planId ?? "free";
  }
}

type CandidateRow = {
  id: string;
  userName: string;
  gender: string;
  birthDate: string | null;
  region: string | null;
  intro: string;
  photos: { url: string; position: number }[];
  likedByMe: boolean;
  planId: string;
  boostActive: boolean;
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
const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const nextUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 24));
const startOfLikedMeWindow = (now: Date): Date => {
  const hour = Math.floor(now.getUTCHours() / LIKED_ME_WINDOW_HOURS) * LIKED_ME_WINDOW_HOURS;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
};
const ageFromBirthDate = (birthDate: string | null): number => {
  if (!birthDate) return 18;
  const birth = new Date(`${birthDate}T00:00:00.000Z`);
  const today = new Date();
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
};
const rowToCandidate = (row: CandidateRow): MatchCandidatePayload => ({
  id: row.id,
  userName: row.userName,
  gender: row.gender,
  age: ageFromBirthDate(row.birthDate),
  region: row.region ?? "지역 미설정",
  intro: row.intro,
  photos: row.photos,
  likedByMe: row.likedByMe,
  planId: row.planId,
  blackRecommended: row.planId === "black",
  boostActive: row.boostActive,
});
