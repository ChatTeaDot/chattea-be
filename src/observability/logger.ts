import type { YogaLogger } from "@graphql-yoga/logger";
import { redactPii } from "./redaction.js";
import type { ObservabilityReporter } from "./reporter.js";

const defaultLogger: YogaLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export function createRedactingLogger(
  target: YogaLogger = defaultLogger,
  reporter?: ObservabilityReporter,
): YogaLogger {
  return {
    debug: (...args: unknown[]) => target.debug(...args.map(redactPii)),
    info: (...args: unknown[]) => target.info(...args.map(redactPii)),
    warn: (...args: unknown[]) => {
      reporter?.capture("warn", args);
      target.warn(...args.map(redactPii));
    },
    error: (...args: unknown[]) => {
      reporter?.capture("error", args);
      target.error(...args.map(redactPii));
    },
  };
}
