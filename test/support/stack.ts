export const testProject = "wagering-test";
export const testEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  BUN_CONFIG_NO_ENV_FILE: "true",
  BUN_CONFIG_NO_AUTO_INSTALL: "true",
  COMPOSE_PROFILES:
    process.env.WAGERING_STACK_MANAGED === "1"
      ? (process.env.COMPOSE_PROFILES ?? "observability")
      : "observability",
  SQS_WAIT_SECONDS: "1",
  SQS_VISIBILITY_SECONDS: "5",
  SQS_RETRY_BASE_SECONDS: "1",
  SQS_RETRY_MAX_SECONDS: "1",
  OUTBOX_LEASE_MS: "3000",
  OUTBOX_RETRY_MAX_MS: "6000",
  APP_IMAGE_TAG: "test",
  API_HOST_PORT: "13000",
  POSTGRES_HOST_PORT: "15432",
  SQS_HOST_PORT: "14566",
  KEYCLOAK_HOST_PORT: "18080",
  GRAFANA_HOST_PORT: "13001",
  TOXIPROXY_HOST_PORT: "18474",
  PROMETHEUS_HOST_PORT: "19090",
};
export const apiUrl = "http://127.0.0.1:13000";

export async function command(args: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    // Docker lifecycle output contains service names/statuses, never application payloads.
    throw new Error(`${args[0]} ${args[1]} failed (${code}): ${error}`);
  }
  return output;
}

export function compose(
  args: string[],
  project = testProject,
  env: NodeJS.ProcessEnv = testEnvironment,
) {
  // Compose otherwise reads .env implicitly, which this repository forbids.
  return command(["docker", "compose", "--env-file", "/dev/null", "-p", project, ...args], env);
}

export async function containersOf(service: string): Promise<string[]> {
  return (await compose(["ps", "-q", service])).trim().split(/\s+/).filter(Boolean);
}

export async function killContainer(containerId: string): Promise<void> {
  const project = await command([
    "docker",
    "inspect",
    "--format",
    '{{index .Config.Labels "com.docker.compose.project"}}',
    containerId,
  ]);
  if (project.trim() !== testProject) throw new Error("Refusing to kill a non-test container");
  await command(["docker", "kill", containerId]);
}

export async function pollUntil<T>(
  description: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function waitForLogEvent(
  service: string,
  event: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return pollUntil(
    `log event ${event}`,
    async () => {
      const output = await compose(["logs", "--no-log-prefix", "--no-color", service]);
      for (const line of output.split("\n")) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record.event === event) return record;
        } catch {
          /* Docker may include non-JSON lifecycle messages. */
        }
      }
      return undefined;
    },
    timeoutMs,
  );
}

export async function composeUp(): Promise<void> {
  await compose([
    "up",
    "-d",
    "--build",
    "--wait",
    "--wait-timeout",
    "180",
    "--scale",
    "api=3",
    "--scale",
    "consumer=3",
    "--scale",
    "worker=2",
  ]);
}
