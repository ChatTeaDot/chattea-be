import { NestFactory } from "@nestjs/core";
import { DatadogLogger } from "src/common/logging/datadog-logger";
import { runMaintenanceApplication } from "src/maintenance/maintenance.application";
import { MaintenanceModule } from "src/maintenance/maintenance.module";

const logger = new DatadogLogger();

const createContext = async () =>
  NestFactory.createApplicationContext(MaintenanceModule, {
    logger,
  });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "unknown");

void runMaintenanceApplication({ createContext, signals: process }).catch((error: unknown) => {
  logger.error(JSON.stringify({ event: "maintenance_process_failed", error: errorMessage(error) }));
  process.exitCode = 1;
});
