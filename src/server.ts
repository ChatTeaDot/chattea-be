import { createServer } from "node:http";
import { createYoga, maskError as yogaMaskError } from "graphql-yoga";
import { useServer } from "graphql-ws/use/ws";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import { AuthService, PostgresAuthService } from "./auth/auth-service.js";
import { PostgresSessionStore, SessionStore, type SessionStoreLike } from "./auth/session-store.js";
import { ChatService, PostgresChatService } from "./chat/chat-service.js";
import { CommunityService, PostgresCommunityService } from "./community/community-service.js";
import { readEnv } from "./env.js";
import { makeSchema, type GraphQLContext } from "./graphql/schema.js";
import { KakaoRestClient } from "./kakao/kakao-client.js";
import { MatchingService, PostgresMatchingService } from "./matching/matching-service.js";
import { createRedactingLogger } from "./observability/logger.js";
import { initializeObservability } from "./observability/instrument.js";
import { HttpReporter, MultiReporter, NoopReporter, type ObservabilityReporter } from "./observability/reporter.js";
import type { PhoneRequestMetadata } from "./phone/phone-service.js";
import { PhoneService, PostgresPhoneService } from "./phone/phone-service.js";
import { PostgresProfileRatingService, ProfileRatingService } from "./profile/profile-rating-service.js";
import { InMemorySmsSender, MunjanaraSmsSender, type SmsSender } from "./sms/sms-sender.js";
import { PostgresSubscriptionService, SubscriptionService } from "./subscription/subscription-service.js";
import { DevUploadSigner, R2UploadSigner, UploadService, type UploadSigner } from "./upload/upload-service.js";

type CreateAppOptions = {
  authService?: AuthService;
  chatService?: ChatService | PostgresChatService;
  communityService?: CommunityService | PostgresCommunityService;
  matchingService?: MatchingService | PostgresMatchingService;
  phoneService?: PhoneService | PostgresPhoneService;
  phoneCodePepper?: string;
  profileRatingService?: ProfileRatingService | PostgresProfileRatingService;
  smsSender?: SmsSender;
  sessionStore?: SessionStoreLike;
  subscriptionService?: SubscriptionService | PostgresSubscriptionService;
  uploadService?: UploadService;
  now?: () => Date;
};

export function createApp(options: CreateAppOptions = {}) {
  const env = readEnv();
  initializeObservability(env);
  const pool = env.databaseUrl ? new Pool({ connectionString: env.databaseUrl }) : null;
  const sessionStore = options.sessionStore ?? (pool ? new PostgresSessionStore(pool) : new SessionStore());
  const phoneService =
    options.phoneService ??
    (pool
      ? new PostgresPhoneService(
          pool,
          options.smsSender ?? createSmsSender(env),
          options.phoneCodePepper ?? env.phoneCodePepper,
          sessionStore,
        )
      : new PhoneService(
          options.smsSender ?? createSmsSender(env),
          options.phoneCodePepper ?? env.phoneCodePepper,
          sessionStore,
        ));
  const authService =
    options.authService ??
    (pool ? new PostgresAuthService(new KakaoRestClient(), pool, sessionStore) : new AuthService(new KakaoRestClient(), sessionStore));
  const chatService = options.chatService ?? createChatService(env, pool);
  const communityService = options.communityService ?? createCommunityService(env, pool);
  const matchingService = options.matchingService ?? createMatchingService(env, pool);
  const profileRatingService = options.profileRatingService ?? createProfileRatingService(env, pool);
  const subscriptionService = options.subscriptionService ?? createSubscriptionService(env, pool);
  const uploadService = options.uploadService ?? new UploadService(createUploadSigner(env));
  const baseContext = options.now
    ? { authService, chatService, communityService, matchingService, phoneService, profileRatingService, subscriptionService, uploadService, now: options.now }
    : { authService, chatService, communityService, matchingService, phoneService, profileRatingService, subscriptionService, uploadService };
  const schema = makeSchema();
  const yoga = createYoga<GraphQLContext>({
    schema,
    async context({ request }) {
      return {
        ...baseContext,
        currentUser: await sessionStore.getUser(readBearerToken(request)),
        requestMetadata: readRequestMetadata(request),
      };
    },
    logging: createRedactingLogger(undefined, createObservabilityReporter(env)),
    maskedErrors: {
      maskError(error, message, isDev) {
        if (error instanceof Error && error.message === "AUTH_REQUIRED") {
          return error;
        }

        return yogaMaskError(error, message, isDev);
      },
    },
  });
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    yoga(request, response);
  });
  const wsServer = new WebSocketServer({ server, path: "/graphql" });

  useServer({
    schema,
    context: async (context) => ({
      ...baseContext,
      currentUser: await sessionStore.getUser(readBearerTokenFromValue(context.connectionParams)),
    }),
  }, wsServer);

  return server;
}

function createObservabilityReporter(env: ReturnType<typeof readEnv>): ObservabilityReporter {
  const reporters: ObservabilityReporter[] = [];

  if (env.sentryEnvelopeEndpoint) {
    reporters.push(new HttpReporter({ endpoint: env.sentryEnvelopeEndpoint, service: "sentry" }));
  }

  if (env.datadogLogEndpoint) {
    reporters.push(
      new HttpReporter({
        endpoint: env.datadogLogEndpoint,
        service: "datadog",
        apiKey: env.datadogApiKey,
      }),
    );
  }

  return reporters.length ? new MultiReporter(reporters) : new NoopReporter();
}

function createUploadSigner(env: ReturnType<typeof readEnv>): UploadSigner {
  if (!env.r2AccountId && !env.r2AccessKeyId && !env.r2SecretAccessKey && !env.r2Bucket) {
    return new DevUploadSigner();
  }

  if (!env.r2AccountId || !env.r2AccessKeyId || !env.r2SecretAccessKey || !env.r2Bucket) {
    throw new Error("R2_CONFIG_REQUIRED");
  }

  return new R2UploadSigner({
    accountId: env.r2AccountId,
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
    bucket: env.r2Bucket,
  });
}

function readRequestMetadata(request: Request): PhoneRequestMetadata {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip");

  return {
    ip: forwardedFor || realIp || null,
    userAgent: request.headers.get("user-agent"),
  };
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

function readBearerTokenFromValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("authorization" in value)) {
    return null;
  }

  const authorization = (value as { authorization?: unknown }).authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
}

function createSmsSender(env: ReturnType<typeof readEnv>): SmsSender {
  if (env.smsProvider !== "munjanara") {
    return new InMemorySmsSender();
  }

  if (!env.munjanaraEndpoint || !env.munjanaraUserId || !env.munjanaraApiKey) {
    throw new Error("MUNJANARA_CONFIG_REQUIRED");
  }

  return new MunjanaraSmsSender({
    endpoint: env.munjanaraEndpoint,
    userId: env.munjanaraUserId,
    apiKey: env.munjanaraApiKey,
    senderId: env.smsSenderId,
  });
}

function createChatService(env: ReturnType<typeof readEnv>, pool: Pool | null) {
  if (!env.databaseUrl || !pool) {
    return new ChatService();
  }

  return new PostgresChatService(pool);
}

function createMatchingService(env: ReturnType<typeof readEnv>, pool: Pool | null) {
  if (!env.databaseUrl || !pool) {
    return new MatchingService();
  }

  return new PostgresMatchingService(pool);
}

function createCommunityService(env: ReturnType<typeof readEnv>, pool: Pool | null) {
  if (!env.databaseUrl || !pool) {
    return new CommunityService();
  }

  return new PostgresCommunityService(pool);
}

function createProfileRatingService(env: ReturnType<typeof readEnv>, pool: Pool | null) {
  if (!env.databaseUrl || !pool) {
    return new ProfileRatingService();
  }

  return new PostgresProfileRatingService(pool);
}

function createSubscriptionService(env: ReturnType<typeof readEnv>, pool: Pool | null) {
  if (!env.databaseUrl || !pool) {
    return new SubscriptionService();
  }

  return new PostgresSubscriptionService(pool);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = readEnv();
  createApp().listen(env.port, () => {
    console.log(`chattea-be listening on :${env.port}`);
  });
}
