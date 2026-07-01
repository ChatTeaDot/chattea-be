import { createServer } from "node:http";
import { createYoga, maskError as yogaMaskError } from "graphql-yoga";
import { useServer } from "graphql-ws/use/ws";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import { AuthService } from "./modules/auth/auth.service.js";
import { SessionStore, type SessionStoreLike } from "./modules/auth/session.repository.js";
import { ChatService } from "./modules/chat/chat.service.js";
import { CommunityService } from "./modules/community/community.service.js";
import { readEnv } from "./env.js";
import { makeSchema, type GraphQLContext } from "./modules/graphql/graphql.module.js";
import { KakaoRestClient } from "./modules/auth/kakao.strategy.js";
import { MatchingService } from "./modules/matching/matching.service.js";
import { createRedactingLogger } from "./observability/logger.js";
import { initializeObservability } from "./observability/instrument.js";
import { HttpReporter, MultiReporter, NoopReporter, type ObservabilityReporter } from "./observability/reporter.js";
import type { PhoneRequestMetadata } from "./modules/auth/phone.service.js";
import { PhoneService } from "./modules/auth/phone.service.js";
import { ProfileRatingService } from "./modules/profile/profile-rating.service.js";
import { MunjanaraSmsSender, type SmsSender } from "./modules/auth/sms-sender.service.js";
import { SubscriptionService } from "./modules/subscription/subscription.service.js";
import { DevUploadSigner, R2UploadSigner, UploadService, type UploadSigner } from "./modules/upload/upload.service.js";

type CreateAppOptions = {
  authService?: AuthService;
  chatService?: ChatService;
  communityService?: CommunityService;
  matchingService?: MatchingService;
  phoneService?: PhoneService;
  phoneCodePepper?: string;
  profileRatingService?: ProfileRatingService;
  smsSender?: SmsSender;
  sessionStore?: SessionStoreLike;
  subscriptionService?: SubscriptionService;
  uploadService?: UploadService;
  now?: () => Date;
};

export function createApp(options: CreateAppOptions = {}) {
  const env = readEnv();
  initializeObservability(env);
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  const pool = new Pool({ connectionString: env.databaseUrl });
  const db = drizzle(pool);
  const sessionStore = options.sessionStore ?? new SessionStore(db);
  const phoneService =
    options.phoneService ??
    new PhoneService(
      db,
      options.smsSender ?? createSmsSender(env),
      options.phoneCodePepper ?? env.phoneCodePepper,
      sessionStore,
    );
  const authService =
    options.authService ??
    new AuthService(new KakaoRestClient(), db, sessionStore);
  const chatService = options.chatService ?? new ChatService(db);
  const communityService = options.communityService ?? new CommunityService(db);
  const matchingService = options.matchingService ?? new MatchingService(db);
  const profileRatingService = options.profileRatingService ?? new ProfileRatingService(db);
  const subscriptionService = options.subscriptionService ?? new SubscriptionService(db);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = readEnv();
  createApp().listen(env.port, () => {
    console.log(`chattea-be listening on :${env.port}`);
  });
}
