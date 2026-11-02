import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsHandler } from "../../scripts/preview-docs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wagering-docs-"));
  mkdirSync(join(root, "docs/load-report/local"), { recursive: true });
  mkdirSync(join(root, "src/observability"), { recursive: true });
  writeFileSync(join(root, "docs/load-report/local/index.html"), "<h1>Local</h1>");
  writeFileSync(join(root, "docs/load-report/local/campaign.json"), "{}");
  writeFileSync(join(root, "src/observability/health.ts"), "export {};");
  writeFileSync(join(root, "private.txt"), "private fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("preview serves public pages and referenced sources with correct relative directory navigation", async () => {
  const handle = createDocsHandler(root);
  const response = handle(new Request("http://localhost/docs/load-report/local/index.html"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toBe("<h1>Local</h1>");
  expect(handle(new Request("http://localhost/")).headers.get("Location")).toBe(
    "http://localhost/docs/load-report/index.html",
  );
  expect(handle(new Request("http://localhost/src/observability")).headers.get("Location")).toBe(
    "http://localhost/src/observability/",
  );
  expect(await handle(new Request("http://localhost/src/observability/")).text()).toContain(
    'href="health.ts"',
  );
  expect(
    handle(new Request("http://localhost/docs/load-report/local/campaign.json")).headers.get(
      "Content-Type",
    ),
  ).toBe("application/json; charset=utf-8");
  expect(
    await handle(
      new Request("http://localhost/docs/load-report/local/index.html", { method: "HEAD" }),
    ).text(),
  ).toBe("");
});

test("preview refuses private paths, encoded traversal and symlinks into unserved files", async () => {
  const handle = createDocsHandler(root);
  symlinkSync(join(root, "private.txt"), join(root, "docs/leak.html"));
  symlinkSync(join(root, "src/observability/health.ts"), join(root, "docs/source.html"));
  for (const path of [
    "/private.txt",
    "/docs/leak.html",
    "/docs/%2e%2e%2fprivate.txt",
    "/src/../private.txt",
    "/src/%2e%2e%2fprivate.txt",
    "/docs/missing.html",
    "/load/results/result.json",
  ])
    expect(handle(new Request(`http://localhost${path}`)).status).toBe(404);
  const source = handle(new Request("http://localhost/docs/source.html"));
  expect(source.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(await source.text()).toBe("export {};");
  expect(
    handle(new Request("http://localhost/docs/load-report/local/index.html", { method: "POST" }))
      .status,
  ).toBe(405);
});
