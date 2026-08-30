type ShutdownApplication = {
  enableShutdownHooks: (signals: NodeJS.Signals[]) => void;
};

export const enableApiShutdownHooks = (application: ShutdownApplication): void => {
  application.enableShutdownHooks(["SIGINT", "SIGTERM"]);
};
