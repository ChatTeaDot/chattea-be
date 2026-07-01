export type Env = {
  nodeEnv: string;
  port: number;
  databaseUrl: string | null;
  serviceName: string;
  serviceEnv: string;
  serviceVersion: string;
  phoneCodePepper: string;
  smsProvider: "munjanara";
  smsSenderId: string;
  munjanaraEndpoint: string | null;
  munjanaraUserId: string | null;
  munjanaraApiKey: string | null;
  r2AccountId: string | null;
  r2AccessKeyId: string | null;
  r2SecretAccessKey: string | null;
  r2Bucket: string | null;
  sentryDsn: string | null;
  sentryEnvelopeEndpoint: string | null;
  datadogApmEnabled: boolean;
  datadogLogEndpoint: string | null;
  datadogApiKey: string | null;
};

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env: Env = {
    nodeEnv: source.NODE_ENV ?? "development",
    port: Number(source.PORT ?? 4000),
    databaseUrl: source.DATABASE_URL ?? null,
    serviceName: source.SERVICE_NAME ?? "chattea-be",
    serviceEnv: source.SERVICE_ENV ?? source.NODE_ENV ?? "development",
    serviceVersion: source.SERVICE_VERSION ?? "dev",
    phoneCodePepper: source.PHONE_CODE_PEPPER ?? "dev-only-pepper",
    smsProvider: "munjanara",
    smsSenderId: source.SMS_SENDER_ID ?? "dev-sender",
    munjanaraEndpoint: source.MUNJANARA_ENDPOINT ?? null,
    munjanaraUserId: source.MUNJANARA_USER_ID ?? null,
    munjanaraApiKey: source.MUNJANARA_API_KEY ?? null,
    r2AccountId: source.R2_ACCOUNT_ID ?? null,
    r2AccessKeyId: source.R2_ACCESS_KEY_ID ?? null,
    r2SecretAccessKey: source.R2_SECRET_ACCESS_KEY ?? null,
    r2Bucket: source.R2_BUCKET ?? null,
    sentryDsn: source.SENTRY_DSN ?? null,
    sentryEnvelopeEndpoint: source.SENTRY_ENVELOPE_ENDPOINT ?? null,
    datadogApmEnabled: source.DATADOG_APM_ENABLED === "true" || source.DD_TRACE_ENABLED === "true",
    datadogLogEndpoint: source.DATADOG_LOG_ENDPOINT ?? null,
    datadogApiKey: source.DATADOG_API_KEY ?? null,
  };

  assertProductionEnv(env);
  return env;
}

function assertProductionEnv(env: Env): void {
  if (env.serviceEnv !== "production") {
    return;
  }

  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  if (env.phoneCodePepper === "dev-only-pepper") {
    throw new Error("PHONE_CODE_PEPPER_REQUIRED");
  }

  if (!env.munjanaraEndpoint || !env.munjanaraUserId || !env.munjanaraApiKey) {
    throw new Error("MUNJANARA_CONFIG_REQUIRED");
  }

  if (!env.r2AccountId || !env.r2AccessKeyId || !env.r2SecretAccessKey || !env.r2Bucket) {
    throw new Error("R2_CONFIG_REQUIRED");
  }
}
