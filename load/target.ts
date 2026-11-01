import { parseConfiguration } from "../src/config/config";
import { Database } from "../src/shared/infrastructure/database";
import { MikroOrmUnitOfWork } from "../src/shared/infrastructure/unit-of-work";
import { loadSourceFiles } from "./source-files";

export function loadTarget(env: NodeJS.ProcessEnv) {
  const target = env.LOAD_TARGET ?? "compose";
  const scenario = env.LOAD_SCENARIO ?? "standard";
  if (target !== "compose" && target !== "remote") throw new Error("Invalid LOAD_TARGET");
  if (scenario !== "standard" && scenario !== "plateaus") throw new Error("Invalid LOAD_SCENARIO");
  if (scenario === "plateaus" && env.LOAD_PROFILE !== "full")
    throw new Error("Plateaus require LOAD_PROFILE=full");
  function required(name: string) {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing remote load configuration: ${name}`);
    return value;
  }
  function url(name: string) {
    const value = required(name);
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error(`Invalid remote load URL: ${name}`);
    return value.replace(/\/$/, "");
  }
  if (target === "compose") return { remote: false as const, scenario };
  const commit = required("LOAD_SOURCE_COMMIT");
  const image = required("LOAD_K6_IMAGE");
  const appImage = required("LOAD_APP_IMAGE");
  const manifest = required("LOAD_SOURCE_MANIFEST");
  const manifestSha256 = required("LOAD_SOURCE_MANIFEST_SHA256");
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("Invalid manifest digest");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid LOAD_SOURCE_COMMIT");
  if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Remote k6 image must be pinned by digest");
  if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(appImage))
    throw new Error("Remote application image must be pinned by digest");
  // No local credentials or database defaults are inherited by this opt-in path.
  required("DB_SSL_CA_FILE");
  required("PROVIDER_A_SECRET");
  required("OPERATOR_SECRET");
  const values = parseConfiguration(env);
  if (values.sync.points.length) throw new Error("Remote load forbids test sync points");
  return {
    remote: true as const,
    scenario,
    apiUrl: url("LOAD_API_URL"),
    tokenUrl: url("LOAD_TOKEN_URL"),
    prometheusUrl: url("LOAD_PROMETHEUS_URL"),
    commit,
    image,
    manifest,
    manifestSha256,
    values,
  };
}

export async function verifyLoadManifest(path: string, commit: string, expectedSha256: string) {
  const bytes = await Bun.file(path).arrayBuffer();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) throw new Error("Load source manifest digest mismatch");
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
    commit: string;
    files: Record<string, string>;
  };
  if (manifest.commit !== commit || !manifest.files)
    throw new Error("Load source manifest identity mismatch");
  const files = Object.keys(manifest.files);
  if (
    files.length !== loadSourceFiles.length ||
    loadSourceFiles.some((file) => !Object.hasOwn(manifest.files, file))
  )
    throw new Error("Incomplete load source manifest");
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (
      file.startsWith("/") ||
      file
        .split("/")
        .some((part) => part === ".." || part === ".env" || part.startsWith(".env.")) ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error("Invalid load source manifest entry");
    const actual = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(file).arrayBuffer())
      .digest("hex");
    if (actual !== hash) throw new Error(`Load source mismatch: ${file}`);
  }
  return { ...manifest, sha256 };
}

export function remoteFixture(env: NodeJS.ProcessEnv) {
  const target = loadTarget(env);
  if (!target.remote) throw new Error("Expected remote load target");
  const database = new Database({ values: target.values });
  return { values: target.values, database, uow: new MikroOrmUnitOfWork(database) };
}

export function remoteTokens(endpoint: string, env: NodeJS.ProcessEnv) {
  const cache = new Map<string, { value: string; expiresAt: number }>();
  return async (client: "provider-a" | "platform-operator") => {
    const cached = cache.get(client);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const secret = env[client === "provider-a" ? "PROVIDER_A_SECRET" : "OPERATOR_SECRET"];
    if (!secret) throw new Error("Missing remote client secret");
    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client,
        client_secret: secret,
      }),
    });
    if (!response.ok) throw new Error(`Remote identity returned ${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in || body.expires_in <= 10)
      throw new Error("Remote identity returned no usable token");
    cache.set(client, {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 10) * 1000,
    });
    return body.access_token;
  };
}

export const plateauPhases = [
  { phase: "plateau_hot_50", workload: "hot_wallet", rate: 50 },
  { phase: "plateau_distributed_50", workload: "distributed_wallets", rate: 50 },
  { phase: "plateau_mixed_50", workload: "hot_plus_distributed", rate: 25 },
  { phase: "plateau_mixed_100", workload: "hot_plus_distributed", rate: 50 },
  { phase: "plateau_distributed_100", workload: "distributed_wallets", rate: 100 },
  { phase: "plateau_hot_100", workload: "hot_wallet", rate: 100 },
] as const;
