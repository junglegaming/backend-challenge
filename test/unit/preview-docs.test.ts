import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsThemeCsp, docsThemeScript } from "../../scripts/docs-theme";
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

test("preview exposes only the explicitly linked public build and configuration files", async () => {
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI");
  writeFileSync(join(root, ".github/workflows/private.yml"), "private fixture");
  writeFileSync(join(root, "Dockerfile"), "FROM oven/bun:1.4.3");
  writeFileSync(join(root, "package.json"), '{"name":"docs-fixture"}');
  const handle = createDocsHandler(root);
  const ci = handle(new Request("http://localhost/.github/workflows/ci.yml"));
  expect(ci.status).toBe(200);
  expect(ci.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(await ci.text()).toBe("name: CI");
  expect(handle(new Request("http://localhost/Dockerfile")).status).toBe(200);
  expect(handle(new Request("http://localhost/package.json")).headers.get("Content-Type")).toBe(
    "application/json; charset=utf-8",
  );
  expect(handle(new Request("http://localhost/.github/workflows/private.yml")).status).toBe(404);
  expect(handle(new Request("http://localhost/favicon.ico")).status).toBe(204);
});

test("preview renders Markdown with tables, code, Unicode anchors and working relative links", async () => {
  writeFileSync(
    join(root, "README.md"),
    [
      "# Documentação",
      "",
      "## Servidor de documentação",
      "",
      "[Relatório](docs/load-report/local/index.html) · [Seção](#servidor-de-documentação)",
      "",
      "| Tema | Estado |",
      "| --- | --- |",
      "| Escuro | Pronto |",
      "",
      "```ts",
      "const html = '<script>example</script>';",
      "```",
      "",
      '<a id="âncora-explícita"></a>',
      "",
      "<details>",
      "<summary>Mais informações</summary>",
      "",
      "**Conteúdo** preservado.",
      "",
      "</details>",
      "",
      "## Servidor de documentação",
      "",
      "## A",
      "## A-1",
      "## A",
    ].join("\n"),
  );
  const handle = createDocsHandler(root);
  const response = handle(new Request("http://localhost:4174/README.md"));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Content-Security-Policy")).toContain(docsThemeCsp);
  expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(html).toContain('<h2 id="servidor-de-documentação">');
  expect(html).toContain('<h2 id="servidor-de-documentação-1">');
  expect(html).toContain('<h2 id="a-2">');
  expect(html).toContain('<a id="âncora-explícita"></a>');
  expect(html).toContain('href="http://localhost:4174/docs/load-report/local/index.html"');
  expect(html).toContain(
    `href="${new URL("#servidor-de-documentação", "http://localhost:4174/README.md").href}"`,
  );
  expect(html).toContain("<table>");
  expect(html).toContain("<pre><code>");
  expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
  expect(html).toContain("<details>");
  expect(html).toContain("<summary>Mais informações</summary>");
  expect(html).toContain("<strong>Conteúdo</strong> preservado.");
  expect(html).toContain(docsThemeScript);
  expect(
    await handle(new Request("http://localhost:4174/README.md", { method: "HEAD" })).text(),
  ).toBe("");
});

test("Markdown excludes active HTML and unsafe URLs, including entity-obfuscated schemes", async () => {
  writeFileSync(
    join(root, "docs/security.md"),
    [
      "# Documento",
      "",
      "<script>window.injected = true</script>",
      "<style>body { display: none }</style>",
      '<iframe src="https://example.com"></iframe>',
      '<svg onload="attack()"></svg>',
      '<form><input name="secret"></form>',
      '<img src="javascript:attack()" onerror="attack()">',
      '<a href="jav&#x61;script:attack()" onclick="attack()">Entity</a>',
      '<a href="java&#x0a;script:attack()">Whitespace entity</a>',
      '<a href="javascript&colon;attack()">Named entity</a>',
      '<a href="https://example.com/?a=1&amp;b=2">HTTPS</a>',
      "",
      "[JavaScript](javascript:attack()) · [Data](data:text/html,payload) · [VBScript](vbscript:attack())",
    ].join("\n"),
  );
  const html = await createDocsHandler(root)(
    new Request("http://localhost/docs/security.md"),
  ).text();
  const body = html.split('<main class="markdown-body">')[1]?.split("</main>")[0] ?? "";
  expect(body).not.toBe("");
  expect(body).not.toMatch(/<(script|style|iframe|svg|form|input)\b/i);
  expect(body).not.toMatch(/\bon(error|click|load)=/i);
  const urls: string[] = [];
  new HTMLRewriter()
    .on("a[href],img[src]", {
      element(element) {
        urls.push(element.getAttribute("href") ?? element.getAttribute("src") ?? "");
      },
    })
    .transform(body);
  expect(urls.length).toBe(4);
  for (const url of urls) expect(["http:", "https:"]).toContain(new URL(url).protocol);
  expect(body).not.toMatch(/(?:href|src)="(?:javascript|data|vbscript):/i);
  expect(body).toContain('href="https://example.com/?a=1&amp;b=2"');
});
