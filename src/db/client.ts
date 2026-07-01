import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Database = NodePgDatabase<Record<string, never>>;

export const dbQuery = async <TRow extends Record<string, unknown>>(
  db: Database,
  statement: SQL,
): Promise<{ rows: TRow[] }> => {
  return db.execute<TRow>(statement) as Promise<{ rows: TRow[] }>;
};

export { sql };
