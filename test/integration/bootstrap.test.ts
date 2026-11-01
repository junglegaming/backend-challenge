import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assertLedgerInvariant, testDatabase } from "../support/database";

test("bootstrap migrates a fresh real database without contacting SQS when queue creation is disabled", async () => {
  const admin = testDatabase();
  const databaseName = `bootstrap_${randomUUID().replaceAll("-", "")}`;
  const connection = (await admin.database.orm).em.getConnection();
  let requests = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(null, { status: 403 });
    },
  });
  let created = false;
  let fixture: ReturnType<typeof testDatabase> | undefined;
  try {
    await connection.execute(`CREATE DATABASE ${databaseName}`);
    created = true;
    const child = Bun.spawn(["bun", "--no-env-file", "src/cli/bootstrap.ts"], {
      env: {
        ...process.env,
        BUN_CONFIG_NO_ENV_FILE: "true",
        DB_HOST: "127.0.0.1",
        DB_PORT: String(admin.values.database.port),
        DB_NAME: databaseName,
        DB_USER: admin.values.database.user,
        DB_PASSWORD: admin.values.database.password,
        SQS_ENDPOINT: `http://127.0.0.1:${endpoint.port}`,
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_EC2_METADATA_DISABLED: "true",
        BOOTSTRAP_CREATE_QUEUES: "false",
        AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
        AUTH_JWKS_URL: "http://127.0.0.1:18080/realms/wagering/protocol/openid-connect/certs",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(requests).toBe(0);
    expect(output.split("\n").some((line) => line.includes('"event":"bootstrap_completed"'))).toBe(
      true,
    );
    fixture = testDatabase({ dbName: databaseName });
    expect(await (await fixture.database.orm).migrator.getExecuted()).toHaveLength(1);
    const [row] = await (await fixture.database.orm).em
      .getConnection()
      .execute<{ wallets: string; ledger: string; outbox: string }[]>(
        "SELECT to_regclass('wallets')::text AS wallets, to_regclass('wallet_ledger_entries')::text AS ledger, to_regclass('outbox_messages')::text AS outbox",
      );
    expect(row).toEqual({
      wallets: "wallets",
      ledger: "wallet_ledger_entries",
      outbox: "outbox_messages",
    });
    await assertLedgerInvariant(fixture.database);
  } finally {
    endpoint.stop(true);
    await fixture?.database.onModuleDestroy();
    if (created) await connection.execute(`DROP DATABASE ${databaseName}`);
    await admin.database.onModuleDestroy();
  }
}, 30_000);
