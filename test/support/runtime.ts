import { expect } from "bun:test";
import { command, compose, containersOf, pollUntil, testEnvironment, testProject } from "./stack";

export const replicas = { api: 3, consumer: 3, worker: 2 } as const;
export type RuntimeRole = keyof typeof replicas;

export async function runtimeLogs(role: RuntimeRole): Promise<Record<string, unknown>[]> {
  const output = await compose(["logs", "--no-log-prefix", "--no-color", role]);
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export async function runtimeEvent(
  role: RuntimeRole,
  matches: (record: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
) {
  return pollUntil(
    `runtime event on ${role}`,
    async () => (await runtimeLogs(role)).find(matches),
    timeoutMs,
  );
}
export async function instanceContainer(role: RuntimeRole, instanceId: string) {
  const ids = await containersOf(role);
  const id = ids.find((id) => id.startsWith(instanceId));
  if (!id) throw new Error("Logged instance is not a running test replica");
  return id;
}
export async function assertReplicas(): Promise<void> {
  for (const [role, count] of Object.entries(replicas)) {
    const ids = await containersOf(role);
    expect(ids).toHaveLength(count);
    for (const id of ids)
      expect(
        (await command(["docker", "inspect", "--format", "{{.State.Health.Status}}", id])).trim(),
      ).toBe("healthy");
  }
}
export async function waitForReplicas(): Promise<void> {
  await pollUntil(
    "all eight application replicas healthy",
    async () => {
      for (const [role, count] of Object.entries(replicas)) {
        const ids = await containersOf(role);
        if (ids.length !== count) return false;
        const states = await Promise.all(
          ids.map((id) =>
            command(["docker", "inspect", "--format", "{{.State.Health.Status}}", id]),
          ),
        );
        if (states.some((state) => state.trim() !== "healthy")) return false;
      }
      return true;
    },
    90_000,
  );
}
export async function configureRole(
  role: RuntimeRole,
  overrides: Record<string, string> = {},
  waitForReady = true,
) {
  await compose(
    [
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      ...(waitForReady ? ["--wait", "--wait-timeout", "90"] : []),
      "--scale",
      `${role}=${replicas[role]}`,
      role,
    ],
    testProject,
    { ...testEnvironment, ...overrides },
  );
}
export async function restoreRole(role: RuntimeRole) {
  await configureRole(role);
}

export async function changeContainer(
  containerId: string,
  action: "pause" | "unpause" | "stop" | "restart",
) {
  const project = await command([
    "docker",
    "inspect",
    "--format",
    '{{index .Config.Labels "com.docker.compose.project"}}',
    containerId,
  ]);
  if (project.trim() !== testProject) throw new Error("Refusing to change a non-test container");
  return command(["docker", action, containerId]);
}
