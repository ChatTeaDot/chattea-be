import { createHash } from "crypto";
import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { Pool } from "pg";
import { runMigrations } from "../scripts/migrate";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;
const nonTransactionalHeader = "-- chattea:migration-mode=non-transactional";

jest.setTimeout(30_000);

describePostgres("migration runner", () => {
  const namespace = `migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const migrationNames: string[] = [];
  const tableNames: string[] = [];
  const cleanupStatements: string[] = [];
  let pool: Pool;
  let migrationsDir: string;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    });
    migrationsDir = await mkdtemp(path.join(os.tmpdir(), "chattea-migrations-"));
  });

  afterAll(async () => {
    for (const statement of cleanupStatements) await pool.query(statement);
    for (const tableName of tableNames) await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    if (migrationNames.length > 0) {
      await pool.query('DELETE FROM "_migrations" WHERE "name" = ANY($1::text[])', [migrationNames]);
    }
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    const files = await readdir(migrationsDir);
    await Promise.all(files.map((file) => rm(path.join(migrationsDir, file), { force: true })));
  });

  it("rolls back schema and history when a migration fails", async () => {
    const migrationName = `${namespace}_rollback.sql`;
    const tableName = `${namespace}_rollback`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `CREATE TABLE "${tableName}" (id integer); SELECT missing_column FROM "${tableName}";`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow();
    const schema = await pool.query<{ tableName: string | null }>('SELECT to_regclass($1) AS "tableName"', [tableName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );

    expect(schema.rows[0]?.tableName).toBeNull();
    expect(history.rows[0]?.count).toBe(0);
    await rm(path.join(migrationsDir, migrationName));
  });

  it("serializes concurrent runners and applies a migration once", async () => {
    const migrationName = `${namespace}_concurrent.sql`;
    const tableName = `${namespace}_concurrent`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `SELECT pg_sleep(0.1); CREATE TABLE "${tableName}" (id integer);`,
    );

    await expect(
      Promise.all([runMigrations(pool, migrationsDir), runMigrations(pool, migrationsDir)]),
    ).resolves.toEqual([undefined, undefined]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );

    expect(history.rows[0]?.count).toBe(1);
  });

  it("runs one BOM-prefixed non-transactional statement outside a transaction", async () => {
    const migrationName = `${namespace}_non_transactional.sql`;
    const tableName = `${namespace}_non_transactional`;
    const indexName = `${namespace}_non_transactional_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (id integer)`);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `\uFEFF-- chattea:migration-mode=non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (id);`,
    );

    await expect(runMigrations(pool, migrationsDir)).resolves.toBeUndefined();
    const index = await pool.query<{ indexName: string | null }>('SELECT to_regclass($1) AS "indexName"', [indexName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );

    expect(index.rows[0]?.indexName).toBe(indexName);
    expect(history.rows[0]?.count).toBe(1);
    await rm(path.join(migrationsDir, migrationName));
  });

  it("rejects an unknown reserved migration mode before executing SQL", async () => {
    const migrationName = `${namespace}_invalid_mode.sql`;
    const tableName = `${namespace}_invalid_mode`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `-- chattea:migration-mode=nontransactional\nCREATE TABLE "${tableName}" (id integer);`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("invalid migration mode");
    const schema = await pool.query<{ tableName: string | null }>('SELECT to_regclass($1) AS "tableName"', [tableName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(schema.rows[0]?.tableName).toBeNull();
    expect(history.rows[0]?.count).toBe(0);
    await rm(path.join(migrationsDir, migrationName));
  });

  it("rejects a non-index non-transactional statement without side effects", async () => {
    const migrationName = `${namespace}_non_index_non_transactional.sql`;
    const tableName = `${namespace}_non_index_non_transactional`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `-- chattea:migration-mode=non-transactional\nCREATE TABLE "${tableName}" (id integer);`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("unsupported concurrent index syntax");
    const schema = await pool.query<{ tableName: string | null }>('SELECT to_regclass($1) AS "tableName"', [tableName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(schema.rows).toEqual([{ tableName: null }]);
    expect(history.rows[0]?.count).toBe(0);
  });

  it("drops an invalid concurrent unique index before retrying the same migration", async () => {
    const migrationName = `${namespace}_invalid_index_retry.sql`;
    const tableName = `${namespace}_invalid_index_retry`;
    const indexName = `${namespace}_invalid_index_retry_idx`;
    const sql = `-- chattea:migration-mode=non-transactional\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value);`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await pool.query(`INSERT INTO "${tableName}" (value) VALUES (1), (1)`);
    await writeFile(path.join(migrationsDir, migrationName), sql);

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("could not create unique index");
    const failedIndex = await pool.query<{ valid: boolean; ready: boolean }>(
      `SELECT indisvalid AS valid, indisready AS ready FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    expect(failedIndex.rows).toEqual([{ valid: false, ready: false }]);

    await pool.query(`DELETE FROM "${tableName}" WHERE ctid IN (SELECT ctid FROM "${tableName}" LIMIT 1)`);
    await expect(runMigrations(pool, migrationsDir)).resolves.toBeUndefined();

    const repairedIndex = await pool.query<{ valid: boolean; ready: boolean }>(
      `SELECT indisvalid AS valid, indisready AS ready FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(repairedIndex.rows).toEqual([{ valid: true, ready: true }]);
    expect(history.rows).toEqual([{ count: 1 }]);
  });

  it("rejects trailing malformed syntax before dropping an invalid index", async () => {
    const migrationName = `${namespace}_malformed_invalid_index.sql`;
    const tableName = `${namespace}_malformed_invalid_index`;
    const indexName = `${namespace}_malformed_invalid_index_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await pool.query(`INSERT INTO "${tableName}" (value) VALUES (1), (1)`);
    await expect(pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON "${tableName}" (value)`)).rejects.toThrow(
      "could not create unique index",
    );
    const before = await pool.query<{ oid: number; valid: boolean; ready: boolean }>(
      `SELECT indexrelid::oid::int AS oid, indisvalid AS valid, indisready AS ready
      FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    await writeFile(
      path.join(migrationsDir, migrationName),
      `-- chattea:migration-mode=non-transactional\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value) INVALID;`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("unsupported concurrent index syntax");
    const after = await pool.query<{ oid: number; valid: boolean; ready: boolean }>(
      `SELECT indexrelid::oid::int AS oid, indisvalid AS valid, indisready AS ready
      FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(before.rows).toHaveLength(1);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]).toEqual(expect.objectContaining({ valid: false, ready: false }));
    expect(history.rows).toEqual([{ count: 0 }]);
  });

  it.each([
    [
      "non-breaking space between tokens",
      (statement: string) => statement.replace("INDEX CONCURRENTLY", "INDEX\u00a0CONCURRENTLY"),
    ],
    ["line separator before the statement", (statement: string) => `\u2028${statement}`],
    ["em space after the statement", (statement: string) => `${statement}\u2003`],
    ["line separator after the statement", (statement: string) => `${statement}\u2028`],
  ])("rejects %s before repairing an invalid same-name index", async (_label, mutateStatement) => {
    const migrationName = `${namespace}_unicode_whitespace_${migrationNames.length}.sql`;
    const tableName = `${namespace}_unicode_whitespace_${tableNames.length}`;
    const indexName = `${namespace}_unicode_whitespace_${tableNames.length}_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await pool.query(`INSERT INTO "${tableName}" (value) VALUES (1), (1)`);
    await expect(pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON "${tableName}" (value)`)).rejects.toThrow(
      "could not create unique index",
    );
    const before = await pool.query<{ oid: number; valid: boolean; ready: boolean }>(
      `SELECT indexrelid::oid::int AS oid, indisvalid AS valid, indisready AS ready
      FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    const statement = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value);`;
    await writeFile(
      path.join(migrationsDir, migrationName),
      `${nonTransactionalHeader}\n${mutateStatement(statement)}`,
    );

    let migrationError: unknown;
    try {
      await runMigrations(pool, migrationsDir);
    } catch (error) {
      migrationError = error;
    }
    const after = await pool.query<{ oid: number; valid: boolean; ready: boolean }>(
      `SELECT indexrelid::oid::int AS oid, indisvalid AS valid, indisready AS ready
      FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );

    expect(before.rows).toHaveLength(1);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]).toEqual(expect.objectContaining({ valid: false, ready: false }));
    expect(history.rows).toEqual([{ count: 0 }]);
    expect(migrationError).toEqual(expect.objectContaining({ message: "unsupported concurrent index syntax" }));
  });

  it("rejects a valid same-name index without the exact runner marker", async () => {
    const migrationName = `${namespace}_wrong_valid_index.sql`;
    const tableName = `${namespace}_wrong_valid_index`;
    const indexName = `${namespace}_wrong_valid_index_idx`;
    const sql = `-- chattea:migration-mode=non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (expected_value);`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (actual_value integer, expected_value integer)`);
    await pool.query(`CREATE INDEX ${indexName} ON "${tableName}" (actual_value)`);
    const before = await pool.query<{ definition: string; marker: string | null }>(
      "SELECT pg_get_indexdef(to_regclass($1)) AS definition, obj_description(to_regclass($1), 'pg_class') AS marker",
      [indexName],
    );
    await writeFile(path.join(migrationsDir, migrationName), sql);

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("concurrent index marker mismatch");
    const after = await pool.query<{ definition: string; marker: string | null }>(
      "SELECT pg_get_indexdef(to_regclass($1)) AS definition, obj_description(to_regclass($1), 'pg_class') AS marker",
      [indexName],
    );
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(after.rows).toEqual(before.rows);
    expect(before.rows[0]?.marker).toBeNull();
    expect(history.rows).toEqual([{ count: 0 }]);
  });

  it("recovers a marked concurrent index after history insertion fails", async () => {
    const migrationName = `${namespace}_marked_history_retry.sql`;
    const tableName = `${namespace}_marked_history_retry`;
    const indexName = `${namespace}_marked_history_retry_idx`;
    const sequenceName = `${namespace}_marked_history_retry_seq`;
    const functionName = `${namespace}_marked_history_retry_fn`;
    const triggerName = `${namespace}_marked_history_retry_trigger`;
    const sql = `-- chattea:migration-mode=non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value);`;
    const checksum = createHash("sha256").update(sql).digest("hex");
    const markerHash = createHash("sha256").update(`${migrationName}\0${checksum}`).digest("hex");
    const expectedMarker = `chattea:migration:${markerHash}`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    cleanupStatements.push(`DROP TRIGGER IF EXISTS "${triggerName}" ON "_migrations"`);
    cleanupStatements.push(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    cleanupStatements.push(`DROP SEQUENCE IF EXISTS "${sequenceName}"`);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await runMigrations(pool, migrationsDir);
    await pool.query(`CREATE SEQUENCE "${sequenceName}"`);
    await pool.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."name" = '${migrationName}' AND nextval('"${sequenceName}"') = 1 THEN
          RAISE EXCEPTION 'concurrent history insertion blocked';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "_migrations"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    await writeFile(path.join(migrationsDir, migrationName), sql);

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("concurrent history insertion blocked");
    const afterFailure = await pool.query<{ valid: boolean; ready: boolean; marker: string | null }>(
      `SELECT i.indisvalid AS valid, i.indisready AS ready,
        obj_description(i.indexrelid, 'pg_class') AS marker
      FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
      [indexName],
    );
    expect(afterFailure.rows).toEqual([{ valid: true, ready: true, marker: expectedMarker }]);

    await expect(runMigrations(pool, migrationsDir)).resolves.toBeUndefined();
    const history = await pool.query<{ count: number; checksum: string }>(
      'SELECT count(*)::int AS count, min("checksum") AS checksum FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(history.rows).toEqual([{ count: 1, checksum }]);
  });

  it.each([
    (indexName: string, tableName: string) =>
      `CREATE /*x*/ UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value);`,
    (indexName: string, tableName: string) =>
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value); -- hidden\nSELECT 1;`,
  ])("rejects comments in concurrent index SQL before side effects", async (statement) => {
    const migrationName = `${namespace}_comment_bypass_${migrationNames.length}.sql`;
    const tableName = `${namespace}_comment_bypass_${tableNames.length}`;
    const indexName = `${namespace}_comment_bypass_${tableNames.length}_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `${nonTransactionalHeader}\n${statement(indexName, tableName)}`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("unsupported non-transactional SQL comment");
    const index = await pool.query<{ indexName: string | null }>('SELECT to_regclass($1) AS "indexName"', [indexName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(index.rows).toEqual([{ indexName: null }]);
    expect(history.rows).toEqual([{ count: 0 }]);
  });

  it("rejects unsupported concurrent index target syntax before creating an index", async () => {
    const migrationName = `${namespace}_unsupported_index.sql`;
    const tableName = `${namespace}_unsupported_index`;
    const indexName = `${namespace}_unsupported_index_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await writeFile(
      path.join(migrationsDir, migrationName),
      `-- chattea:migration-mode=non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ON "${tableName}" (value);`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("unsupported concurrent index syntax");
    const index = await pool.query<{ indexName: string | null }>('SELECT to_regclass($1) AS "indexName"', [indexName]);
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(index.rows).toEqual([{ indexName: null }]);
    expect(history.rows).toEqual([{ count: 0 }]);
  });

  it("rejects a concurrent index followed by another command before repairing its target", async () => {
    const migrationName = `${namespace}_unsupported_index_batch.sql`;
    const tableName = `${namespace}_unsupported_index_batch`;
    const indexName = `${namespace}_unsupported_index_batch_idx`;
    migrationNames.push(migrationName);
    tableNames.push(tableName);
    await pool.query(`CREATE TABLE "${tableName}" (value integer NOT NULL)`);
    await pool.query(`INSERT INTO "${tableName}" (value) VALUES (1), (1)`);
    await expect(pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON "${tableName}" (value)`)).rejects.toThrow(
      "could not create unique index",
    );
    await writeFile(
      path.join(migrationsDir, migrationName),
      `-- chattea:migration-mode=non-transactional\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${tableName}" (value); SELECT 1;`,
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow("unsupported concurrent index syntax");
    const index = await pool.query<{ valid: boolean; ready: boolean }>(
      `SELECT indisvalid AS valid, indisready AS ready FROM pg_index WHERE indexrelid = to_regclass($1)`,
      [indexName],
    );
    const history = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "_migrations" WHERE "name" = $1',
      [migrationName],
    );
    expect(index.rows).toEqual([{ valid: false, ready: false }]);
    expect(history.rows).toEqual([{ count: 0 }]);
  });
});
