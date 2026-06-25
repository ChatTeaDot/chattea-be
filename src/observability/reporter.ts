import { redactPii } from "./redaction.js";

export type ObservabilityReporter = {
  capture(level: "warn" | "error", args: unknown[]): void;
};

export class NoopReporter implements ObservabilityReporter {
  capture() {
    return undefined;
  }
}

export class HttpReporter implements ObservabilityReporter {
  constructor(
    private readonly config: {
      endpoint: string;
      service: "sentry" | "datadog";
      apiKey?: string | null;
      fetchImpl?: typeof fetch;
    },
  ) {}

  capture(level: "warn" | "error", args: unknown[]): void {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    void fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { "dd-api-key": this.config.apiKey } : {}),
      },
      body: JSON.stringify({
        level,
        service: this.config.service,
        args: redactPii(args),
      }),
    }).catch(() => undefined);
  }
}

export class MultiReporter implements ObservabilityReporter {
  constructor(private readonly reporters: ObservabilityReporter[]) {}

  capture(level: "warn" | "error", args: unknown[]): void {
    for (const reporter of this.reporters) {
      reporter.capture(level, args);
    }
  }
}
