import { mkdir, open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyLoadManifest } from "../load/target";

// Invoked through SSM inside the private EC2 runner. Not a test/CI prerequisite.
interface RunnerManifest {
  commit: string;
  session: string;
  account: string;
  unit: "smoke" | "full-1" | "full-2" | "full-3" | "plateaus-1";
  sourceManifest: string;
  deadline: string;
  apiUrl: string;
  issuer: string;
  namespace: string;
  databaseHost: string;
  databaseName: string;
  databaseSecretArn: string;
  clientSecretArns: { PROVIDER_A_SECRET: string; OPERATOR_SECRET: string };
  images: { app: string; k6: string; prometheus: string };
  artifactsBucket: string;
}

const manifestPath = process.argv[2];
if (
  process.env.WAGERING_AWS_RUNNER !== "1" ||
  !manifestPath ||
  /(?:\.env|tfstate|tfvars|credentials)/.test(manifestPath)
)
  throw new Error("Run only through the authorized private-runner session");
const manifest = (await Bun.file(manifestPath).json()) as RunnerManifest;
if (
  !/^[a-f0-9]{40}$/.test(manifest.commit) ||
  !/^[a-z0-9]{6}$/.test(manifest.session) ||
  !/^[0-9]{12}$/.test(manifest.account) ||
  !["smoke", "full-1", "full-2", "full-3", "plateaus-1"].includes(manifest.unit) ||
  !/^wagering(?:_[a-z0-9_]{1,40})?$/.test(manifest.databaseName) ||
  !Number.isFinite(Date.parse(manifest.deadline))
)
  throw new Error("Invalid runner manifest identity");
const cutoff = Date.parse(manifest.deadline) - 40 * 60_000;
if (Date.now() >= cutoff) throw new Error("No runtime allowance left for a new load unit");
for (const image of Object.values(manifest.images))
  if (
    !image.startsWith(
      `${manifest.account}.dkr.ecr.us-east-2.amazonaws.com/wagering-load-${manifest.session}-`,
    ) ||
    !/@sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error("Unpinned or foreign runner image");
const secretPrefix = `arn:aws:secretsmanager:us-east-2:${manifest.account}:secret:`;
for (const arn of [manifest.databaseSecretArn, ...Object.values(manifest.clientSecretArns)])
  if (!arn.startsWith(secretPrefix)) throw new Error("Foreign secret ARN");
if (
  manifest.namespace !== `wagering-load-${manifest.session}.internal` ||
  manifest.issuer !== `http://keycloak.${manifest.namespace}:8080/realms/wagering` ||
  !new URL(manifest.apiUrl).hostname.endsWith(".us-east-2.elb.amazonaws.com") ||
  !manifest.databaseHost.endsWith(".us-east-2.rds.amazonaws.com") ||
  manifest.artifactsBucket !== `wagering-load-${manifest.session}-${manifest.account}-us-east-2`
)
  throw new Error("Runner endpoints do not belong to the authorized session");
await verifyLoadManifest(manifest.sourceManifest, manifest.commit);

const base = resolve("..");
const lock = await open(`${base}/${manifest.unit}.started`, "wx", 0o600);
await lock.writeFile(
  JSON.stringify({ at: new Date().toISOString(), commit: manifest.commit, unit: manifest.unit }),
);
await lock.close(); // Preserve even failed units; this is not an automatic retry campaign.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AWS_REGION: "us-east-2",
  AWS_DEFAULT_REGION: "us-east-2",
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  BUN_CONFIG_NO_ENV_FILE: "true",
  BUN_CONFIG_NO_AUTO_INSTALL: "true",
  NODE_ENV: "production",
};
async function execute(args: string[], input?: string) {
  const child = Bun.spawn(args, {
    env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [out, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Runner command failed: ${args[0]} ${args[1]} (${code})`);
  return out;
}
async function secret(arn: string) {
  const value = JSON.parse(
    await execute([
      "aws",
      "secretsmanager",
      "get-secret-value",
      "--region",
      "us-east-2",
      "--secret-id",
      arn,
      "--output",
      "json",
    ]),
  );
  if (typeof value.SecretString !== "string") throw new Error("Missing runner secret");
  return value.SecretString as string;
}
const databaseSecret = JSON.parse(await secret(manifest.databaseSecretArn)) as {
  username?: string;
  password?: string;
};
if (databaseSecret.username !== "wagering" || !databaseSecret.password)
  throw new Error("Unexpected database identity");
const provider = await secret(manifest.clientSecretArns.PROVIDER_A_SECRET);
const operator = await secret(manifest.clientSecretArns.OPERATOR_SECRET);
const dockerAuth = `${base}/docker-auth-${manifest.unit}`;
await mkdir(dockerAuth, { mode: 0o700 });
env.DOCKER_CONFIG = dockerAuth;
const prometheusName = `wagering-load-prometheus-${manifest.session}-${manifest.unit}`;
let prometheusStarted = false;
let runId: string | undefined;
const resultsPath = resolve("load/results");
const previousResults = new Set(await readdir(resultsPath).catch(() => []));
const executionPath = `${base}/${manifest.unit}-execution.json`;
try {
  const ecrToken = await execute(["aws", "ecr", "get-login-password", "--region", "us-east-2"]);
  await execute(
    [
      "docker",
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      `${manifest.account}.dkr.ecr.us-east-2.amazonaws.com`,
    ],
    ecrToken,
  );
  for (const image of [manifest.images.k6, manifest.images.prometheus])
    await execute(["docker", "pull", image]);
  const prometheusConfig = `${base}/prometheus-${manifest.unit}.yml`;
  await Bun.write(
    prometheusConfig,
    `global:\n  scrape_interval: 5s\n  scrape_timeout: 3s\nscrape_configs:\n  - job_name: wagering\n    dns_sd_configs:\n      - names: [api.${manifest.namespace}, consumer.${manifest.namespace}, worker.${manifest.namespace}]\n        type: A\n        port: 3000\n        refresh_interval: 5s\n    relabel_configs:\n      - source_labels: [__meta_dns_name]\n        regex: '(api|consumer|worker)\\..*'\n        replacement: '$1'\n        target_label: role\n`,
  );
  await execute([
    "docker",
    "run",
    "-d",
    "--name",
    prometheusName,
    "--network",
    "host",
    "--read-only",
    "--tmpfs",
    "/prometheus:rw,noexec,nosuid,size=512m,uid=65534,gid=65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=bind,src=${prometheusConfig},dst=/etc/prometheus/prometheus.yml,readonly`,
    manifest.images.prometheus,
    "--config.file=/etc/prometheus/prometheus.yml",
    "--storage.tsdb.path=/prometheus",
    "--web.listen-address=127.0.0.1:9090",
  ]);
  prometheusStarted = true;
  const loadEnv = {
    ...env,
    LOAD_TARGET: "remote",
    LOAD_SCENARIO: manifest.unit === "plateaus-1" ? "plateaus" : "standard",
    LOAD_PROFILE: manifest.unit === "smoke" ? "quick" : "full",
    LOAD_SOURCE_COMMIT: manifest.commit,
    LOAD_SOURCE_MANIFEST: manifest.sourceManifest,
    LOAD_K6_IMAGE: manifest.images.k6,
    LOAD_APP_IMAGE: manifest.images.app,
    LOAD_PROMETHEUS_IMAGE: manifest.images.prometheus,
    LOAD_API_URL: manifest.apiUrl,
    LOAD_TOKEN_URL: `${manifest.issuer}/protocol/openid-connect/token`,
    LOAD_PROMETHEUS_URL: "http://127.0.0.1:9090",
    DB_HOST: manifest.databaseHost,
    DB_PORT: "5432",
    DB_NAME: manifest.databaseName,
    DB_USER: "wagering",
    DB_PASSWORD: databaseSecret.password,
    DB_SSL_CA_FILE: resolve("docker/aws/us-east-2-bundle.crt"),
    SQS_ENDPOINT: "https://sqs.us-east-2.amazonaws.com",
    AUTH_ISSUER: manifest.issuer,
    AUTH_JWKS_URL: `${manifest.issuer}/protocol/openid-connect/certs`,
    PROVIDER_A_SECRET: provider,
    OPERATOR_SECRET: operator,
    TEST_SYNC_POINTS: "",
    TEST_SYNC_MATCH: "",
  };
  if (Date.now() >= cutoff) throw new Error("Runtime allowance exhausted during runner setup");
  const child = Bun.spawn(["bun", "--no-env-file", "scripts/load-test.ts"], {
    env: loadEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  let terminated = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(
    () => {
      terminated = true;
      child.kill("SIGTERM");
      // Financial verification has its own 120s bound. Leave it time to record a partial proof.
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    },
    Math.max(1, cutoff - Date.now()),
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  clearTimeout(forceTimer);
  runId = /^Load (?:quick|full): ([A-Za-z0-9-]+)$/m.exec(out)?.[1];
  // No raw subprocess output is retained; diagnostics are a closed technical projection.
  const safe = {
    unit: manifest.unit,
    commit: manifest.commit,
    completedAt: new Date().toISOString(),
    exitCode: code,
    runtimeGuardrailReached: terminated,
    lines: (out + err)
      .split("\n")
      .filter((line) =>
        /^Load (?:quick|full|phase:|passed:|failed;|hot_wallet:|distributed_wallets:|replays:|hot_plus_distributed:)/.test(
          line,
        ),
      ),
    failureLocations: (out + err)
      .split("\n")
      .filter((line) => /^\s*at .*:\d+:\d+/.test(line))
      .slice(0, 20),
  };
  await Bun.write(executionPath, JSON.stringify(safe, null, 2));
  process.exitCode = terminated ? 1 : code;
} finally {
  try {
    if (runId) {
      // Safety net for a forced Bun exit; this name is emitted by this unit's child only.
      await execute(["docker", "rm", "-f", `wagering-load-k6-${runId}`]).catch(() => {});
    }
    if (prometheusStarted) await execute(["docker", "rm", "-f", prometheusName]);
    // Export only instrument output, never environment, Docker authentication or financial envelopes.
    for (const directory of await readdir(resultsPath).catch(() => [])) {
      if (previousResults.has(directory) || directory !== runId) continue;
      for (const name of await readdir(`${resultsPath}/${directory}`)) {
        if (
          !/^(?:fixtures|expected|environment|verification|partial-verification|result|failure|participation|publication-latency|event-observer(?:-partial)?|resource-backlog-samples|(?:hot_wallet|distributed_wallets|replays|hot_plus_distributed|sqs_backlog|plateau_[a-z0-9_]+)(?:-counters|-prometheus(?:-through-drain)?|-responses)?)\.(?:json|jsonl|txt)$/.test(
            name,
          )
        )
          continue;
        await execute([
          "aws",
          "s3api",
          "put-object",
          "--region",
          "us-east-2",
          "--bucket",
          manifest.artifactsBucket,
          "--key",
          `results/${manifest.unit}/${directory}/${name}`,
          "--body",
          `${resultsPath}/${directory}/${name}`,
        ]);
      }
    }
    if (await Bun.file(executionPath).exists())
      await execute([
        "aws",
        "s3api",
        "put-object",
        "--region",
        "us-east-2",
        "--bucket",
        manifest.artifactsBucket,
        "--key",
        `results/${manifest.unit}/execution.json`,
        "--body",
        executionPath,
      ]);
  } finally {
    await rm(dockerAuth, { recursive: true, force: true });
  }
}
