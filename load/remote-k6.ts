import { command } from "../test/support/stack";

export async function remoteK6(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  name: string,
) {
  signal.throwIfAborted();
  const id = (await command(["docker", "create", "--name", name, ...args], env)).trim();
  let removal: Promise<unknown> | undefined;
  const remove = () => {
    // Removal works in created and running states. A pending start can no longer launch the image.
    removal ??= command(["docker", "rm", "-f", id], env);
    // The owner awaits this promise in finally, including a failed removal.
    void removal.catch(() => {});
  };
  signal.addEventListener("abort", remove, { once: true });
  try {
    signal.throwIfAborted();
    const child = Bun.spawn(["docker", "start", "--attach", id], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (signal.aborted) remove();
    const [output, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal.throwIfAborted();
    const containerExit = Number(
      (await command(["docker", "inspect", "--format", "{{.State.ExitCode}}", id], env)).trim(),
    );
    if (code !== 0 || containerExit !== 0)
      throw new Error(`Remote k6 failed (${code}/${containerExit})`);
    return output;
  } finally {
    signal.removeEventListener("abort", remove);
    if (removal) await removal;
    else await command(["docker", "rm", "-f", id], env);
  }
}
