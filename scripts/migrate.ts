import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";
import { validateEnvironment } from "../src/common/config/environment";
import { createPostgresSslOptions } from "../src/common/config/postgres";

const migrationsDir = path.join(process.cwd(), "migrations");
const migrationLockName = "chattea:migrations";
const nonTransactionalHeader = "-- chattea:migration-mode=non-transactional";
const migrationModePrefix = "-- chattea:migration-mode=";
const sqlWhitespace = "[ \\t\\r\\n]";
const sqlIdentifier = `(?:"[A-Za-z_][A-Za-z0-9_$]*"|[a-z_][a-z0-9_$]*)`;
const indexColumn = `${sqlIdentifier}(?:${sqlWhitespace}+(?:ASC|DESC))?`;
const nullPredicate = `${sqlIdentifier}${sqlWhitespace}+IS${sqlWhitespace}+(?:NOT${sqlWhitespace}+)?NULL`;
const concurrentIndexStatement = new RegExp(
  `^${sqlWhitespace}*CREATE${sqlWhitespace}+(?:UNIQUE${sqlWhitespace}+)?INDEX${sqlWhitespace}+` +
    `CONCURRENTLY${sqlWhitespace}+IF${sqlWhitespace}+NOT${sqlWhitespace}+EXISTS${sqlWhitespace}+` +
    `([a-z_][a-z0-9_$]*)${sqlWhitespace}+ON${sqlWhitespace}+${sqlIdentifier}${sqlWhitespace}*` +
    `\\(${sqlWhitespace}*${indexColumn}(?:${sqlWhitespace}*,${sqlWhitespace}*${indexColumn})*${sqlWhitespace}*\\)` +
    `(?:${sqlWhitespace}+WHERE${sqlWhitespace}+${nullPredicate}` +
    `(?:${sqlWhitespace}+AND${sqlWhitespace}+${nullPredicate})*)?${sqlWhitespace}*;${sqlWhitespace}*$`,
  "i",
);
const sqlBodyComment = /--|\/\*/;

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const concurrentIndexMarker = (file: string, checksum: string) => `chattea:migration:${sha256(`${file}\0${checksum}`)}`;

const parseConcurrentIndex = (executableSql: string): { name: string } => {
  const statement = executableSql.split(/\r?\n/).slice(1).join("\n");
  if (sqlBodyComment.test(statement)) throw new Error("unsupported non-transactional SQL comment");
  const match = concurrentIndexStatement.exec(statement);
  if (!match?.[1]) throw new Error("unsupported concurrent index syntax");
  return { name: match[1].toLowerCase() };
};

const parseMigration = (sql: string) => {
  const executableSql = sql.replace(/^\uFEFF/, "");
  const [firstLine = ""] = executableSql.split(/\r?\n/, 1);
  if (firstLine === nonTransactionalHeader) {
    return { executableSql, transactional: false, concurrentIndex: parseConcurrentIndex(executableSql) } as const;
  }
  if (firstLine.startsWith(migrationModePrefix)) throw new Error(`invalid migration mode: ${firstLine}`);
  return { executableSql, transactional: true } as const;
};

const concurrentIndexState = async (
  client: PoolClient,
  name: string,
): Promise<{ valid: boolean; ready: boolean; marker: string | null } | undefined> => {
  const state = await client.query<{ valid: boolean; ready: boolean; marker: string | null }>(
    `SELECT indisvalid AS valid, indisready AS ready,
      obj_description(indexrelid, 'pg_class') AS marker
    FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [name],
  );
  return state.rows[0];
};

const prepareConcurrentIndexTarget = async (client: PoolClient, name: string, marker: string): Promise<boolean> => {
  const state = await concurrentIndexState(client, name);
  if (!state) return false;
  if (state.valid && state.ready) {
    if (state.marker !== marker) throw new Error(`concurrent index marker mismatch: ${name}`);
    return true;
  }
  await client.query(`DROP INDEX CONCURRENTLY "${name}"`);
  return false;
};

const markConcurrentIndexReady = async (client: PoolClient, name: string, marker: string): Promise<void> => {
  const state = await concurrentIndexState(client, name);
  if (!state?.valid || !state.ready) throw new Error(`concurrent index postcondition failed: ${name}`);
  await client.query(`COMMENT ON INDEX "${name}" IS '${marker}'`);
  const marked = await concurrentIndexState(client, name);
  if (marked?.marker !== marker) throw new Error(`concurrent index marker postcondition failed: ${name}`);
};

export const runMigrations = async (pool: Pool, directory: string): Promise<void> => {
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [migrationLockName]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "appliedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await fs.readFile(path.join(directory, file), "utf8");
      const checksum = sha256(sql);
      const migrationMode = parseMigration(sql);
      const applied = await client.query<{ checksum: string }>(
        'SELECT "checksum" FROM "_migrations" WHERE "name" = $1',
        [file],
      );

      const [migration] = applied.rows;
      if (migration) {
        if (migration.checksum !== checksum) throw new Error(`migration checksum changed: ${file}`);
        continue;
      }

      if (migrationMode.transactional) {
        await client.query("BEGIN");
        try {
          await client.query(migrationMode.executableSql);
          await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } else {
        let concurrentIndexAlreadyExecuted = false;
        let marker: string | undefined;
        if (migrationMode.concurrentIndex) {
          marker = concurrentIndexMarker(file, checksum);
          concurrentIndexAlreadyExecuted = await prepareConcurrentIndexTarget(
            client,
            migrationMode.concurrentIndex.name,
            marker,
          );
        }
        if (!concurrentIndexAlreadyExecuted) {
          const extendedQuery = { text: migrationMode.executableSql, queryMode: "extended" };
          await client.query(extendedQuery);
        }
        if (migrationMode.concurrentIndex && !concurrentIndexAlreadyExecuted && marker) {
          await markConcurrentIndexReady(client, migrationMode.concurrentIndex.name, marker);
        }
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
      }
      console.log(`applied ${file}`);
    }
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [migrationLockName]);
    } finally {
      client.release();
    }
  }
};

const main = async () => {
  validateEnvironment(process.env);
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USERNAME,
    password: process.env.POSTGRES_PASSWORD,
    database: requiredEnv("POSTGRES_DATABASE"),
    ssl: createPostgresSslOptions(process.env.POSTGRES_SSL, process.env.POSTGRES_SSL_CA),
  });

  try {
    await runMigrations(pool, migrationsDir);
  } finally {
    await pool.end();
  }
};

if (require.main === module) void main();
