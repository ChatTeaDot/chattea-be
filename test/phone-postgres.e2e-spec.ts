import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, PoolClient } from "pg";
import { AuthRepository } from "src/modules/auth/auth.repository";
import { AuthService } from "src/modules/auth/auth.service";
import * as schema from "src/modules/database/schema";
import { PhoneRepository } from "src/modules/phone/phone.repository";
import { PhoneService } from "src/modules/phone/phone.service";
import { PhoneVerificationPurpose } from "src/modules/phone/phone.types";
import { SmsSender } from "src/modules/phone/sms.sender";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

jest.setTimeout(60_000);

describePostgres("Phone PostgreSQL security", () => {
  const namespace = randomUUID().replaceAll("-", "").slice(0, 8);
  const applicationName = `phone-security-${namespace}`;
  const phoneSeed = Number.parseInt(namespace, 16) % 100_000_000;
  const phoneE164s = new Set<string>();
  const userIds: string[] = [];
  let phoneSequence = 0;
  let pool: Pool;
  let controlPool: Pool;
  let authRepository: AuthRepository;
  let repository: PhoneRepository;
  let service: PhoneService;

  const nextPhone = () => {
    const subscriber = String((phoneSeed + phoneSequence++) % 100_000_000).padStart(8, "0");
    const phone = { local: `010${subscriber}`, e164: `+8210${subscriber}` };
    phoneE164s.add(phone.e164);
    return phone;
  };

  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const postgresTimestamp = (value: Date) => value.toISOString().replace("T", " ").replace("Z", "");

  const insertVerification = async (input: {
    phoneE164: string;
    purpose: string;
    createdAt: Date;
    requestIpHash?: string;
    codeHash?: string;
    expiresAt?: Date;
    verifiedAt?: Date;
    attemptCount?: number;
  }) => {
    const result = await pool.query<{ id: string }>(
      'INSERT INTO "phoneVerification" ("phoneE164", "codeHash", purpose, "expiresAt", "verifiedAt", "attemptCount", "requestIpHash", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [
        input.phoneE164,
        input.codeHash ?? "hash",
        input.purpose,
        postgresTimestamp(input.expiresAt ?? new Date(Date.now() + 5 * 60_000)),
        input.verifiedAt ? postgresTimestamp(input.verifiedAt) : null,
        input.attemptCount ?? 0,
        input.requestIpHash ?? null,
        postgresTimestamp(input.createdAt),
      ],
    );
    const verification = result.rows[0];
    if (!verification) throw new Error("PHONE_VERIFICATION_FIXTURE_REQUIRED");
    return verification.id;
  };

  const waitFor = async (condition: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await condition())) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };

  const waitForBlockedAdvisoryLocks = (expected: number) =>
    waitFor(async () => {
      const result = await controlPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_locks locks JOIN pg_stat_activity activity ON activity.pid = locks.pid WHERE locks.locktype = 'advisory' AND NOT locks.granted AND activity.application_name = $1",
        [applicationName],
      );
      return (result.rows[0]?.count ?? 0) >= expected;
    }, `${expected} advisory lock waiters`);

  const waitForBlockedQueries = (expected: number) =>
    waitFor(async () => {
      const result = await controlPool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
        [applicationName],
      );
      return (result.rows[0]?.count ?? 0) >= expected;
    }, `${expected} blocked queries`);

  const lockVerification = async (client: PoolClient, id: string) => {
    await client.query("BEGIN");
    await client.query('SELECT id FROM "phoneVerification" WHERE id = $1 FOR UPDATE', [id]);
  };

  beforeAll(async () => {
    const connection = {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    };
    pool = new Pool({ ...connection, application_name: applicationName, max: 16 });
    controlPool = new Pool({ ...connection, application_name: `${applicationName}-control`, max: 4 });
    const database = drizzle(pool, { schema });
    authRepository = new AuthRepository(database);
    repository = new PhoneRepository(database);
    service = new PhoneService(
      repository,
      {} as AuthService,
      new ConfigService({ PHONE_CODE_PEPPER: "test-pepper" }),
      {} as JwtService,
      { sendCode: async () => undefined } as SmsSender,
    );
  });

  afterAll(async () => {
    if (!pool || !controlPool) return;
    const phones = [...phoneE164s];
    if (phones.length > 0) {
      await pool.query(
        'DELETE FROM "phoneVerificationToken" WHERE "verificationId" IN (SELECT id FROM "phoneVerification" WHERE "phoneE164" = ANY($1::text[]))',
        [phones],
      );
      await pool.query('DELETE FROM "phoneVerification" WHERE "phoneE164" = ANY($1::text[])', [phones]);
    }
    if (userIds.length > 0) {
      await pool.query('DELETE FROM "refreshToken" WHERE "userId" = ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM users WHERE "userId" = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
    await controlPool.end();
  });

  it("counts phone requests across verification purposes", async () => {
    const phone = nextPhone();
    const purposes = ["signup", "password_reset", "login", "password_reset", "login"];
    for (const [index, purpose] of purposes.entries()) {
      await insertVerification({
        phoneE164: phone.e164,
        purpose,
        requestIpHash: sha256(`${namespace}:phone:${index}`),
        createdAt: new Date(Date.now() - 120_000 - index),
      });
    }

    await expect(
      service.requestPhoneCode({ phone: phone.local, purpose: PhoneVerificationPurpose.Signup }, "198.51.100.1"),
    ).rejects.toThrow("전화번호 요청 횟수를 초과했습니다.");
  });

  it("counts IP requests across verification purposes", async () => {
    const ip = "198.51.100.2";
    const requestIpHash = sha256(ip);
    const purposes = ["signup", "password_reset", "login"];
    for (let index = 0; index < 20; index += 1) {
      const phone = nextPhone();
      const purpose = purposes[index % purposes.length];
      if (!purpose) throw new Error("PHONE_PURPOSE_FIXTURE_REQUIRED");
      await insertVerification({
        phoneE164: phone.e164,
        purpose,
        requestIpHash,
        createdAt: new Date(Date.now() - 120_000 - index),
      });
    }
    const phone = nextPhone();

    await expect(
      service.requestPhoneCode({ phone: phone.local, purpose: PhoneVerificationPurpose.Signup }, ip),
    ).rejects.toThrow("IP 요청 횟수를 초과했습니다.");
  });

  it("keeps cooldown global across verification purposes", async () => {
    const phone = nextPhone();
    await insertVerification({
      phoneE164: phone.e164,
      purpose: "password_reset",
      createdAt: new Date(Date.now() - 10_000),
    });

    await expect(
      service.requestPhoneCode({ phone: phone.local, purpose: PhoneVerificationPurpose.Signup }, "198.51.100.3"),
    ).rejects.toThrow("인증번호 재요청은 60초 후 가능합니다.");
  });

  it("uses the database clock for cooldown decisions", async () => {
    const phone = nextPhone();
    await insertVerification({
      phoneE164: phone.e164,
      purpose: "signup",
      createdAt: new Date(),
    });
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);

    await expect(
      service.requestPhoneCode({ phone: phone.local, purpose: PhoneVerificationPurpose.Login }, "198.51.100.9"),
    ).rejects.toThrow("인증번호 재요청은 60초 후 가능합니다.");
    jest.restoreAllMocks();
  });

  it("keeps a failed SMS reservation inactive when cleanup also fails", async () => {
    const phone = nextPhone();
    const functionName = `verification_delete_fail_${namespace}`;
    const triggerName = `verification_delete_fail_${namespace}`;
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."phoneE164" = '${phone.e164}' THEN RAISE EXCEPTION 'forced verification delete failure'; END IF; RETURN OLD; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE DELETE ON "phoneVerification" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    const failingService = new PhoneService(
      repository,
      {} as AuthService,
      new ConfigService({ PHONE_CODE_PEPPER: "test-pepper" }),
      {} as JwtService,
      { sendCode: async () => Promise.reject(new Error("provider failed")) } as SmsSender,
    );
    try {
      await expect(
        failingService.requestPhoneCode(
          { phone: phone.local, purpose: PhoneVerificationPurpose.Signup },
          "198.51.100.10",
        ),
      ).rejects.toThrow("인증번호 발송에 실패했습니다.");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "phoneVerification"`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const pending = await pool.query<{ id: string; codeHash: string; active: boolean }>(
      'SELECT id, "codeHash", "expiresAt" > clock_timestamp() AS active FROM "phoneVerification" WHERE "phoneE164" = $1 ORDER BY "createdAt" DESC LIMIT 1',
      [phone.e164],
    );
    expect(pending.rows[0]).toMatchObject({ codeHash: "pending", active: false });
    const verificationId = pending.rows[0]?.id;
    if (!verificationId) throw new Error("PENDING_VERIFICATION_FIXTURE_REQUIRED");
    await expect(
      repository.claimVerificationAttempt({
        id: verificationId,
        phoneE164: phone.e164,
        purposes: ["signup"],
      }),
    ).resolves.toBeUndefined();
  });

  it("does not count advisory-lock wait time toward the cooldown", async () => {
    const phone = nextPhone();
    const requestIpHash = sha256(`${namespace}:cooldown-gate`);
    const quotaKey = `ip:${requestIpHash}`;
    const client = await controlPool.connect();
    let locked = false;
    let reservationsPromise: Promise<Awaited<ReturnType<PhoneRepository["reserveVerification"]>>[]> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [quotaKey]);
      locked = true;
      reservationsPromise = Promise.all(
        Array.from({ length: 2 }, () =>
          repository.reserveVerification({
            phoneE164: phone.e164,
            purpose: "signup",
            requestIpHash,
            userAgentHash: sha256("agent"),
            cooldownMs: 100,
            phoneLimit: 5,
            ipLimit: 20,
          }),
        ),
      );
      await waitForBlockedAdvisoryLocks(2);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await client.query("COMMIT");
      locked = false;
    } finally {
      if (locked) await client.query("ROLLBACK");
      client.release();
    }
    if (!reservationsPromise) throw new Error("PHONE_COOLDOWN_FIXTURE_REQUIRED");
    const reservations = await reservationsPromise;

    expect(reservations.map(({ status }) => status).sort()).toEqual(["reserved", "retry_too_soon"]);
  });

  it("admits one concurrent reservation for the same phone and IP", async () => {
    const phone = nextPhone();
    const gateKey = 1_000_000_000 + phoneSeed;
    const functionName = `phone_insert_gate_${namespace}`;
    const triggerName = `phone_insert_gate_${namespace}`;
    const client = await controlPool.connect();
    let gateHeld = false;
    let attemptsPromise: Promise<PromiseSettledResult<{ ok: boolean }>[]> | undefined;
    let attempts: PromiseSettledResult<{ ok: boolean }>[] = [];
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."phoneE164" = '${phone.e164}' THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON "phoneVerification" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [gateKey]);
      gateHeld = true;
      attemptsPromise = Promise.allSettled(
        Array.from({ length: 8 }, () =>
          service.requestPhoneCode({ phone: phone.local, purpose: PhoneVerificationPurpose.Signup }, "198.51.100.4"),
        ),
      );
      await waitForBlockedAdvisoryLocks(8);
      await client.query("COMMIT");
      gateHeld = false;
      attempts = await attemptsPromise;
    } finally {
      if (gateHeld) await client.query("ROLLBACK");
      if (attemptsPromise && attempts.length === 0) attempts = await attemptsPromise;
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "phoneVerification"`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      client.release();
    }
    const rows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "phoneVerification" WHERE "phoneE164" = $1',
      [phone.e164],
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("atomically caps concurrent failed attempts at five", async () => {
    const phone = nextPhone();
    const id = await insertVerification({ phoneE164: phone.e164, purpose: "signup", createdAt: new Date() });
    const client = await controlPool.connect();
    let locked = false;
    let attemptsPromise: Promise<(schema.PhoneVerification | undefined)[]> | undefined;
    let attempts: (schema.PhoneVerification | undefined)[] = [];
    try {
      await lockVerification(client, id);
      locked = true;
      attemptsPromise = Promise.all(
        Array.from({ length: 8 }, () =>
          repository.claimVerificationAttempt({ id, phoneE164: phone.e164, purposes: ["signup"] }),
        ),
      );
      await waitForBlockedQueries(8);
      await client.query("COMMIT");
      locked = false;
      attempts = await attemptsPromise;
    } finally {
      if (locked) await client.query("ROLLBACK");
      if (attemptsPromise && attempts.length === 0) attempts = await attemptsPromise;
      client.release();
    }
    const row = await pool.query<{ attemptCount: number }>(
      'SELECT "attemptCount" FROM "phoneVerification" WHERE id = $1',
      [id],
    );

    expect(attempts.filter(Boolean)).toHaveLength(5);
    expect(row.rows[0]?.attemptCount).toBe(5);
    await expect(
      repository.claimVerificationAttempt({ id, phoneE164: phone.e164, purposes: ["signup"] }),
    ).resolves.toBeUndefined();
  });

  it("invalidates an older code generation at every terminal mutation", async () => {
    const activationPhone = nextPhone();
    const activationCreatedAt = new Date(Date.now() - 2_000);
    const staleActivationId = await insertVerification({
      phoneE164: activationPhone.e164,
      purpose: "signup",
      codeHash: "pending",
      expiresAt: new Date(Date.now() - 1_000),
      createdAt: activationCreatedAt,
    });
    const newerActivationId = await insertVerification({
      phoneE164: activationPhone.e164,
      purpose: "signup",
      createdAt: new Date(activationCreatedAt.getTime() + 1_000),
    });

    await expect(repository.activateVerification(staleActivationId, "hash", 300_000)).resolves.toBeUndefined();
    await repository.deleteVerification(newerActivationId);
    await expect(
      repository.claimVerificationAttempt({
        id: staleActivationId,
        phoneE164: activationPhone.e164,
        purposes: ["signup"],
      }),
    ).resolves.toBeUndefined();

    const claimPhone = nextPhone();
    const claimCreatedAt = new Date(Date.now() - 2_000);
    const staleClaimId = await insertVerification({
      phoneE164: claimPhone.e164,
      purpose: "signup",
      createdAt: claimCreatedAt,
    });
    await insertVerification({
      phoneE164: claimPhone.e164,
      purpose: "signup",
      createdAt: new Date(claimCreatedAt.getTime() + 1_000),
    });

    await expect(
      repository.claimVerificationAttempt({
        id: staleClaimId,
        phoneE164: claimPhone.e164,
        purposes: ["signup"],
      }),
    ).resolves.toBeUndefined();

    const markPhone = nextPhone();
    const markCreatedAt = new Date(Date.now() - 2_000);
    const staleMarkId = await insertVerification({
      phoneE164: markPhone.e164,
      purpose: "signup",
      createdAt: markCreatedAt,
    });
    await repository.claimVerificationAttempt({
      id: staleMarkId,
      phoneE164: markPhone.e164,
      purposes: ["signup"],
    });
    await insertVerification({
      phoneE164: markPhone.e164,
      purpose: "signup",
      createdAt: new Date(markCreatedAt.getTime() + 1_000),
    });

    await expect(repository.markVerified(staleMarkId)).resolves.toBeUndefined();

    const resetPhone = nextPhone();
    const resetUserId = randomUUID();
    const resetCreatedAt = new Date(Date.now() - 2_000);
    userIds.push(resetUserId);
    await pool.query(
      'INSERT INTO users ("userId", email, phone, password, "userName", gender) VALUES ($1,$2,$3,$4,$5,$6)',
      [resetUserId, `${namespace}-stale-reset@example.test`, resetPhone.e164, "old-hash", "stale-reset", "male"],
    );
    const staleResetId = await insertVerification({
      phoneE164: resetPhone.e164,
      purpose: "password_reset",
      createdAt: resetCreatedAt,
      attemptCount: 1,
    });
    await insertVerification({
      phoneE164: resetPhone.e164,
      purpose: "password_reset",
      createdAt: new Date(resetCreatedAt.getTime() + 1_000),
    });

    await expect(
      repository.resetPasswordWithVerification({
        verificationId: staleResetId,
        phoneE164: resetPhone.e164,
        password: "new-hash",
      }),
    ).resolves.toBeUndefined();
    const user = await pool.query<{ password: string }>('SELECT password FROM users WHERE "userId" = $1', [
      resetUserId,
    ]);
    expect(user.rows[0]?.password).toBe("old-hash");
  });

  it("does not mutate verified or exhausted rows after failed codes", async () => {
    const verifiedPhone = nextPhone();
    const exhaustedPhone = nextPhone();
    const verifiedId = await insertVerification({
      phoneE164: verifiedPhone.e164,
      purpose: "signup",
      createdAt: new Date(),
      verifiedAt: new Date(),
      attemptCount: 2,
    });
    const exhaustedId = await insertVerification({
      phoneE164: exhaustedPhone.e164,
      purpose: "signup",
      createdAt: new Date(),
      attemptCount: 5,
    });

    const results = await Promise.all([
      repository.claimVerificationAttempt({ id: verifiedId, phoneE164: verifiedPhone.e164, purposes: ["signup"] }),
      repository.claimVerificationAttempt({
        id: exhaustedId,
        phoneE164: exhaustedPhone.e164,
        purposes: ["signup"],
      }),
    ]);
    const rows = await pool.query<{ id: string; attemptCount: number }>(
      'SELECT id, "attemptCount" FROM "phoneVerification" WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[verifiedId, exhaustedId]],
    );

    expect(results).toEqual([undefined, undefined]);
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.attemptCount]))).toEqual({
      [verifiedId]: 2,
      [exhaustedId]: 5,
    });
  });

  it("rejects a correct sixth service attempt after five concurrent claims", async () => {
    const phone = nextPhone();
    const id = await insertVerification({
      phoneE164: phone.e164,
      purpose: "signup",
      codeHash: await bcrypt.hash(`${phone.e164}:123456:test-pepper`, 10),
      createdAt: new Date(),
    });
    const client = await controlPool.connect();
    let locked = false;
    let wrongAttempts: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await lockVerification(client, id);
      locked = true;
      wrongAttempts = Promise.allSettled(
        Array.from({ length: 5 }, () =>
          service.verifyPhoneCode({ phone: phone.local, code: "000000" }, "device-attempt"),
        ),
      );
      await waitForBlockedQueries(5);
      await client.query("COMMIT");
      locked = false;
    } finally {
      if (locked) await client.query("ROLLBACK");
      client.release();
    }
    if (!wrongAttempts) throw new Error("PHONE_ATTEMPT_FIXTURE_REQUIRED");
    await wrongAttempts;
    await expect(service.verifyPhoneCode({ phone: phone.local, code: "123456" }, "device-attempt")).rejects.toThrow(
      "인증 실패 횟수를 초과했습니다.",
    );
    const row = await pool.query<{ attemptCount: number; verifiedAt: Date | null }>(
      'SELECT "attemptCount", "verifiedAt" FROM "phoneVerification" WHERE id = $1',
      [id],
    );

    expect(row.rows[0]).toEqual({ attemptCount: 5, verifiedAt: null });
  });

  it("does not mark expired verification rows", async () => {
    const phone = nextPhone();
    const id = await insertVerification({
      phoneE164: phone.e164,
      purpose: "signup",
      createdAt: new Date(Date.now() - 10 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(repository.markVerified(id)).resolves.toBeUndefined();
    const row = await pool.query<{ verifiedAt: Date | null }>(
      'SELECT "verifiedAt" FROM "phoneVerification" WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.verifiedAt).toBeNull();
  });

  it("revokes every refresh-token session after a successful phone password reset", async () => {
    const phone = nextPhone();
    const userId = randomUUID();
    userIds.push(userId);
    await pool.query(
      'INSERT INTO users ("userId", email, phone, password, "userName", gender) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, `${namespace}-reset@example.test`, phone.e164, "old-hash", "reset-user", "male"],
    );
    await pool.query(
      'INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp") VALUES ($1,$2,$3,$4),($1,$5,$6,$4)',
      [userId, "device-a", "token-a", new Date(Date.now() + 60_000), "device-b", "token-b"],
    );
    await insertVerification({
      phoneE164: phone.e164,
      purpose: "password_reset",
      codeHash: await bcrypt.hash(`${phone.e164}:123456:test-pepper`, 10),
      createdAt: new Date(),
    });

    await expect(
      service.resetPasswordWithPhone({ phone: phone.local, code: "123456", password: "new-password" }),
    ).resolves.toBe(true);
    const user = await pool.query<{ password: string }>('SELECT password FROM users WHERE "userId" = $1', [userId]);
    const sessions = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "refreshToken" WHERE "userId" = $1',
      [userId],
    );

    const savedUser = user.rows[0];
    if (!savedUser) throw new Error("PASSWORD_RESET_USER_FIXTURE_REQUIRED");
    await expect(bcrypt.compare("new-password", savedUser.password)).resolves.toBe(true);
    expect(sessions.rows[0]?.count).toBe(0);
  });

  it("does not restore a refresh session validated before a password reset", async () => {
    const phone = nextPhone();
    const userId = randomUUID();
    const oldTokenHash = await bcrypt.hash("old-refresh", 10);
    userIds.push(userId);
    await pool.query(
      'INSERT INTO users ("userId", email, phone, password, "userName", gender) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, `${namespace}-refresh-race@example.test`, phone.e164, "old-hash", "refresh-race-user", "male"],
    );
    await pool.query(
      'INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp") VALUES ($1,$2,$3,$4)',
      [userId, "device-a", oldTokenHash, new Date(Date.now() + 60_000)],
    );
    await insertVerification({
      phoneE164: phone.e164,
      purpose: "password_reset",
      codeHash: await bcrypt.hash(`${phone.e164}:123456:test-pepper`, 10),
      createdAt: new Date(),
    });
    const validated = await authRepository.findRefreshToken(userId, "device-a");
    if (!validated) throw new Error("REFRESH_TOKEN_FIXTURE_REQUIRED");
    await expect(bcrypt.compare("old-refresh", validated.refreshToken)).resolves.toBe(true);

    await service.resetPasswordWithPhone({ phone: phone.local, code: "123456", password: "new-password" });
    await expect(
      authRepository.rotateRefreshToken({
        userId,
        deviceId: "device-a",
        expectedRefreshToken: validated.refreshToken,
        refreshToken: await bcrypt.hash("new-refresh", 10),
        refreshTokenExp: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe(false);

    const sessions = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "refreshToken" WHERE "userId" = $1',
      [userId],
    );
    expect(sessions.rows[0]?.count).toBe(0);
  });

  it("rolls back the password change when session revocation fails", async () => {
    const phone = nextPhone();
    const userId = randomUUID();
    const functionName = `refresh_delete_fail_${namespace}`;
    const triggerName = `refresh_delete_fail_${namespace}`;
    userIds.push(userId);
    await pool.query(
      'INSERT INTO users ("userId", email, phone, password, "userName", gender) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, `${namespace}-rollback@example.test`, phone.e164, "old-hash", "rollback-user", "male"],
    );
    await pool.query(
      'INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp") VALUES ($1,$2,$3,$4)',
      [userId, "device-a", "token-a", new Date(Date.now() + 60_000)],
    );
    const verificationId = await insertVerification({
      phoneE164: phone.e164,
      purpose: "password_reset",
      codeHash: await bcrypt.hash(`${phone.e164}:123456:test-pepper`, 10),
      createdAt: new Date(),
    });
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."userId" = '${userId}'::uuid THEN RAISE EXCEPTION 'forced refresh delete failure'; END IF; RETURN OLD; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE DELETE ON "refreshToken" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    let outcome = "resolved";
    try {
      await service.resetPasswordWithPhone({ phone: phone.local, code: "123456", password: "new-password" });
    } catch {
      outcome = "rejected";
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "refreshToken"`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const user = await pool.query<{ password: string }>('SELECT password FROM users WHERE "userId" = $1', [userId]);
    const sessions = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "refreshToken" WHERE "userId" = $1',
      [userId],
    );
    const verification = await pool.query<{ verifiedAt: Date | null }>(
      'SELECT "verifiedAt" FROM "phoneVerification" WHERE id = $1',
      [verificationId],
    );

    expect({
      outcome,
      password: user.rows[0]?.password,
      sessions: sessions.rows[0]?.count,
      verifiedAt: verification.rows[0]?.verifiedAt,
    }).toEqual({
      outcome: "rejected",
      password: "old-hash",
      sessions: 1,
      verifiedAt: null,
    });
  });
});
