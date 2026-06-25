import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { AuthService } from "../src/auth/auth-service.js";
import { SessionStore } from "../src/auth/session-store.js";
import { createApp } from "../src/server.js";
import { InMemorySmsSender } from "../src/sms/sms-sender.js";
import { MatchingService } from "../src/matching/matching-service.js";
import { SubscriptionService } from "../src/subscription/subscription-service.js";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
    };
  }>;
};

async function graphql<T>(
  port: number,
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });

  return (await response.json()) as GraphQLResponse<T>;
}

describe("GraphQL phone flow", () => {
  const sms = new InMemorySmsSender();
  let now = new Date("2026-06-25T00:00:00.000Z");
  let chatHeaders: Record<string, string>;
  const matchingService = new MatchingService();
  let subscriptionService = new SubscriptionService();
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const sessionStore = new SessionStore();
    subscriptionService = new SubscriptionService();
    matchingService["candidates"].set("chat-user", {
      id: "chat-user",
      nickname: "chattea",
      intro: "매칭 테스트",
      planId: "black",
      blackRecommended: false,
    });
    matchingService["candidates"].set("liked-me-user", {
      id: "liked-me-user",
      nickname: "누군가",
      intro: "반갑습니다",
      planId: "basic",
      blackRecommended: false,
    });
    matchingService.likeUser("liked-me-user", "chat-user", "black");
    const session = await sessionStore.createSession({
      id: "chat-user",
      phoneE164: "+821099998888",
      nickname: "chattea",
      intro: "",
    });
    subscriptionService.setCurrentPlanForTest("chat-user", "black");
    chatHeaders = { authorization: `Bearer ${session.session.token}` };
    server = createApp({
      authService: new AuthService({
        getProfile: async () => ({ id: "kakao-1", nickname: "tea" }),
      }, sessionStore),
      sessionStore,
      smsSender: sms,
      subscriptionService,
      matchingService,
      phoneCodePepper: "test-pepper",
      now: () => now,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address missing");
    }
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("requests code, creates user after signup token, then logs in existing phone", async () => {
    const requestCode = await graphql<{ requestPhoneCode: { ok: boolean } }>(
      port,
      `
        mutation RequestPhoneCode($phone: String!) {
          requestPhoneCode(phone: $phone) {
            ok
          }
        }
      `,
      { phone: "01012345678" },
    );

    expect(requestCode.errors).toBeUndefined();
    expect(requestCode.data?.requestPhoneCode.ok).toBe(true);

    const verifyNew = await graphql<{
      verifyPhoneCode: { status: "SIGNUP_REQUIRED"; signupToken: string };
    }>(
      port,
      `
        mutation VerifyPhoneCode($phone: String!, $code: String!) {
          verifyPhoneCode(phone: $phone, code: $code) {
            __typename
            ... on SignupRequiredPayload {
              status
              signupToken
            }
          }
        }
      `,
      { phone: "01012345678", code: sms.messages[0]!.code },
    );

    expect(verifyNew.errors).toBeUndefined();
    expect(verifyNew.data?.verifyPhoneCode.status).toBe("SIGNUP_REQUIRED");

    const complete = await graphql<{
      completePhoneSignup: {
        user: { phoneE164: string; intro: string };
        session: { token: string };
      };
    }>(
      port,
      `
        mutation CompletePhoneSignup(
          $signupToken: String!
          $nickname: String!
          $intro: String!
          $termsAccepted: Boolean!
        ) {
          completePhoneSignup(
            signupToken: $signupToken
            nickname: $nickname
            intro: $intro
            termsAccepted: $termsAccepted
          ) {
            session {
              token
            }
            user {
              phoneE164
              intro
            }
          }
        }
      `,
      {
        signupToken: verifyNew.data!.verifyPhoneCode.signupToken,
        nickname: "tea",
        intro: "차 한잔 같은 대화",
        termsAccepted: true,
      },
    );

    expect(complete.errors).toBeUndefined();
    expect(complete.data?.completePhoneSignup.user.phoneE164).toBe(
      "+821012345678",
    );
    expect(complete.data?.completePhoneSignup.user.intro).toBe("차 한잔 같은 대화");

    const meAfterSignup = await graphql<{ me: { phoneE164: string } }>(
      port,
      `
        query {
          me {
            phoneE164
          }
        }
      `,
      undefined,
      { authorization: `Bearer ${complete.data!.completePhoneSignup.session.token}` },
    );

    expect(meAfterSignup.errors).toBeUndefined();
    expect(meAfterSignup.data?.me.phoneE164).toBe("+821012345678");

    now = new Date("2026-06-25T00:01:00.000Z");
    await graphql(
      port,
      `
        mutation {
          requestPhoneCode(phone: "01012345678") {
            ok
          }
        }
      `,
    );
    const verifyExisting = await graphql<{
      verifyPhoneCode: { status: "LOGIN"; session: { token: string } };
    }>(
      port,
      `
        mutation VerifyPhoneCode($phone: String!, $code: String!) {
          verifyPhoneCode(phone: $phone, code: $code) {
            __typename
            ... on LoginPayload {
              status
              session {
                token
              }
            }
          }
        }
      `,
      { phone: "01012345678", code: sms.messages[1]!.code },
    );

    expect(verifyExisting.errors).toBeUndefined();
    expect(verifyExisting.data?.verifyPhoneCode.status).toBe("LOGIN");
    expect(verifyExisting.data?.verifyPhoneCode.session.token).toBeTruthy();

    const meAfterLogin = await graphql<{ me: { phoneE164: string } }>(
      port,
      `
        query {
          me {
            phoneE164
          }
        }
      `,
      undefined,
      { authorization: `Bearer ${verifyExisting.data!.verifyPhoneCode.session.token}` },
    );

    expect(meAfterLogin.data?.me.phoneE164).toBe("+821012345678");
  });

  it("returns phone-required payload for Kakao login before phone verification", async () => {
    const login = await graphql<{
      loginWithKakao: {
        __typename: "KakaoRequiresPhonePayload";
        kakaoToken: string;
        nickname: string;
        requiresPhone: boolean;
      };
    }>(
      port,
      `
        mutation LoginWithKakao($accessToken: String!) {
          loginWithKakao(accessToken: $accessToken) {
            __typename
            ... on KakaoRequiresPhonePayload {
              requiresPhone
              kakaoToken
              nickname
            }
          }
        }
      `,
      { accessToken: "access-token" },
    );

    expect(login.errors).toBeUndefined();
    expect(login.data?.loginWithKakao.__typename).toBe("KakaoRequiresPhonePayload");
    expect(login.data?.loginWithKakao.requiresPhone).toBe(true);
    expect(login.data?.loginWithKakao.kakaoToken).toBeTruthy();
    expect(login.data?.loginWithKakao.nickname).toBe("tea");
  });

  it("links Kakao login to a newly verified phone signup", async () => {
    const login = await graphql<{
      loginWithKakao: {
        __typename: "KakaoRequiresPhonePayload";
        kakaoToken: string;
      };
    }>(
      port,
      `
        mutation {
          loginWithKakao(accessToken: "access-token") {
            __typename
            ... on KakaoRequiresPhonePayload {
              kakaoToken
            }
          }
        }
      `,
    );
    const kakaoToken = login.data!.loginWithKakao.kakaoToken;

    await graphql(
      port,
      `
        mutation {
          requestPhoneCode(phone: "01033334444") {
            ok
          }
        }
      `,
    );

    const code = sms.messages.at(-1)!.code;
    const verified = await graphql<{
      verifyPhoneCode: { status: "SIGNUP_REQUIRED"; signupToken: string };
    }>(
      port,
      `
        mutation {
          verifyPhoneCode(phone: "01033334444", code: "${code}") {
            __typename
            ... on SignupRequiredPayload {
              status
              signupToken
            }
          }
        }
      `,
    );

    const complete = await graphql<{
      completeKakaoPhoneSignup: {
        session: { userId: string };
        user: { phoneE164: string };
      };
    }>(
      port,
      `
        mutation CompleteKakaoPhoneSignup($kakaoToken: String!, $signupToken: String!) {
          completeKakaoPhoneSignup(
            kakaoToken: $kakaoToken
            signupToken: $signupToken
            nickname: "tea"
            termsAccepted: true
          ) {
            session {
              userId
            }
            user {
              phoneE164
            }
          }
        }
      `,
      {
        kakaoToken,
        signupToken: verified.data!.verifyPhoneCode.signupToken,
      },
    );
    const nextLogin = await graphql<{
      loginWithKakao: {
        __typename: "KakaoLoginSuccessPayload";
        requiresPhone: boolean;
        user: { phoneE164: string };
      };
    }>(
      port,
      `
        mutation {
          loginWithKakao(accessToken: "access-token") {
            __typename
            ... on KakaoLoginSuccessPayload {
              requiresPhone
              user {
                phoneE164
              }
            }
          }
        }
      `,
    );

    expect(complete.errors).toBeUndefined();
    expect(complete.data?.completeKakaoPhoneSignup.user.phoneE164).toBe("+821033334444");
    expect(nextLogin.errors).toBeUndefined();
    expect(nextLogin.data?.loginWithKakao.requiresPhone).toBe(false);
    expect(nextLogin.data?.loginWithKakao.user.phoneE164).toBe("+821033334444");
  });

  it("lists rooms and sends messages idempotently", async () => {
    const unauthenticated = await graphql<{ rooms: Array<{ id: string }> }>(
      port,
      `
        query {
          rooms {
            id
          }
        }
      `,
    );
    const sendOne = await graphql<{
      sendMessage: { id: string; roomId: string; text: string };
    }>(
      port,
      `
        mutation SendMessage(
          $roomId: ID!
          $text: String!
          $idempotencyKey: String
        ) {
          sendMessage(
            roomId: $roomId
            text: $text
            idempotencyKey: $idempotencyKey
          ) {
            id
            roomId
            text
          }
        }
      `,
      {
        roomId: "demo-room",
        text: "안녕하세요",
        idempotencyKey: "temp-graphql-1",
      },
      chatHeaders,
    );
    const sendTwo = await graphql<{
      sendMessage: { id: string; roomId: string; text: string };
    }>(
      port,
      `
        mutation SendMessage(
          $roomId: ID!
          $text: String!
          $idempotencyKey: String
        ) {
          sendMessage(
            roomId: $roomId
            text: $text
            idempotencyKey: $idempotencyKey
          ) {
            id
            roomId
            text
          }
        }
      `,
      {
        roomId: "demo-room",
        text: "안녕하세요",
        idempotencyKey: "temp-graphql-1",
      },
      chatHeaders,
    );

    expect(unauthenticated.errors?.[0]?.message).toBe("AUTH_REQUIRED");
    expect(sendOne.errors).toBeUndefined();
    expect(sendTwo.errors).toBeUndefined();
    expect(sendTwo.data?.sendMessage.id).toBe(sendOne.data?.sendMessage.id);

    const rooms = await graphql<{
      rooms: Array<{ id: string; lastMessage: string }>;
    }>(
      port,
      `
        query {
          rooms {
            id
            lastMessage
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const messages = await graphql<{
      messages: Array<{ id: string; text: string }>;
    }>(
      port,
      `
        query {
          messages(roomId: "demo-room", first: 20) {
            id
            text
          }
        }
      `,
      undefined,
      chatHeaders,
    );

    expect(
      rooms.data?.rooms.find((room) => room.id === "demo-room")?.lastMessage,
    ).toBe("안녕하세요");
    expect(
      messages.data?.messages.filter(
        (message) => message.text === "안녕하세요",
      ),
    ).toHaveLength(1);
  });

  it("edits, deletes, and marks room read through GraphQL", async () => {
    const sent = await graphql<{ sendMessage: { id: string } }>(
      port,
      `
        mutation {
          sendMessage(roomId: "demo-room", text: "before") {
            id
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const messageId = sent.data!.sendMessage.id;

    const edited = await graphql<{ editMessage: { id: string; text: string } }>(
      port,
      `
        mutation EditMessage($messageId: ID!, $text: String!) {
          editMessage(messageId: $messageId, text: $text) {
            id
            text
          }
        }
      `,
      { messageId, text: "after" },
      chatHeaders,
    );
    const read = await graphql<{ markRoomRead: boolean }>(
      port,
      `
        mutation {
          markRoomRead(roomId: "demo-room")
        }
      `,
      undefined,
      chatHeaders,
    );
    const typing = await graphql<{ setTyping: boolean }>(
      port,
      `
        mutation {
          setTyping(roomId: "demo-room", typing: true)
        }
      `,
      undefined,
      chatHeaders,
    );
    const report = await graphql<{ reportMessage: boolean }>(
      port,
      `
        mutation ReportMessage($messageId: ID!) {
          reportMessage(messageId: $messageId, reason: "불쾌한 메시지")
        }
      `,
      { messageId },
      chatHeaders,
    );
    const block = await graphql<{ blockUser: boolean }>(
      port,
      `
        mutation {
          blockUser(userId: "blocked-user")
        }
      `,
      undefined,
      chatHeaders,
    );
    const deleted = await graphql<{ deleteMessage: boolean }>(
      port,
      `
        mutation DeleteMessage($messageId: ID!) {
          deleteMessage(messageId: $messageId)
        }
      `,
      { messageId },
      chatHeaders,
    );

    expect(edited.errors).toBeUndefined();
    expect(edited.data?.editMessage.text).toBe("after");
    expect(read.data?.markRoomRead).toBe(true);
    expect(typing.data?.setTyping).toBe(true);
    expect(report.data?.reportMessage).toBe(true);
    expect(block.data?.blockUser).toBe(true);
    expect(deleted.data?.deleteMessage).toBe(true);
  });

  it("lists match candidates and records likes", async () => {
    const candidates = await graphql<{
      matchCandidates: Array<{ id: string; nickname: string; likedByMe: boolean; planId: string; blackRecommended: boolean }>;
    }>(
      port,
      `
        query {
          matchCandidates {
            id
            nickname
            likedByMe
            planId
            blackRecommended
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const like = await graphql<{ likeUser: { matched: boolean; roomId: string | null } }>(
      port,
      `
        mutation {
          likeUser(userId: "demo-match-user") {
            matched
            roomId
          }
        }
      `,
      undefined,
      chatHeaders,
    );

    expect(candidates.errors).toBeUndefined();
    expect(candidates.data?.matchCandidates[0]).toMatchObject({
      id: "demo-match-user",
      nickname: "차한잔",
      likedByMe: false,
      planId: "black",
      blackRecommended: true,
    });
    expect(like.errors).toBeUndefined();
    expect(like.data?.likeUser).toEqual({ matched: false, roomId: null });
  });

  it("returns liked-me candidates to paid users", async () => {
    const result = await graphql<{
      likedMeCandidates: Array<{ id: string; nickname: string; likedByMe: boolean; planId: string; blackRecommended: boolean }>;
    }>(
      port,
      `
        query {
          likedMeCandidates {
            id
            nickname
            likedByMe
            planId
            blackRecommended
          }
        }
      `,
      undefined,
      chatHeaders,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.likedMeCandidates).toEqual([
      {
        id: "liked-me-user",
        nickname: "누군가",
        likedByMe: false,
        planId: "basic",
        blackRecommended: false,
      },
    ]);
  });

  it("blocks liked-me candidates for free users", async () => {
    subscriptionService.setCurrentPlanForTest("chat-user", "free");
    try {
      const blocked = await graphql<{
        likedMeCandidates: Array<{ id: string; nickname: string }>;
      }>(
        port,
        `
          query {
            likedMeCandidates {
              id
              nickname
            }
          }
        `,
        undefined,
        chatHeaders,
      );

      expect(blocked.errors).toHaveLength(1);
      expect(blocked.errors?.[0]?.extensions?.code).toBe("INTERNAL_SERVER_ERROR");
      expect(blocked.data).toBeNull();
    } finally {
      subscriptionService.setCurrentPlanForTest("chat-user", "black");
    }
  });

  it("returns documented subscription plans", async () => {
    const plans = await graphql<{
      subscriptionPlans: Array<{ id: string; name: string; monthlyPriceKrw: number }>;
    }>(
      port,
      `
        query {
          subscriptionPlans {
            id
            name
            monthlyPriceKrw
          }
        }
      `,
    );

    expect(plans.errors).toBeUndefined();
    expect(plans.data?.subscriptionPlans).toEqual([
      { id: "free", name: "Free", monthlyPriceKrw: 0 },
      { id: "basic", name: "Basic", monthlyPriceKrw: 4900 },
      { id: "gold", name: "Gold", monthlyPriceKrw: 9900 },
      { id: "black", name: "Black", monthlyPriceKrw: 24900 },
    ]);
  });

  it("returns current subscription and Black recommendations", async () => {
    const result = await graphql<{
      mySubscription: { planId: string };
      blackMatchCandidates: Array<{ id: string; blackRecommended: boolean }>;
    }>(
      port,
      `
        query {
          mySubscription {
            planId
          }
          blackMatchCandidates {
            id
            blackRecommended
          }
        }
      `,
      undefined,
      chatHeaders,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.mySubscription).toEqual({ planId: "black" });
    expect(result.data?.blackMatchCandidates[0]).toEqual({
      id: "demo-match-user",
      blackRecommended: true,
    });
  });

  it("returns unread message summary previews for eligible plans", async () => {
    const summary = await graphql<{
      unreadMessageSummary: {
        available: boolean;
        reason: string | null;
        sourceText: string;
        summary: string | null;
      };
    }>(
      port,
      `
        query Summary($planId: String!, $unreadTexts: [String!]!, $enabled: Boolean!) {
          unreadMessageSummary(planId: $planId, unreadTexts: $unreadTexts, enabled: $enabled) {
            available
            reason
            sourceText
            summary
          }
        }
      `,
      {
        planId: "gold",
        unreadTexts: ["오늘 대화가 길어져서 안읽은 메시지 요약을 보여줄 수 있습니다."],
        enabled: true,
      },
      chatHeaders,
    );

    expect(summary.errors).toBeUndefined();
    expect(summary.data?.unreadMessageSummary.available).toBe(true);
    expect(summary.data?.unreadMessageSummary.summary).toContain("최근 안읽은 대화 요약");
  });

  it("creates, lists, comments, and reports anonymous community posts", async () => {
    const created = await graphql<{
      createCommunityPost: { id: string; anonymousNickname: string; title: string; commentCount: number };
    }>(
      port,
      `
        mutation {
          createCommunityPost(title: "연애 상담", body: "첫 대화가 어려워요") {
            id
            anonymousNickname
            title
            commentCount
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const postId = created.data!.createCommunityPost.id;
    const comment = await graphql<{ createCommunityComment: { id: string; postId: string; body: string } }>(
      port,
      `
        mutation Comment($postId: ID!) {
          createCommunityComment(postId: $postId, body: "천천히 물어보세요") {
            id
            postId
            body
          }
        }
      `,
      { postId },
      chatHeaders,
    );
    const posts = await graphql<{ communityPosts: Array<{ id: string; commentCount: number }> }>(
      port,
      `
        query {
          communityPosts {
            id
            commentCount
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const report = await graphql<{ reportCommunityPost: boolean }>(
      port,
      `
        mutation Report($postId: ID!) {
          reportCommunityPost(postId: $postId, reason: "신고 사유")
        }
      `,
      { postId },
      chatHeaders,
    );

    expect(created.errors).toBeUndefined();
    expect(created.data?.createCommunityPost).toMatchObject({ anonymousNickname: "익명1", title: "연애 상담", commentCount: 0 });
    expect(comment.errors).toBeUndefined();
    expect(comment.data?.createCommunityComment).toMatchObject({ postId, body: "천천히 물어보세요" });
    expect(posts.data?.communityPosts[0]).toMatchObject({ id: postId, commentCount: 1 });
    expect(report.data?.reportCommunityPost).toBe(true);
  });

  it("rates profiles without exposing rating summary on match candidates", async () => {
    const rating = await graphql<{
      rateProfile: { userId: string; averageScore: number; ratingCount: number };
    }>(
      port,
      `
        mutation {
          rateProfile(userId: "demo-match-user", score: 4) {
            userId
            averageScore
            ratingCount
          }
        }
      `,
      undefined,
      chatHeaders,
    );
    const candidates = await graphql<{
      matchCandidates: Array<{ id: string; nickname: string; likedByMe: boolean; planId: string; blackRecommended: boolean }>;
    }>(
      port,
      `
        query {
          matchCandidates {
            id
            nickname
            likedByMe
            planId
            blackRecommended
          }
        }
      `,
      undefined,
      chatHeaders,
    );

    expect(rating.errors).toBeUndefined();
    expect(rating.data?.rateProfile).toEqual({ userId: "demo-match-user", averageScore: 4, ratingCount: 1 });
    expect(candidates.errors).toBeUndefined();
    expect(candidates.data?.matchCandidates[0]).toEqual({
      id: "demo-match-user",
      nickname: "차한잔",
      likedByMe: true,
      planId: "black",
      blackRecommended: true,
    });
  });

  it("creates upload signing payloads", async () => {
    const unauthenticated = await graphql<{ createUpload: { id: string } }>(
      port,
      `
        mutation {
          createUpload(filename: "photo.jpg", contentType: "image/jpeg") {
            id
          }
        }
      `,
    );
    const upload = await graphql<{
      createUpload: { id: string; putUrl: string };
    }>(
      port,
      `
        mutation CreateUpload($filename: String!, $contentType: String!) {
          createUpload(filename: $filename, contentType: $contentType) {
            id
            putUrl
          }
        }
      `,
      { filename: "photo.jpg", contentType: "image/jpeg" },
      chatHeaders,
    );

    expect(unauthenticated.errors?.[0]?.message).toBe("AUTH_REQUIRED");
    expect(upload.errors).toBeUndefined();
    expect(upload.data?.createUpload.id).toBeTruthy();
    expect(upload.data?.createUpload.putUrl).toContain("uploads.invalid");
  });

  it("applies IP rate limit from request headers", async () => {
    for (let index = 0; index < 20; index += 1) {
      const request = await graphql<{ requestPhoneCode: { ok: boolean } }>(
        port,
        `
          mutation RequestPhoneCode($phone: String!) {
            requestPhoneCode(phone: $phone) {
              ok
            }
          }
        `,
        { phone: `010200000${String(index).padStart(2, "0")}` },
        { "x-forwarded-for": "198.51.100.1", "user-agent": "vitest" },
      );

      expect(request.errors).toBeUndefined();
    }

    const sentBeforeLimit = sms.messages.length;
    const limited = await graphql<{ requestPhoneCode: { ok: boolean } }>(
      port,
      `
        mutation RequestPhoneCode($phone: String!) {
          requestPhoneCode(phone: $phone) {
            ok
          }
        }
      `,
      { phone: "01020000020" },
      { "x-forwarded-for": "198.51.100.1", "user-agent": "vitest" },
    );

    expect(limited.errors).toHaveLength(1);
    expect(sms.messages).toHaveLength(sentBeforeLimit);
  });
});
