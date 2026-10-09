import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "../..");
const MAIN = resolve(ROOT, "src/main.ts");

export interface Instance {
  name: string;
  url: string;
  proc: Subprocess<"ignore", "pipe", "pipe">;
  logs: string[];
  exited: Promise<number>;
  /** Abrupt death: no shutdown hooks, nothing flushed — the crash scenario. */
  kill(): Promise<void>;
}

/**
 * Starts a real, separate `bun src/main.ts` process (its own event loop, DB pool and SQS client).
 * Resolves once the instance logs its URL.
 */
export async function spawnInstance(
  name: string,
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<Instance> {
  const proc = Bun.spawn([process.execPath, "run", MAIN], {
    cwd: ROOT,
    // info level is required: the URL is discovered from the "instance started" log line.
    env: { ...process.env, ...env, LOG_LEVEL: "info", INSTANCE_ID: name, PORT: env.PORT ?? "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs: string[] = [];
  let resolveUrl: (url: string) => void = () => {};
  const urlPromise = new Promise<string>((r) => {
    resolveUrl = r;
  });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        logs.push(line);
        if (line.includes('"instance started"')) {
          try {
            resolveUrl(JSON.parse(line).url);
          } catch {
            // ignore
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
  };
  void pump(proc.stdout);
  void pump(proc.stderr);

  const exited = proc.exited;
  const url = await Promise.race([
    urlPromise,
    exited.then((code) => {
      throw new Error(`${name} exited with ${code} before starting:\n${logs.slice(-20).join("\n")}`);
    }),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`${name} did not start in ${timeoutMs}ms:\n${logs.slice(-20).join("\n")}`);
    }),
  ]);

  return {
    name,
    url,
    proc,
    logs,
    exited,
    async kill() {
      if (proc.exitCode !== null) return;
      proc.kill("SIGKILL");
      await exited;
    },
  };
}

export async function killAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.map((i) => i.kill()));
}
