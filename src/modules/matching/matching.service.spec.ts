import { describe, expect, it, jest } from "@jest/globals";
import { NotificationService } from "src/modules/notification/notification.service";
import { UserRepository } from "src/modules/user/user.repository";
import { MatchingRepository } from "./matching.repository";
import { MatchingService } from "./matching.service";

describe("MatchingService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const likedUserId = "821cc06e-7275-49cf-9d8b-a70e65f78240";

  it("rejects self likes", async () => {
    const service = new MatchingService({} as MatchingRepository, {} as UserRepository);

    await expect(service.likeUser(userId, userId)).rejects.toThrow("LIKE_SELF_NOT_ALLOWED");
  });

  it("requires a completed profile before exposing matches", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as MatchingRepository;
    const service = new MatchingService(repository, {} as UserRepository);

    await expect(service.candidates(userId)).rejects.toThrow("PROFILE_COMPLETION_REQUIRED");
  });

  it("limits liked-me access by plan window", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      consumeLikedMeAccess: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<{ planId: string }>>().mockResolvedValue({ planId: "basic" }),
    } as unknown as UserRepository;
    const service = new MatchingService(repository, userRepository);

    await expect(service.likedMeCandidates(userId, new Date("2026-01-01T04:30:00.000Z"))).rejects.toThrow(
      "LIKED_ME_LIMIT_REACHED",
    );
  });

  it("keeps Black liked-me access unlimited", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      consumeLikedMeAccess: jest.fn<() => Promise<boolean>>(),
      likedMeCandidates: jest.fn<() => Promise<[]>>().mockResolvedValue([]),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<{ planId: string }>>().mockResolvedValue({ planId: "black" }),
    } as unknown as UserRepository;
    const service = new MatchingService(repository, userRepository);

    await expect(service.likedMeCandidates(userId)).resolves.toEqual([]);
    expect(repository.consumeLikedMeAccess).not.toHaveBeenCalled();
    expect(repository.likedMeCandidates).toHaveBeenCalledWith(userId, 50);
  });

  it("bounds the liked-me query to the plan result limit", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      consumeLikedMeAccess: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      likedMeCandidates: jest.fn<() => Promise<[]>>().mockResolvedValue([]),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<{ planId: string }>>().mockResolvedValue({ planId: "gold" }),
    } as unknown as UserRepository;
    const service = new MatchingService(repository, userRepository);

    await service.likedMeCandidates(userId);

    expect(repository.likedMeCandidates).toHaveBeenCalledWith(userId, 10);
  });

  it("passes daily like limits to repository", async () => {
    const matched = { matched: false, roomId: undefined };
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      actOnCandidate: jest.fn<() => Promise<typeof matched>>().mockResolvedValue(matched),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<{ planId: string }>>().mockResolvedValue({ planId: "basic" }),
    } as unknown as UserRepository;
    const service = new MatchingService(repository, userRepository);

    await expect(service.likeUser(userId, likedUserId, new Date("2026-01-01T04:30:00.000Z"))).resolves.toEqual({
      ...matched,
      undoAvailable: true,
    });
    expect(repository.actOnCandidate).toHaveBeenCalledWith({
      userId,
      targetUserId: likedUserId,
      action: "like",
      dailyLimit: 20,
      now: new Date("2026-01-01T04:30:00.000Z"),
      dayStart: new Date("2026-01-01T00:00:00.000Z"),
      dayEnd: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("keeps Black daily likes unlimited", async () => {
    const matched = { matched: false, roomId: undefined };
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      actOnCandidate: jest.fn<() => Promise<typeof matched>>().mockResolvedValue(matched),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<{ planId: string }>>().mockResolvedValue({ planId: "black" }),
    } as unknown as UserRepository;
    const service = new MatchingService(repository, userRepository);

    await service.likeUser(userId, likedUserId, new Date("2026-01-01T04:30:00.000Z"));

    expect(repository.actOnCandidate).toHaveBeenCalledWith(expect.objectContaining({ dailyLimit: null }));
  });

  it("returns a committed like when notification creation fails", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      actOnCandidate: jest
        .fn<() => Promise<{ matched: false; created: true }>>()
        .mockResolvedValue({ matched: false, created: true }),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as UserRepository;
    const notificationService = {
      notify: jest.fn<() => Promise<never>>().mockRejectedValue(new Error("notification unavailable")),
    } as unknown as NotificationService;
    const service = new MatchingService(repository, userRepository, notificationService);

    await expect(service.likeUser(userId, likedUserId)).resolves.toEqual({
      matched: false,
      undoAvailable: true,
    });
  });

  it("does not notify again when replaying a committed like", async () => {
    const repository = {
      profileIsComplete: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      actOnCandidate: jest
        .fn<() => Promise<{ matched: false; created: false }>>()
        .mockResolvedValue({ matched: false, created: false }),
    } as unknown as MatchingRepository;
    const userRepository = {
      findCurrentSubscription: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as UserRepository;
    const notificationService = {
      notify: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as NotificationService;
    const service = new MatchingService(repository, userRepository, notificationService);

    await expect(service.likeUser(userId, likedUserId)).resolves.toEqual({
      matched: false,
      undoAvailable: true,
    });
    expect(notificationService.notify).not.toHaveBeenCalled();
  });
});
