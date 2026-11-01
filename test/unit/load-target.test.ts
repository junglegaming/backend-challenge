import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTarget, plateauPhases, remoteTokens, verifyLoadManifest } from "../../load/target";

const env = () => ({
  LOAD_TARGET: "remote",
  LOAD_SOURCE_COMMIT: "a".repeat(40),
  LOAD_SOURCE_MANIFEST: "manifest.json",
  LOAD_K6_IMAGE: `example.invalid/k6@sha256:${"b".repeat(64)}`,
  LOAD_APP_IMAGE: `example.invalid/app@sha256:${"c".repeat(64)}`,
  LOAD_API_URL: "http://api.internal",
  LOAD_TOKEN_URL: "http://identity.internal/token",
  LOAD_PROMETHEUS_URL: "http://127.0.0.1:9090",
  DB_HOST: "database.internal",
  DB_NAME: "fixture",
  DB_USER: "fixture",
  DB_PASSWORD: "fixture",
  DB_SSL_CA_FILE: "/public/ca.crt",
  SQS_ENDPOINT: "https://sqs.us-east-2.amazonaws.com",
  AWS_REGION: "us-east-2",
  AUTH_ISSUER: "http://identity.internal/realm",
  AUTH_JWKS_URL: "http://identity.internal/certs",
  PROVIDER_A_SECRET: "fixture",
  OPERATOR_SECRET: "fixture",
});

test("load defaults preserve the Compose standard profile", () => {
  expect(loadTarget({})).toEqual({ remote: false, scenario: "standard" });
  expect(() => loadTarget({ LOAD_TARGET: "unknown" })).toThrow("LOAD_TARGET");
  expect(() => loadTarget({ LOAD_SCENARIO: "unknown" })).toThrow("LOAD_SCENARIO");
  expect(() => loadTarget({ LOAD_SCENARIO: "plateaus" })).toThrow("LOAD_PROFILE");
});

test("remote requires explicit endpoints, credentials, TLS and pinned provenance", () => {
  const target = loadTarget(env());
  expect(target.remote).toBe(true);
  if (!target.remote) throw new Error("Expected remote");
  expect(target.values.sqs).not.toHaveProperty("credentials");
  for (const field of [
    "DB_SSL_CA_FILE",
    "DB_PASSWORD",
    "LOAD_APP_IMAGE",
    "LOAD_K6_IMAGE",
    "LOAD_TOKEN_URL",
    "LOAD_PROMETHEUS_URL",
    "PROVIDER_A_SECRET",
    "OPERATOR_SECRET",
    "LOAD_SOURCE_MANIFEST",
  ]) {
    const incomplete: NodeJS.ProcessEnv = env();
    delete incomplete[field];
    expect(() => loadTarget(incomplete)).toThrow();
  }
  expect(() => loadTarget({ ...env(), LOAD_K6_IMAGE: "k6:latest" })).toThrow("digest");
  expect(() => loadTarget({ ...env(), LOAD_APP_IMAGE: "app:latest" })).toThrow("digest");
  expect(() => loadTarget({ ...env(), LOAD_API_URL: "http://user:password@host" })).toThrow("URL");
  expect(() =>
    loadTarget({ ...env(), NODE_ENV: "test", TEST_SYNC_POINTS: "after_commit" }),
  ).toThrow("sync");
});

test("fixed plateaus compare equal offered totals and do not modify full ramps", () => {
  expect(
    plateauPhases.map((p) => p.rate * (p.workload === "hot_plus_distributed" ? 2 : 1)),
  ).toEqual([50, 50, 50, 100, 100, 100]);
  expect(
    plateauPhases.reduce(
      (sum, p) => sum + p.rate * 180 * (p.workload === "hot_plus_distributed" ? 2 : 1),
      0,
    ),
  ).toBe(81_000);
});

test("remote token acquisition uses the supplied endpoint and caches without persisting tokens", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = await request.formData();
      expect(body.get("client_id")).toBe("provider-a");
      expect(body.get("client_secret")).toBe("fixture");
      requests++;
      return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    },
  });
  try {
    const token = remoteTokens(`${server.url}token`, env());
    expect(await token("provider-a")).toBe("fixture-token");
    expect(await token("provider-a")).toBe("fixture-token");
    expect(requests).toBe(1);
    await expect(remoteTokens(`${server.url}token`, {})("provider-a")).rejects.toThrow("secret");
  } finally {
    await server.stop(true);
  }
});

test("remote source manifest rejects mismatched identity and changed bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "load-manifest-"));
  const file = `load-manifest-${crypto.randomUUID()}.txt`;
  try {
    await Bun.write(file, "original");
    const manifest = join(dir, "manifest.json");
    await Bun.write(
      manifest,
      JSON.stringify({
        commit: "a".repeat(40),
        files: {
          [file]: new Bun.CryptoHasher("sha256").update("original").digest("hex"),
        },
      }),
    );
    expect((await verifyLoadManifest(manifest, "a".repeat(40))).commit).toBe("a".repeat(40));
    await expect(verifyLoadManifest(manifest, "b".repeat(40))).rejects.toThrow("identity");
    await Bun.write(file, "changed");
    await expect(verifyLoadManifest(manifest, "a".repeat(40))).rejects.toThrow("mismatch");
  } finally {
    await rm(file, { force: true });
    await rm(dir, { force: true, recursive: true });
  }
});
