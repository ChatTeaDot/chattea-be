import { GraphQLError } from "graphql";
import type { User } from "../auth/session.repository.js";
import type { GraphQLContext } from "./graphql.module.js";
import { buildUnreadMessageSummary } from "../subscription/ai-summary.service.js";
import { subscriptionPlans } from "../subscription/plan-catalog.service.js";

export function createGraphQLResolvers() {
  return {
    VerifyPhoneCodePayload: {
      __resolveType(value: { status: string }) {
        return value.status === "LOGIN" ? "LoginPayload" : "SignupRequiredPayload";
      },
    },
    KakaoLoginPayload: {
      __resolveType(value: { requiresPhone: boolean }) {
        return value.requiresPhone ? "KakaoRequiresPhonePayload" : "KakaoLoginSuccessPayload";
      },
    },
    Query: {
      me: (_parent: unknown, _args: unknown, context: GraphQLContext) => context.currentUser ?? null,
      subscriptionPlans: () => subscriptionPlans,
      mySubscription: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.subscriptionService.getCurrentSubscription(user.id);
      },
      unreadMessageSummary: (
        _parent: unknown,
        args: { planId: string; unreadTexts: string[]; enabled: boolean },
        context: GraphQLContext,
      ) => {
        requireUser(context);
        return buildUnreadMessageSummary(args);
      },
      matchCandidates: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.matchingService.listCandidates(user.id);
      },
      blackMatchCandidates: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        const user = requireUser(context);
        const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
        return context.matchingService.listBlackCandidates(user.id, subscription.planId);
      },
      likedMeCandidates: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        const user = requireUser(context);
        const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
        return context.matchingService.listLikedMeCandidates(user.id, subscription.planId, context.now?.());
      },
      communityPosts: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        requireUser(context);
        return context.communityService.listPosts();
      },
      communityComments: (_parent: unknown, args: { postId: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.communityService.listComments(args.postId);
      },
      profileRatingSummary: (_parent: unknown, args: { userId: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.profileRatingService.getSummary(args.userId);
      },
      rooms: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
        requireUser(context);
        return context.chatService.listRooms();
      },
      messages: (
        _parent: unknown,
        args: {
          roomId: string;
          first?: number | null;
          after?: string | null;
        },
        context: GraphQLContext,
      ) => {
        requireUser(context);
        return context.chatService.listMessages(args);
      },
    },
    Mutation: {
      loginWithKakao: (_parent: unknown, args: { accessToken: string }, context: GraphQLContext) =>
        context.authService.loginWithKakao(args.accessToken, context.now?.()),
      requestPhoneCode: (_parent: unknown, args: { phone: string }, context: GraphQLContext) =>
        context.phoneService.requestPhoneCode(args.phone, context.now?.(), context.requestMetadata),
      verifyPhoneCode: (_parent: unknown, args: { phone: string; code: string }, context: GraphQLContext) =>
        context.phoneService.verifyPhoneCode(args.phone, args.code, context.now?.()),
      completePhoneSignup: (
        _parent: unknown,
        args: {
          signupToken: string;
          nickname: string;
          intro?: string | null;
          termsAccepted: boolean;
        },
        context: GraphQLContext,
      ) =>
        context.phoneService.completePhoneSignup(
          args.signupToken,
          args.nickname,
          args.termsAccepted,
          context.now?.(),
          args.intro ?? "",
        ),
      completeKakaoPhoneSignup: async (
        _parent: unknown,
        args: {
          kakaoToken: string;
          signupToken: string;
          nickname: string;
          intro?: string | null;
          termsAccepted: boolean;
        },
        context: GraphQLContext,
      ) => {
        const result = await context.phoneService.completePhoneSignup(
          args.signupToken,
          args.nickname,
          args.termsAccepted,
          context.now?.(),
          args.intro ?? "",
        );

        return context.authService.attachPhoneUser(args.kakaoToken, result.user, context.now?.());
      },
      attachPhoneToMe: async (
        _parent: unknown,
        args: { kakaoToken: string; phone: string; code: string },
        context: GraphQLContext,
      ) => {
        const user = await context.phoneService.verifyExistingPhone(args.phone, args.code, context.now?.());

        return context.authService.attachPhoneUser(args.kakaoToken, user, context.now?.());
      },
      sendMessage: (
        _parent: unknown,
        args: {
          roomId: string;
          text: string;
          idempotencyKey?: string | null;
        },
        context: GraphQLContext,
      ) => {
        requireUser(context);
        return context.chatService.sendMessage(args, context.now?.());
      },
      editMessage: (_parent: unknown, args: { messageId: string; text: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.chatService.editMessage(args);
      },
      deleteMessage: (_parent: unknown, args: { messageId: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.chatService.deleteMessage(args.messageId);
      },
      markRoomRead: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.chatService.markRoomRead(args.roomId);
      },
      setTyping: (_parent: unknown, args: { roomId: string; typing: boolean }, context: GraphQLContext) => {
        requireUser(context);
        return context.chatService.setTyping(args.roomId, args.typing);
      },
      likeUser: async (_parent: unknown, args: { userId: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
        return context.matchingService.likeUser(user.id, args.userId, subscription.planId, context.now?.() ?? new Date());
      },
      createCommunityPost: (_parent: unknown, args: { title: string; body: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.communityService.createPost(user.id, args, context.now?.());
      },
      createCommunityComment: (_parent: unknown, args: { postId: string; body: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.communityService.createComment(user.id, args.postId, args.body, context.now?.());
      },
      reportCommunityPost: (_parent: unknown, args: { postId: string; reason: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.communityService.reportPost(user.id, args.postId, args.reason);
      },
      rateProfile: (_parent: unknown, args: { userId: string; score: number }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.profileRatingService.rateProfile(user.id, args.userId, args.score);
      },
      blockUser: (_parent: unknown, args: { userId: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.chatService.blockUser(user.id, args.userId);
      },
      reportMessage: (_parent: unknown, args: { messageId: string; reason: string }, context: GraphQLContext) => {
        const user = requireUser(context);
        return context.chatService.reportMessage(user.id, args.messageId, args.reason);
      },
      createUpload: (_parent: unknown, args: { filename: string; contentType: string }, context: GraphQLContext) => {
        requireUser(context);
        return context.uploadService.createUpload(args);
      },
    },
    Subscription: {
      messageCreated: {
        subscribe: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
          requireUser(context);
          return context.chatService.subscribeMessageCreated(args.roomId);
        },
        resolve: (event: unknown) => event,
      },
      messageUpdated: {
        subscribe: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
          requireUser(context);
          return context.chatService.subscribeMessageUpdated(args.roomId);
        },
        resolve: (event: unknown) => event,
      },
      messageDeleted: {
        subscribe: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
          requireUser(context);
          return context.chatService.subscribeMessageDeleted(args.roomId);
        },
        resolve: (event: { messageId: string }) => event.messageId,
      },
      typingChanged: {
        subscribe: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
          requireUser(context);
          return context.chatService.subscribeTypingChanged(args.roomId);
        },
        resolve: (event: { typing: boolean }) => event.typing,
      },
      readReceiptUpdated: {
        subscribe: (_parent: unknown, args: { roomId: string }, context: GraphQLContext) => {
          requireUser(context);
          return context.chatService.subscribeReadReceiptUpdated(args.roomId);
        },
        resolve: (event: { read: boolean }) => event.read,
      },
    },
  };
}

function requireUser(context: GraphQLContext): User {
  if (!context.currentUser) {
    throw new GraphQLError("AUTH_REQUIRED");
  }

  return context.currentUser;
}
