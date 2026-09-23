import type { EventEmitter } from "events";
import { MaintenanceRunner } from "./maintenance.runner";

type MaintenanceContext = {
  get: (token: typeof MaintenanceRunner) => Pick<MaintenanceRunner, "run">;
  close: () => Promise<void>;
};

type MaintenanceApplicationOptions = {
  createContext: () => Promise<MaintenanceContext>;
  signals: Pick<EventEmitter, "once" | "off">;
};

export const runMaintenanceApplication = async (options: MaintenanceApplicationOptions): Promise<void> => {
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  let context: MaintenanceContext | undefined;
  options.signals.once("SIGINT", stop);
  options.signals.once("SIGTERM", stop);
  try {
    context = await options.createContext();
    await context.get(MaintenanceRunner).run(abortController.signal);
  } finally {
    options.signals.off("SIGINT", stop);
    options.signals.off("SIGTERM", stop);
    await context?.close();
  }
};
