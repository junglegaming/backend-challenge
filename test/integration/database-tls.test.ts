import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseOptions } from "../../mikro-orm.config";
import { parseConfiguration } from "../../src/config/config";
import { Database } from "../../src/shared/infrastructure/database";
import { assertLedgerInvariant } from "../support/database";
import { command, pollUntil } from "../support/stack";

test("database TLS verifies both the real server chain and its IP identity", async () => {
  const project = `wagering-tls-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "wagering-tls-"));
  const override = join(directory, "compose.yaml");
  const fixtures = directory;
  const base = [
    "docker",
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    project,
    "-f",
    resolve("compose.yaml"),
    "-f",
    override,
  ];
  const environment = { ...process.env, POSTGRES_PASSWORD: "tls-public-test-only" };
  const invoke = (args: string[]) => command([...base, ...args], environment);
  let container: string | undefined;
  const stop = async () => {
    if (!container) return;
    const owner = await command([
      "docker",
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}',
      container,
    ]);
    expect(owner.trim()).toBe(project);
    await command(["docker", "stop", "--time", "10", container]);
    container = undefined;
  };
  const start = async (certificate: string) => {
    container = (
      await invoke([
        "run",
        "-d",
        "--rm",
        "--no-deps",
        "-T",
        "--publish",
        "127.0.0.1::5432",
        "--entrypoint",
        "sh",
        "postgres",
        "-ec",
        `mkdir -p /tls-server; cp /tls-fixtures/${certificate} /tls-server/server.crt; cp /tls-fixtures/server.key /tls-server/server.key; chown -R postgres:postgres /tls-server; chmod 600 /tls-server/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls-server/server.crt -c ssl_key_file=/tls-server/server.key`,
      ])
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid owned TLS container identity");
    const id = container;
    await pollUntil(
      "owned TLS PostgreSQL TCP readiness",
      async () => {
        const status = (
          await command(["docker", "inspect", "--format", "{{.State.Health.Status}}", id])
        ).trim();
        return status === "healthy";
      },
      30_000,
    );
    const bindings = JSON.parse(
      await command([
        "docker",
        "inspect",
        "--format",
        '{{json (index .NetworkSettings.Ports "5432/tcp")}}',
        id,
      ]),
    ) as { HostIp: string; HostPort: string }[];
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.HostIp).toBe("127.0.0.1");
    const port = bindings[0]?.HostPort;
    if (!port || !/^\d+$/.test(port)) throw new Error("Missing TLS test port");
    return port;
  };
  const valuesFor = (port: string, ca: string) =>
    parseConfiguration({
      ...process.env,
      DB_HOST: "127.0.0.1",
      DB_PORT: port,
      DB_NAME: "wagering",
      DB_USER: "wagering",
      DB_PASSWORD: environment.POSTGRES_PASSWORD,
      DB_SSL_CA_FILE: join(fixtures, ca),
      SQS_ENDPOINT: "http://127.0.0.1:1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "local",
      AWS_SECRET_ACCESS_KEY: "local",
      AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
      AUTH_JWKS_URL: "http://keycloak:8080/realms/wagering/protocol/openid-connect/certs",
    });
  const rejected = async (port: string, ca: string, kind: "trust" | "identity") => {
    const orm = await MikroORM.init(databaseOptions(valuesFor(port, ca).database));
    try {
      let failure: unknown;
      try {
        await orm.em.getConnection().execute("SELECT 1");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error & { code?: string };
      const category = `${error.code ?? ""} ${error.message}`;
      expect(category).toMatch(
        kind === "trust"
          ? /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|self.signed|unable to verify|unable to get.*issuer/i
          : /ERR_TLS_CERT_ALTNAME_INVALID|IP address mismatch|Hostname.*does not match|does not match.*certificate|certificate.*does not match/i,
      );
    } finally {
      await orm.close(true);
    }
  };
  try {
    await command(["docker", "build", "--tag", "wagering-tls-tools:test", "docker/tls-test"]);
    await command([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "--volume",
      `${fixtures}:/fixtures`,
      "wagering-tls-tools:test",
      `umask 077
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Wagering disposable CA A/' -keyout ca-a.key -out ca-a.crt 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Wagering disposable CA B/' -keyout ca-b.key -out ca-b.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=Wagering disposable server/' -keyout server.key -out server.csr 2>/dev/null
printf '%s\\n' 'subjectAltName=IP:127.0.0.1' 'extendedKeyUsage=serverAuth' 'basicConstraints=CA:FALSE' > good.ext
printf '%s\\n' 'subjectAltName=DNS:wrong-host.invalid' 'extendedKeyUsage=serverAuth' 'basicConstraints=CA:FALSE' > wrong.ext
openssl x509 -req -sha256 -days 1 -in server.csr -CA ca-a.crt -CAkey ca-a.key -set_serial 1001 -extfile good.ext -out server-good.crt 2>/dev/null
openssl x509 -req -sha256 -days 1 -in server.csr -CA ca-a.crt -CAkey ca-a.key -set_serial 1002 -extfile wrong.ext -out server-wrong-host.crt 2>/dev/null
rm ca-a.key ca-b.key server.csr good.ext wrong.ext`,
    ]);
    await Bun.write(
      override,
      JSON.stringify({
        services: {
          postgres: {
            volumes: [`${fixtures}:/tls-fixtures:ro`],
            healthcheck: {
              test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "wagering", "-d", "wagering"],
              interval: "1s",
              timeout: "2s",
              retries: 30,
            },
          },
        },
      }),
    );
    const port = await start("server-good.crt");
    const values = valuesFor(port, "ca-a.crt");
    const tls = databaseOptions(values.database);
    const plain = databaseOptions({ ...values.database, sslCaFile: undefined });
    expect(tls.driverOptions?.onPoolCreated).toBe(plain.driverOptions?.onPoolCreated);
    expect(tls.driverOptions?.ssl.rejectUnauthorized).toBe(true);
    const database = new Database({ values });
    try {
      const orm = await database.orm;
      const rows = await orm.em
        .getConnection()
        .execute<{ ssl: boolean }[]>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      expect(rows).toEqual([{ ssl: true }]);
      await orm.migrator.up();
      await assertLedgerInvariant(database);
    } finally {
      await database.onModuleDestroy();
    }
    await rejected(port, "ca-b.crt", "trust");
    await stop();
    await rejected(await start("server-wrong-host.crt"), "ca-a.crt", "identity");
  } finally {
    try {
      await stop();
    } finally {
      try {
        await invoke(["down", "--volumes", "--remove-orphans"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 120_000);
