import { createSchema } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type { AuthService, PostgresAuthService } from "../auth/auth-service.js";
import type { User } from "../auth/session-store.js";
import type { ChatService, PostgresChatService } from "../chat/chat-service.js";
import type { CommunityService, PostgresCommunityService } from "../community/community-service.js";
import type { PhoneRequestMetadata, PhoneService, PostgresPhoneService } from "../phone/phone-service.js";
import type { PostgresProfileRatingService, ProfileRatingService } from "../profile/profile-rating-service.js";
import type { MatchingService, PostgresMatchingService } from "../matching/matching-service.js";
import { buildUnreadMessageSummary } from "../subscription/ai-summary.js";
import { subscriptionPlans } from "../subscription/plan-catalog.js";
import type { PostgresSubscriptionService, SubscriptionService } from "../subscription/subscription-service.js";
import type { UploadService } from "../upload/upload-service.js";

export type GraphQLContext = {
  authService: AuthService | PostgresAuthService;
  chatService: ChatService | PostgresChatService;
  communityService: CommunityService | PostgresCommunityService;
  currentUser?: User | null;
  matchingService: MatchingService | PostgresMatchingService;
  phoneService: PhoneService | PostgresPhoneService;
  profileRatingService: ProfileRatingService | PostgresProfileRatingService;
  requestMetadata?: PhoneRequestMetadata;
  subscriptionService: SubscriptionService | PostgresSubscriptionService;
  uploadService: UploadService;
  now?: () => Date;
};

const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    phoneE164: String!
    nickname: String!
    intro: String!
  }

  type Session {
    token: String!
    userId: ID!
  }

  type RequestPhoneCodePayload {
    ok: Boolean!
  }

  union VerifyPhoneCodePayload = LoginPayload | SignupRequiredPayload

  type LoginPayload {
    status: String!
    session: Session!
    user: User!
  }

  type SignupRequiredPayload {
    status: String!
    signupToken: String!
  }

  type CompletePhoneSignupPayload {
    session: Session!
    user: User!
  }

  union KakaoLoginPayload = KakaoLoginSuccessPayload | KakaoRequiresPhonePayload

  type KakaoLoginSuccessPayload {
    requiresPhone: Boolean!
    session: Session!
    user: User!
  }

  type KakaoRequiresPhonePayload {
    requiresPhone: Boolean!
    kakaoToken: String!
    nickname: String
  }

  type Room {
    id: ID!
    name: String!
    lastMessage: String!
  }

  type Message {
    id: ID!
    roomId: ID!
    text: String!
    createdAt: String!
  }

  type Upload {
    id: ID!
    putUrl: String!
  }

  type MatchCandidate {
    id: ID!
    nickname: String!
    intro: String!
    likedByMe: Boolean!
    planId: String!
    blackRecommended: Boolean!
  }

  type LikeUserPayload {
    matched: Boolean!
    roomId: ID
  }

  type SubscriptionPlan {
    id: ID!
    name: String!
    monthlyPriceKrw: Int!
    benefits: [String!]!
  }

  type CurrentSubscription {
    planId: String!
  }

  type AiSummaryPreview {
    available: Boolean!
    reason: String
    sourceText: String!
    summary: String
  }

  type CommunityPost {
    id: ID!
    anonymousNickname: String!
    title: String!
    body: String!
    commentCount: Int!
    createdAt: String!
  }

  type CommunityComment {
    id: ID!
    postId: ID!
    anonymousNickname: String!
    body: String!
    createdAt: String!
  }

  type ProfileRatingSummary {
    userId: ID!
    averageScore: Float!
    ratingCount: Int!
  }

  type Query {
    me: User
    subscriptionPlans: [SubscriptionPlan!]!
    mySubscription: CurrentSubscription!
    unreadMessageSummary(planId: String!, unreadTexts: [String!]!, enabled: Boolean!): AiSummaryPreview!
    matchCandidates: [MatchCandidate!]!
    blackMatchCandidates: [MatchCandidate!]!
    likedMeCandidates: [MatchCandidate!]!
    communityPosts: [CommunityPost!]!
    communityComments(postId: ID!): [CommunityComment!]!
    profileRatingSummary(userId: ID!): ProfileRatingSummary!
    rooms: [Room!]!
    messages(roomId: ID!, first: Int, after: String): [Message!]!
  }

  type Mutation {
    loginWithKakao(accessToken: String!): KakaoLoginPayload!
    requestPhoneCode(phone: String!): RequestPhoneCodePayload!
    verifyPhoneCode(phone: String!, code: String!): VerifyPhoneCodePayload!
    completePhoneSignup(
      signupToken: String!
      nickname: String!
      intro: String
      termsAccepted: Boolean!
    ): CompletePhoneSignupPayload!
    completeKakaoPhoneSignup(
      kakaoToken: String!
      signupToken: String!
      nickname: String!
      intro: String
      termsAccepted: Boolean!
    ): CompletePhoneSignupPayload!
    attachPhoneToMe(kakaoToken: String!, phone: String!, code: String!): CompletePhoneSignupPayload!
    sendMessage(roomId: ID!, text: String!, idempotencyKey: String): Message!
    editMessage(messageId: ID!, text: String!): Message!
    deleteMessage(messageId: ID!): Boolean!
    markRoomRead(roomId: ID!): Boolean!
    setTyping(roomId: ID!, typing: Boolean!): Boolean!
    likeUser(userId: ID!): LikeUserPayload!
    createCommunityPost(title: String!, body: String!): CommunityPost!
    createCommunityComment(postId: ID!, body: String!): CommunityComment!
    reportCommunityPost(postId: ID!, reason: String!): Boolean!
    rateProfile(userId: ID!, score: Int!): ProfileRatingSummary!
    blockUser(userId: ID!): Boolean!
    reportMessage(messageId: ID!, reason: String!): Boolean!
    createUpload(filename: String!, contentType: String!): Upload!
  }

  type Subscription {
    messageCreated(roomId: ID!): Message!
    messageUpdated(roomId: ID!): Message!
    messageDeleted(roomId: ID!): ID!
    typingChanged(roomId: ID!): Boolean!
    readReceiptUpdated(roomId: ID!): Boolean!
  }
`;

export function makeSchema() {
  return createSchema<GraphQLContext>({
    typeDefs,
    resolvers: {
      VerifyPhoneCodePayload: {
        __resolveType(value: { status: string }) {
          return value.status === "LOGIN"
            ? "LoginPayload"
            : "SignupRequiredPayload";
        },
      },
      KakaoLoginPayload: {
        __resolveType(value: { requiresPhone: boolean }) {
          return value.requiresPhone ? "KakaoRequiresPhonePayload" : "KakaoLoginSuccessPayload";
        },
      },
      Query: {
        me: (_parent, _args, context) => context.currentUser ?? null,
        subscriptionPlans: () => subscriptionPlans,
        mySubscription: (_parent, _args, context) => {
          const user = requireUser(context);
          return context.subscriptionService.getCurrentSubscription(user.id);
        },
        unreadMessageSummary: (
          _parent,
          args: { planId: string; unreadTexts: string[]; enabled: boolean },
          context,
        ) => {
          requireUser(context);
          return buildUnreadMessageSummary(args);
        },
        matchCandidates: (_parent, _args, context) => {
          const user = requireUser(context);
          return context.matchingService.listCandidates(user.id);
        },
        blackMatchCandidates: async (_parent, _args, context) => {
          const user = requireUser(context);
          const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
          return context.matchingService.listBlackCandidates(user.id, subscription.planId);
        },
        likedMeCandidates: async (_parent, _args, context) => {
          const user = requireUser(context);
          const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
          return context.matchingService.listLikedMeCandidates(
            user.id,
            subscription.planId,
            context.now?.(),
          );
        },
        communityPosts: (_parent, _args, context) => {
          requireUser(context);
          return context.communityService.listPosts();
        },
        communityComments: (_parent, args: { postId: string }, context) => {
          requireUser(context);
          return context.communityService.listComments(args.postId);
        },
        profileRatingSummary: (_parent, args: { userId: string }, context) => {
          requireUser(context);
          return context.profileRatingService.getSummary(args.userId);
        },
        rooms: (_parent, _args, context) => {
          requireUser(context);
          return context.chatService.listRooms();
        },
        messages: (
          _parent,
          args: {
            roomId: string;
            first?: number | null;
            after?: string | null;
          },
          context,
        ) => {
          requireUser(context);
          return context.chatService.listMessages(args);
        },
      },
      Mutation: {
        loginWithKakao: (_parent, args: { accessToken: string }, context) =>
          context.authService.loginWithKakao(args.accessToken, context.now?.()),
        requestPhoneCode: (_parent, args: { phone: string }, context) =>
          context.phoneService.requestPhoneCode(args.phone, context.now?.(), context.requestMetadata),
        verifyPhoneCode: (
          _parent,
          args: { phone: string; code: string },
          context,
        ) =>
          context.phoneService.verifyPhoneCode(
            args.phone,
            args.code,
            context.now?.(),
          ),
        completePhoneSignup: (
          _parent,
          args: {
            signupToken: string;
            nickname: string;
            intro?: string | null;
            termsAccepted: boolean;
          },
          context,
        ) =>
          context.phoneService.completePhoneSignup(
            args.signupToken,
            args.nickname,
            args.termsAccepted,
            context.now?.(),
            args.intro ?? "",
          ),
        completeKakaoPhoneSignup: async (
          _parent,
          args: {
            kakaoToken: string;
            signupToken: string;
            nickname: string;
            intro?: string | null;
            termsAccepted: boolean;
          },
          context,
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
          _parent,
          args: { kakaoToken: string; phone: string; code: string },
          context,
        ) => {
          const user = await context.phoneService.verifyExistingPhone(args.phone, args.code, context.now?.());

          return context.authService.attachPhoneUser(args.kakaoToken, user, context.now?.());
        },
        sendMessage: (
          _parent,
          args: {
            roomId: string;
            text: string;
            idempotencyKey?: string | null;
          },
          context,
        ) => {
          requireUser(context);
          return context.chatService.sendMessage(args, context.now?.());
        },
        editMessage: (
          _parent,
          args: { messageId: string; text: string },
          context,
        ) => {
          requireUser(context);
          return context.chatService.editMessage(args);
        },
        deleteMessage: (_parent, args: { messageId: string }, context) => {
          requireUser(context);
          return context.chatService.deleteMessage(args.messageId);
        },
        markRoomRead: (_parent, args: { roomId: string }, context) => {
          requireUser(context);
          return context.chatService.markRoomRead(args.roomId);
        },
        setTyping: (_parent, args: { roomId: string; typing: boolean }, context) => {
          requireUser(context);
          return context.chatService.setTyping(args.roomId, args.typing);
        },
        likeUser: async (_parent, args: { userId: string }, context) => {
          const user = requireUser(context);
          const subscription = await context.subscriptionService.getCurrentSubscription(user.id);
          return context.matchingService.likeUser(
            user.id,
            args.userId,
            subscription.planId,
            context.now?.() ?? new Date(),
          );
        },
        createCommunityPost: (_parent, args: { title: string; body: string }, context) => {
          const user = requireUser(context);
          return context.communityService.createPost(user.id, args, context.now?.());
        },
        createCommunityComment: (_parent, args: { postId: string; body: string }, context) => {
          const user = requireUser(context);
          return context.communityService.createComment(user.id, args.postId, args.body, context.now?.());
        },
        reportCommunityPost: (_parent, args: { postId: string; reason: string }, context) => {
          const user = requireUser(context);
          return context.communityService.reportPost(user.id, args.postId, args.reason);
        },
        rateProfile: (_parent, args: { userId: string; score: number }, context) => {
          const user = requireUser(context);
          return context.profileRatingService.rateProfile(user.id, args.userId, args.score);
        },
        blockUser: (_parent, args: { userId: string }, context) => {
          const user = requireUser(context);
          return context.chatService.blockUser(user.id, args.userId);
        },
        reportMessage: (_parent, args: { messageId: string; reason: string }, context) => {
          const user = requireUser(context);
          return context.chatService.reportMessage(user.id, args.messageId, args.reason);
        },
        createUpload: (
          _parent,
          args: { filename: string; contentType: string },
          context,
        ) => {
          requireUser(context);
          return context.uploadService.createUpload(args);
        },
      },
      Subscription: {
        messageCreated: {
          subscribe: (_parent, args: { roomId: string }, context) => {
            requireUser(context);
            return context.chatService.subscribeMessageCreated(args.roomId);
          },
          resolve: (event) => event,
        },
        messageUpdated: {
          subscribe: (_parent, args: { roomId: string }, context) => {
            requireUser(context);
            return context.chatService.subscribeMessageUpdated(args.roomId);
          },
          resolve: (event) => event,
        },
        messageDeleted: {
          subscribe: (_parent, args: { roomId: string }, context) => {
            requireUser(context);
            return context.chatService.subscribeMessageDeleted(args.roomId);
          },
          resolve: (event: { messageId: string }) => event.messageId,
        },
        typingChanged: {
          subscribe: (_parent, args: { roomId: string }, context) => {
            requireUser(context);
            return context.chatService.subscribeTypingChanged(args.roomId);
          },
          resolve: (event: { typing: boolean }) => event.typing,
        },
        readReceiptUpdated: {
          subscribe: (_parent, args: { roomId: string }, context) => {
            requireUser(context);
            return context.chatService.subscribeReadReceiptUpdated(args.roomId);
          },
          resolve: (event: { read: boolean }) => event.read,
        },
      },
    },
  });
}

function requireUser(context: GraphQLContext): User {
  if (!context.currentUser) {
    throw new GraphQLError("AUTH_REQUIRED");
  }

  return context.currentUser;
}
