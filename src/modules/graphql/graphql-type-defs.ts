export const graphQLTypeDefs = /* GraphQL */ `
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
