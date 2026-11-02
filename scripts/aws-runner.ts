import { chmod, mkdir, open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyLoadManifest } from "../load/target";

function parseSafeSdkDiagnostic(stderr: string) {
  const lines = stderr.split("\n");
  const allowedCommands = [
    "GetQueueUrlCommand",
    "GetQueueAttributesCommand",
    "ReceiveMessageCommand",
    "DeleteMessageCommand",
    "SendMessageCommand",
    "SendMessageBatchCommand",
    "ChangeMessageVisibilityCommand",
    "UNKNOWN",
  ];
  const allowedNames = [
    "RequestThrottled",
    "Throttling",
    "ThrottlingException",
    "TooManyRequestsException",
    "AccessDenied",
    "AccessDeniedException",
    "AWS.SimpleQueueService.AccessDenied",
    "ReceiptHandleIsInvalid",
    "InvalidParameterValue",
    "InvalidAddress",
    "InvalidSecurity",
    "QueueDoesNotExist",
    "AWS.SimpleQueueService.NonExistentQueue",
    "OverLimit",
    "KmsAccessDenied",
    "KmsThrottled",
    "ServiceUnavailable",
    "InternalError",
    "InvalidClientTokenId",
    "ExpiredToken",
    "ExpiredTokenException",
    "CredentialsProviderError",
    "TimeoutError",
    "AbortError",
    "TypeError",
    "Error",
    "UNKNOWN",
  ];
  const failure = (prefix: string) => {
    const raw = lines.find((line) => line.startsWith(prefix));
    if (raw && raw.length < 1024) {
      try {
        const v = JSON.parse(raw.slice(prefix.length));
        if (
          v &&
          typeof v === "object" &&
          Object.keys(v).sort().join(",") === "attempts,httpStatus,name,operation" &&
          allowedCommands.includes(v.operation) &&
          allowedNames.includes(v.name) &&
          (v.httpStatus === null ||
            (Number.isInteger(v.httpStatus) && v.httpStatus >= 100 && v.httpStatus <= 599)) &&
          (v.attempts === null ||
            (Number.isInteger(v.attempts) && v.attempts >= 1 && v.attempts <= 10))
        )
          return v;
      } catch {}
    }
    return null;
  };
  const firstError = failure("WAGERING_SAFE_SDK_FAILURE ");
  const fatalError = failure("WAGERING_SAFE_SDK_FATAL ");
  const rawStats = lines
    .filter((line) => line.startsWith("WAGERING_EVENT_ACK_RETRY_STATS "))
    .at(-1);
  let eventAcks = null;
  if (rawStats && rawStats.length < 1024) {
    try {
      const v = JSON.parse(rawStats.slice("WAGERING_EVENT_ACK_RETRY_STATS ".length));
      if (
        v &&
        typeof v === "object" &&
        Object.keys(v).sort().join(",") ===
          "acknowledged,attempts,backoffMs,calls,deadlineStopped,exhausted,failed,maxAttemptsObserved,retries,retryableErrors" &&
        Object.values(v).every((x) => Number.isSafeInteger(x) && (x as number) >= 0) &&
        v.maxAttemptsObserved <= 7 &&
        v.attempts <= v.calls * 7 &&
        v.retries <= v.calls * 6 &&
        v.backoffMs <= v.calls * 2550 &&
        v.acknowledged + v.failed <= v.calls
      )
        eventAcks = v;
    } catch {}
  }
  return {
    sdkDiagnosticReady: lines.includes("WAGERING_SAFE_SDK_READY"),
    firstError,
    fatalError,
    eventAckRetryReady: lines.includes("WAGERING_EVENT_ACK_RETRY_READY"),
    eventAcks,
  };
}

async function waitForPrometheusReady(cutoff: number, prometheusName: string) {
  const began = Date.now(),
    end = Math.min(began + 45_000, cutoff);
  const diagnostic = {
    passed: false,
    polls: 0,
    elapsedMs: 0,
    last: null as null | {
      containerRunning: boolean | null;
      readyStatus: number | null;
      queryStatus: number | null;
      status: string;
      errorType: string;
      resultCount: number | null;
      upCount: number | null;
      errorName: string | null;
    },
  };
  while (Date.now() < end) {
    diagnostic.polls++;
    const last = {
      containerRunning: null as boolean | null,
      readyStatus: null as number | null,
      queryStatus: null as number | null,
      status: "NO_RESPONSE",
      errorType: "NONE",
      resultCount: null as number | null,
      upCount: null as number | null,
      errorName: null as string | null,
    };
    try {
      const child = Bun.spawn(
        ["docker", "inspect", "--format", "{{.State.Running}}", prometheusName],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: Math.max(1, Math.min(2500, end - Date.now())),
          killSignal: "SIGKILL",
        },
      );
      const boundedState = async () => {
        const reader = child.stdout.getReader();
        const parts: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 16) {
              child.kill("SIGKILL");
              throw new Error();
            }
            parts.push(chunk.value);
          }
          return new TextDecoder().decode(Buffer.concat(parts));
        } finally {
          reader.releaseLock();
        }
      };
      const [state, code] = await Promise.all([boundedState(), child.exited]);
      last.containerRunning = code === 0 && state.trim() === "true";
      if (!last.containerRunning) {
        diagnostic.last = last;
        break;
      }
      const signal = AbortSignal.timeout(Math.max(1, Math.min(2500, end - Date.now())));
      const ready = await fetch("http://127.0.0.1:9090/-/ready", { redirect: "manual", signal });
      last.readyStatus = ready.status;
      await ready.body?.cancel();
      const query = await fetch(
        "http://127.0.0.1:9090/api/v1/query?" +
          new URLSearchParams({ query: 'up{job="wagering"}' }),
        { redirect: "manual", signal },
      );
      last.queryStatus = query.status;
      const parts: Uint8Array[] = [];
      let bytes = 0;
      if (query.body) {
        const reader = query.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 65_536) {
              const error = new Error();
              error.name = "ResponseBodyLimit";
              throw error;
            }
            parts.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      let value: any;
      try {
        value = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
      } catch {
        last.status = "INVALID_JSON";
      }
      if (value) {
        last.status = ["success", "error"].includes(value.status) ? value.status : "UNKNOWN";
        last.errorType =
          value.errorType === undefined
            ? "NONE"
            : [
                  "bad_data",
                  "timeout",
                  "canceled",
                  "execution",
                  "internal",
                  "unavailable",
                  "not_found",
                ].includes(value.errorType)
              ? value.errorType
              : "UNKNOWN";
        if (
          value.data?.resultType === "vector" &&
          Array.isArray(value.data.result) &&
          value.data.result.length <= 1000
        ) {
          last.resultCount = value.data.result.length;
          last.upCount = value.data.result.filter(
            (series: any) => Array.isArray(series?.value) && series.value[1] === "1",
          ).length;
        }
      }
      diagnostic.passed =
        last.readyStatus === 200 &&
        last.queryStatus === 200 &&
        last.status === "success" &&
        last.resultCount !== null;
    } catch (error) {
      const name = error instanceof Error ? error.name : "UNKNOWN";
      last.errorName = [
        "Error",
        "TypeError",
        "AbortError",
        "TimeoutError",
        "SyntaxError",
        "ResponseBodyLimit",
      ].includes(name)
        ? name
        : "UNKNOWN";
    }
    diagnostic.last = last;
    if (diagnostic.passed) break;
    const remaining = end - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(500, remaining));
  }
  diagnostic.elapsedMs = Date.now() - began;
  return diagnostic;
}

function parseSafePrometheusStatus(stderr: string): number | null {
  const match = /^error: Prometheus returned ([1-5][0-9]{2})$/m.exec(stderr);
  return match ? Number(match[1]) : null;
}

// Invoked through SSM inside the private EC2 runner. Not a test/CI prerequisite.
interface RunnerManifest {
  commit: string;
  session: string;
  account: string;
  unit: "smoke" | "full-1" | "full-2" | "full-3" | "plateaus-1";
  sourceManifest: string;
  sourceManifestSha256: string;
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
const cutoff = Date.parse(manifest.deadline) - 60 * 60_000;
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
await verifyLoadManifest(manifest.sourceManifest, manifest.commit, manifest.sourceManifestSha256);

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
const dockerAuth = `${base}/docker-auth-${manifest.unit}`;
const prometheusName = `wagering-load-prometheus-${manifest.session}-${manifest.unit}`;
let prometheusAttempted = false;
let runId: string | undefined;
const resultsPath = resolve("load/results");
const executionPath = `${base}/${manifest.unit}-execution.json`;
const execution = {
  unit: manifest.unit,
  commit: manifest.commit,
  sourceManifestSha256: manifest.sourceManifestSha256,
  startedAt: new Date().toISOString(),
  completedAt: "",
  stage: "secrets",
  passed: false,
  primaryFailure: null as null | { stage: string; code: string },
  cleanupFailures: [] as { stage: string; code: string }[],
  collectionFailures: [] as { stage: string; code: string }[],
  prometheusReady: null as null | Awaited<ReturnType<typeof waitForPrometheusReady>>,
  load: null as null | {
    exitCode: number;
    runtimeGuardrailReached: boolean;
    sdkDiagnostic: ReturnType<typeof parseSafeSdkDiagnostic>;
    prometheusHttpStatus: number | null;
    lines: string[];
    failureLocations: string[];
  },
};
const failureCode = (error: unknown) =>
  error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "UnknownError";
async function removeContainer(name: string) {
  const ids = (await execute(["docker", "ps", "-aq", "--filter", `name=^/${name}$`])).trim();
  if (ids) await execute(["docker", "rm", "-f", name]);
}
async function upload(path: string, key: string) {
  await execute([
    "aws",
    "s3api",
    "put-object",
    "--region",
    "us-east-2",
    "--bucket",
    manifest.artifactsBucket,
    "--key",
    `results/${manifest.unit}/${key}`,
    "--body",
    path,
  ]);
}
try {
  await Bun.write(executionPath, JSON.stringify(execution, null, 2));
  const databaseSecret = JSON.parse(await secret(manifest.databaseSecretArn)) as {
    username?: string;
    password?: string;
  };
  if (databaseSecret.username !== "wagering" || !databaseSecret.password)
    throw new Error("Unexpected database identity");
  const provider = await secret(manifest.clientSecretArns.PROVIDER_A_SECRET);
  const operator = await secret(manifest.clientSecretArns.OPERATOR_SECRET);
  execution.stage = "docker-auth";
  await mkdir(dockerAuth, { mode: 0o700 });
  env.DOCKER_CONFIG = dockerAuth;
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
  execution.stage = "image-pull";
  for (const image of [manifest.images.k6, manifest.images.prometheus])
    await execute(["docker", "pull", image]);
  execution.stage = "prometheus-start";
  const prometheusConfig = `${base}/prometheus-${manifest.unit}.yml`;
  await Bun.write(
    prometheusConfig,
    `global:\n  scrape_interval: 5s\n  scrape_timeout: 3s\nscrape_configs:\n  - job_name: wagering\n    dns_sd_configs:\n      - names: [api.${manifest.namespace}, consumer.${manifest.namespace}, worker.${manifest.namespace}]\n        type: A\n        port: 3000\n        refresh_interval: 5s\n    relabel_configs:\n      - source_labels: [__meta_dns_name]\n        regex: '(api|consumer|worker)\\..*'\n        replacement: '$1'\n        target_label: role\n`,
  );
  await chmod(prometheusConfig, 0o644); // Non-secret scrape YAML must be readable by Prometheus uid65534.
  prometheusAttempted = true;
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
  execution.stage = "prometheus-ready";
  execution.prometheusReady = await waitForPrometheusReady(cutoff, prometheusName);
  if (!execution.prometheusReady.passed) {
    const error = new Error();
    error.name = "PrometheusPreloadGate";
    throw error;
  }
  const loadEnv = {
    ...env,
    LOAD_TARGET: "remote",
    LOAD_SCENARIO: manifest.unit === "plateaus-1" ? "plateaus" : "standard",
    LOAD_PROFILE: manifest.unit === "smoke" ? "quick" : "full",
    LOAD_SOURCE_COMMIT: manifest.commit,
    LOAD_SOURCE_MANIFEST: manifest.sourceManifest,
    LOAD_SOURCE_MANIFEST_SHA256: manifest.sourceManifestSha256,
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
  execution.stage = "load";
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
  execution.load = {
    exitCode: code,
    runtimeGuardrailReached: terminated,
    sdkDiagnostic: parseSafeSdkDiagnostic(err),
    prometheusHttpStatus: parseSafePrometheusStatus(err),
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
  if (terminated || code !== 0) {
    execution.primaryFailure = {
      stage: "load",
      code: terminated ? "RuntimeGuardrail" : "LoadFailed",
    };
  }
} catch (error) {
  execution.primaryFailure = { stage: execution.stage, code: failureCode(error) };
} finally {
  for (const name of [
    ...(runId ? [`wagering-load-k6-${runId}`] : []),
    ...(prometheusAttempted ? [prometheusName] : []),
  ]) {
    try {
      await removeContainer(name);
    } catch (error) {
      execution.cleanupFailures.push({ stage: "container", code: failureCode(error) });
    }
  }
  try {
    await rm(dockerAuth, { recursive: true, force: true });
  } catch (error) {
    execution.cleanupFailures.push({ stage: "docker-auth", code: failureCode(error) });
  }
  try {
    // Export only instrument output, never environment, Docker authentication or financial envelopes.
    for (const directory of runId ? [runId] : []) {
      for (const name of await readdir(`${resultsPath}/${directory}`)) {
        if (
          !/^(?:fixtures|expected|environment|verification|partial-verification|result|failure|participation|publication-latency|event-observer(?:-partial)?|resource-backlog-samples|sqs-queue-modes|sqs-producer|(?:hot_wallet|distributed_wallets|replays|hot_plus_distributed|sqs_backlog|plateau_[a-z0-9_]+)(?:-counters|-prometheus(?:-through-drain)?|-responses)?)\.(?:json|jsonl|txt)$/.test(
            name,
          )
        )
          continue;
        try {
          await upload(`${resultsPath}/${directory}/${name}`, `${directory}/${name}`);
        } catch (error) {
          execution.collectionFailures.push({ stage: "artifact-upload", code: failureCode(error) });
        }
      }
    }
  } catch (error) {
    execution.collectionFailures.push({ stage: "artifact-discovery", code: failureCode(error) });
  }
  execution.completedAt = new Date().toISOString();
  execution.passed =
    !execution.primaryFailure &&
    execution.cleanupFailures.length === 0 &&
    execution.collectionFailures.length === 0;
  await Bun.write(executionPath, JSON.stringify(execution, null, 2));
  try {
    await upload(executionPath, "execution.json");
  } catch (error) {
    execution.collectionFailures.push({ stage: "execution-upload", code: failureCode(error) });
    execution.passed = false;
    await Bun.write(executionPath, JSON.stringify(execution, null, 2));
  }
  process.exitCode = execution.passed ? 0 : 1;
  console.log(
    JSON.stringify({
      unit: execution.unit,
      stage: execution.stage,
      passed: execution.passed,
      prometheusReady: execution.prometheusReady,
      load: {
        sdkDiagnostic: execution.load?.sdkDiagnostic ?? null,
        prometheusHttpStatus: execution.load?.prometheusHttpStatus ?? null,
      },
      primaryFailure: execution.primaryFailure,
      cleanupFailures: execution.cleanupFailures,
      collectionFailures: execution.collectionFailures,
    }),
  );
}
