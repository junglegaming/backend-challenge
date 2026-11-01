import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remoteK6 } from "../../load/remote-k6";

for (const startingState of ["created", "running"] as const) {
  test(`remote cancellation removes the owned container while ${startingState}`, async () => {
    const cache = join(homedir(), ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "k6-cancel-"));
    const cancellation = new AbortController();
    const calls: string[][] = [];
    let state = "created";
    let finishStart: ((response: Response) => void) | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const args = (await request.json()) as string[];
        calls.push(args);
        if (args[0] === "create") return Response.json({ code: 0, out: "owned-id\n" });
        if (args[0] === "start") {
          state = startingState;
          return new Promise<Response>((done) => {
            finishStart = done;
            cancellation.abort(new Error("guardrail"));
          });
        }
        if (args[0] === "rm" && args.at(-1) === "owned-id") {
          state = "removed";
          finishStart?.(Response.json({ code: 125, out: "" }));
          return Response.json({ code: 0, out: "owned-id\n" });
        }
        // Docker kill fails for created containers. Removal must make a pending start impossible.
        return Response.json({ code: 1, out: "" });
      },
    });
    try {
      const cli = join(directory, "docker");
      await Bun.write(
        cli,
        `#!${process.execPath}\nconst response = await fetch(process.env.FIXTURE_DOCKER_URL, {method:"POST", body:JSON.stringify(process.argv.slice(2))}); const result=await response.json(); process.stdout.write(result.out); process.exitCode=result.code;\n`,
      );
      await chmod(cli, 0o700);
      await expect(
        remoteK6(
          ["fixture-image"],
          {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            FIXTURE_DOCKER_URL: String(server.url),
          },
          cancellation.signal,
          "owned-name",
        ),
      ).rejects.toThrow("guardrail");
      expect(state).toBe("removed");
      expect(calls.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", "owned-id"]]);
      expect(calls.some((args) => args[0] === "kill")).toBe(false);
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
