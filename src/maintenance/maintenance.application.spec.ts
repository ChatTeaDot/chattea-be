import { EventEmitter } from "events";
import { MaintenanceRunner } from "./maintenance.runner";
import { runMaintenanceApplication } from "./maintenance.application";

const flushPromises = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("runMaintenanceApplication", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("aborts the runner and closes the context on %s", async (signal) => {
    const signals = new EventEmitter();
    let receivedSignal: AbortSignal | undefined;
    const runner = {
      run: jest.fn(async (abortSignal: AbortSignal) => {
        receivedSignal = abortSignal;
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      }),
    } as Pick<MaintenanceRunner, "run">;
    const context = {
      get: jest.fn(() => runner),
      close: jest.fn(async () => undefined),
    };

    const execution = runMaintenanceApplication({ createContext: async () => context, signals });
    await flushPromises();
    signals.emit(signal);
    await execution;

    expect(receivedSignal?.aborted).toBe(true);
    expect(context.get).toHaveBeenCalledWith(MaintenanceRunner);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes the context and propagates a runner failure", async () => {
    const signals = new EventEmitter();
    const runner = {
      run: jest.fn(async () => {
        throw new Error("cycle failed");
      }),
    } as Pick<MaintenanceRunner, "run">;
    const context = {
      get: jest.fn(() => runner),
      close: jest.fn(async () => undefined),
    };

    await expect(runMaintenanceApplication({ createContext: async () => context, signals })).rejects.toThrow(
      "cycle failed",
    );

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not lose a termination signal while the context is starting", async () => {
    const signals = new EventEmitter();
    let provideContext:
      ((context: { get: () => Pick<MaintenanceRunner, "run">; close: () => Promise<void> }) => void) | undefined;
    const runner = {
      run: jest.fn(async (signal: AbortSignal) => {
        expect(signal.aborted).toBe(true);
      }),
    } as Pick<MaintenanceRunner, "run">;
    const context = {
      get: jest.fn(() => runner),
      close: jest.fn(async () => undefined),
    };
    const execution = runMaintenanceApplication({
      createContext: async () =>
        new Promise((resolve) => {
          provideContext = resolve;
        }),
      signals,
    });

    signals.emit("SIGTERM");
    provideContext?.(context);
    await execution;

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
