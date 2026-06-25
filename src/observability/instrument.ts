import tracer from "dd-trace";
import * as Sentry from "@sentry/node";
import type { Env } from "../env.js";

let initialized = false;

export function initializeObservability(env: Env) {
  if (initialized) {
    return;
  }

  if (env.datadogApmEnabled) {
    tracer.init({
      env: env.serviceEnv,
      logInjection: true,
      runtimeMetrics: true,
      service: env.serviceName,
      version: env.serviceVersion,
    });
  }

  if (env.sentryDsn) {
    Sentry.init({
      dsn: env.sentryDsn,
      environment: env.serviceEnv,
      release: env.serviceVersion,
      integrations: [Sentry.graphqlIntegration(), Sentry.postgresIntegration()],
    });
  }

  initialized = true;
}

export function captureException(error: unknown) {
  Sentry.captureException(error);
}
