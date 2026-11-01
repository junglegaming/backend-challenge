import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadSourceFiles } from "../../load/source-files";

for (const failedStage of [
  "secrets",
  "docker-auth",
  "image-pull",
  "prometheus-start",
  "cleanup-and-collection",
] as const) {
  test(`runner preserves a safe outcome after ${failedStage} failure`, async () => {
    const cache = join(homedir(), ".cache");
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(join(cache, "aws-runner-"));
    const source = join(root, "source");
    const bin = join(root, "bin");
    await mkdir(bin);
    const exported: unknown[] = [];
    const privateFixture = "never-export-this-fixture";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { tool, args } = (await request.json()) as { tool: string; args: string[] };
        const response = (code: number, out = "") => Response.json({ code, out });
        if (tool === "aws" && args[0] === "secretsmanager") {
          if (failedStage === "secrets") return response(1, privateFixture);
          const value = args[args.indexOf("--secret-id") + 1]?.endsWith("database")
            ? JSON.stringify({ username: "wagering", password: privateFixture })
            : privateFixture;
          return response(0, JSON.stringify({ SecretString: value }));
        }
        if (tool === "aws" && args[0] === "ecr") return response(0, privateFixture);
        if (tool === "aws" && args[0] === "s3api") {
          if (failedStage === "cleanup-and-collection") return response(1, privateFixture);
          const path = args[args.indexOf("--body") + 1];
          if (!path) throw new Error("Missing fixture upload path");
          exported.push(await Bun.file(path).json());
          return response(0, "{}");
        }
        if (tool === "docker") {
          if (args[0] === "login")
            return response(failedStage === "docker-auth" ? 1 : 0, privateFixture);
          if (args[0] === "pull")
            return response(failedStage === "image-pull" ? 1 : 0, privateFixture);
          if (args[0] === "run") return response(1, privateFixture);
          if (args[0] === "ps")
            return response(0, failedStage === "cleanup-and-collection" ? "owned-container" : "");
          if (args[0] === "rm") return response(1, privateFixture);
        }
        return response(1, privateFixture);
      },
    });
    try {
      const files: Record<string, string> = {};
      for (const path of loadSourceFiles) {
        const bytes = await Bun.file(path).arrayBuffer();
        const destination = join(source, path);
        await mkdir(dirname(destination), { recursive: true });
        await Bun.write(destination, bytes);
        files[path] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      }
      const commit = "a".repeat(40);
      const sourceManifest = join(root, "source-manifest.json");
      const sourceBytes = JSON.stringify({ commit, files });
      await Bun.write(sourceManifest, sourceBytes);
      const registry = "123456789012.dkr.ecr.us-east-2.amazonaws.com/wagering-load-abcdef-";
      const secret = "arn:aws:secretsmanager:us-east-2:123456789012:secret:";
      const manifest = join(root, "runner-manifest.json");
      await Bun.write(
        manifest,
        JSON.stringify({
          commit,
          session: "abcdef",
          account: "123456789012",
          unit: "smoke",
          sourceManifest,
          sourceManifestSha256: new Bun.CryptoHasher("sha256").update(sourceBytes).digest("hex"),
          deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          apiUrl: "http://internal-fixture.us-east-2.elb.amazonaws.com",
          issuer: "http://keycloak.wagering-load-abcdef.internal:8080/realms/wagering",
          namespace: "wagering-load-abcdef.internal",
          databaseHost: "fixture.us-east-2.rds.amazonaws.com",
          databaseName: "wagering",
          databaseSecretArn: `${secret}database`,
          clientSecretArns: {
            PROVIDER_A_SECRET: `${secret}provider`,
            OPERATOR_SECRET: `${secret}operator`,
          },
          images: Object.fromEntries(
            ["app", "k6", "prometheus"].map((name) => [
              name,
              `${registry}${name}@sha256:${"b".repeat(64)}`,
            ]),
          ),
          artifactsBucket: "wagering-load-abcdef-123456789012-us-east-2",
        }),
      );
      for (const tool of ["aws", "docker"]) {
        const cli = join(bin, tool);
        await Bun.write(
          cli,
          `#!${process.execPath}\nawait Bun.stdin.text(); const response=await fetch(process.env.FIXTURE_COMMAND_URL,{method:"POST",body:JSON.stringify({tool:${JSON.stringify(tool)},args:process.argv.slice(2)})}); const result=await response.json(); process.stdout.write(result.out); process.exitCode=result.code;\n`,
        );
        await chmod(cli, 0o700);
      }
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", resolve("scripts/aws-runner.ts"), manifest],
        {
          cwd: source,
          env: {
            ...process.env,
            BUN_CONFIG_NO_ENV_FILE: "true",
            BUN_CONFIG_NO_AUTO_INSTALL: "true",
            WAGERING_AWS_RUNNER: "1",
            PATH: `${bin}:${process.env.PATH}`,
            FIXTURE_COMMAND_URL: String(server.url),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      const execution = await Bun.file(join(root, "smoke-execution.json")).json();
      expect(execution.passed).toBe(false);
      expect(execution.commit).toBe(commit);
      expect(execution.unit).toBe("smoke");
      expect(execution.primaryFailure.stage).toBe(
        failedStage === "cleanup-and-collection" ? "prometheus-start" : failedStage,
      );
      expect(execution.load).toBeNull();
      expect(await Bun.file(join(root, "smoke.started")).exists()).toBe(true);
      await expect(stat(join(root, "docker-auth-smoke"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify({ stdout, stderr, execution, exported })).not.toContain(privateFixture);
      if (failedStage === "cleanup-and-collection") {
        expect(execution.cleanupFailures).toHaveLength(1);
        expect(execution.collectionFailures).toHaveLength(1);
        expect(exported).toHaveLength(0);
      } else {
        expect(execution.cleanupFailures).toHaveLength(0);
        expect(execution.collectionFailures).toHaveLength(0);
        expect(exported).toHaveLength(1);
        expect(exported[0]).toEqual(execution);
      }
    } finally {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
