import { describe, expect, it } from "@jest/globals";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { enableApiShutdownHooks } from "./application-shutdown";
import { DatabasePool } from "./modules/database/database-pool";

describe("production bootstrap dependencies", () => {
  it("loads the Express runtime used by the production entrypoint", () => {
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(typeof require('express').json)"], {
      cwd: resolve(__dirname, ".."),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });

    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
      status: 0,
      stderr: "",
      stdout: "function",
    });
  });

  it("enables API shutdown hooks for SIGINT and SIGTERM", () => {
    const received: NodeJS.Signals[][] = [];

    enableApiShutdownHooks({ enableShutdownHooks: (signals: NodeJS.Signals[]) => void received.push(signals) });

    expect(received).toEqual([["SIGINT", "SIGTERM"]]);
  });

  it("reaches the managed database pool through application shutdown", async () => {
    const databasePool = new DatabasePool(
      new ConfigService({
        POSTGRES_HOST: "127.0.0.1",
        POSTGRES_PORT: 5432,
        POSTGRES_USERNAME: "chattea",
        POSTGRES_PASSWORD: "chattea-dev",
        POSTGRES_DATABASE: "chattea",
        POSTGRES_SSL: false,
      }),
    );
    const testingModule = await Test.createTestingModule({
      providers: [{ provide: DatabasePool, useValue: databasePool }],
    }).compile();
    const application = testingModule.createNestApplication();
    enableApiShutdownHooks(application);
    await application.init();

    await application.close();

    await expect(databasePool.query("SELECT 1")).rejects.toThrow("Cannot use a pool after calling end");
  });
});
