import { Client } from "pg";
import { runMigrations } from "../../src/infrastructure/database/migrate";

/**
 * Real PostgreSQL per test suite: a template database is migrated once per test process, then each suite
 * clones it (CREATE DATABASE … TEMPLATE) — a few ms — and connects as the least-privilege runtime role.
 */
export const PG_HOST = process.env.TEST_PG_HOST ?? "localhost";
export const PG_PORT = Number(process.env.TEST_PG_PORT ?? 55432);
const MIGRATOR = {
  user: "wagering_migrator",
  password: process.env.TEST_PG_MIGRATOR_PASSWORD ?? "migrator_dev_password",
};
const APP = { user: "wagering_app", password: process.env.TEST_PG_APP_PASSWORD ?? "app_dev_password" };
const TEMPLATE = "wagering_template";

const url = (who: { user: string; password: string }, db: string) =>
  `postgres://${who.user}:${who.password}@${PG_HOST}:${PG_PORT}/${db}`;

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url(MIGRATOR, "wagering") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let templateReady: Promise<void> | undefined;

function ensureTemplate(): Promise<void> {
  templateReady ??= (async () => {
    await admin(async (c) => {
      // Serialise template (re)creation across concurrently starting test processes.
      await c.query("SELECT pg_advisory_lock(424242)");
      try {
        await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
        await c.query(`CREATE DATABASE ${TEMPLATE}`);
        await runMigrations(url(MIGRATOR, TEMPLATE), "up");
      } finally {
        await c.query("SELECT pg_advisory_unlock(424242)");
      }
    });
  })();
  return templateReady;
}

export interface TestDatabase {
  name: string;
  appUrl: string;
  migratorUrl: string;
  /** Direct SQL as the schema owner (for assertions and for proving constraints reject bad writes). */
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<R[]>;
  /** Direct SQL as the runtime role (to prove revoked privileges). */
  queryAsApp<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<R[]>;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  await ensureTemplate();
  const name = `wtest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await admin(async (c) => {
    await c.query("SELECT pg_advisory_lock(424242)");
    try {
      await c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
    } finally {
      await c.query("SELECT pg_advisory_unlock(424242)");
    }
    await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO wagering_app`);
  });

  const owner = new Client({ connectionString: url(MIGRATOR, name) });
  const app = new Client({ connectionString: url(APP, name) });
  await owner.connect();
  await app.connect();

  return {
    name,
    appUrl: url(APP, name),
    migratorUrl: url(MIGRATOR, name),
    query: async (sql, params) => (await owner.query(sql, params as unknown[])).rows,
    queryAsApp: async (sql, params) => (await app.query(sql, params as unknown[])).rows,
    drop: async () => {
      await owner.end().catch(() => {});
      await app.end().catch(() => {});
      if (process.env.KEEP_TEST_DB === "1") return;
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => {});
    },
  };
}
