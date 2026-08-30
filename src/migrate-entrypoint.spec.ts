import { spawnSync } from "node:child_process";
import path from "node:path";

describe("migration entrypoint", () => {
  it("validates a production environment before opening PostgreSQL", () => {
    const backendDirectory = path.resolve(__dirname, "..");
    const result = spawnSync(
      process.execPath,
      ["-r", "ts-node/register", "-r", "tsconfig-paths/register", "scripts/migrate.ts"],
      {
        cwd: backendDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          POSTGRES_HOST: "127.0.0.1",
          POSTGRES_PORT: "1",
          POSTGRES_USERNAME: "chattea",
          POSTGRES_PASSWORD: "short",
          POSTGRES_DATABASE: "chattea",
          POSTGRES_SSL: "false",
        },
        timeout: 10_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("PRODUCTION_CONFIG_INVALID");
    expect(output).not.toContain("ECONNREFUSED");
  });
});
