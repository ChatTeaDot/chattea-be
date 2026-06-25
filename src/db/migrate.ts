import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { readEnv } from "../env.js";

export async function migrate(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = readEnv();
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  await migrate(env.databaseUrl);
}
