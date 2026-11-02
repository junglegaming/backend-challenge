import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { docsMarkdownCsp, renderDocsMarkdown } from "./render-docs-markdown";

const publicFiles = new Set([
  "README.md",
  "ARCHITECTURE.md",
  "compose.yaml",
  "Dockerfile",
  "package.json",
  ".github/workflows/ci.yml",
  "mikro-orm.config.ts",
  "load/target.ts",
  "load/source-files.ts",
  "docker/aws/us-east-2-bundle.crt",
  "docker/keycloak/wagering-realm.json",
  "docker/prometheus/prometheus.yml",
  "docker/grafana/dashboards/wagering.json",
]);
const textHeaders = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
function publicFile(path: string): boolean {
  if (publicFiles.has(path)) return true;
  if (path.split("/").some((part) => !part || part.startsWith("."))) return false;
  return (
    /^docs\/.+\.(html|md|svg)$/.test(path) ||
    /^docs\/load-report\/(local|aws)\/campaign\.json$/.test(path) ||
    /^src\/.+\.ts$/.test(path) ||
    /^database\/migrations\/.+\.ts$/.test(path) ||
    /^infra\/aws\/[^/]+\.(tf|md)$/.test(path) ||
    path === "docker/nginx/nginx.conf"
  );
}
const sourceDirectory = (path: string) =>
  path.split("/").every((part) => part && !part.startsWith(".")) &&
  (path === "src" || path.startsWith("src/"));

/** Preview only public documentation and referenced source files, never the whole checkout. */
export function createDocsHandler(root: string): (request: Request) => Response {
  const canonicalRoot = realpathSync(root);
  const missing = () => new Response("Not found", { status: 404, headers: textHeaders });
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", {
        status: 405,
        headers: { ...textHeaders, Allow: "GET, HEAD" },
      });
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/")
      return Response.redirect(new URL("/docs/load-report/index.html", url).href, 302);
    try {
      const path = decodeURIComponent(url.pathname).replace(/^\/|\/$/g, "");
      if (path.includes("\\") || path.includes("\0")) return missing();
      if (!publicFile(path) && !sourceDirectory(path)) return missing();
      const canonical = realpathSync(resolve(canonicalRoot, path));
      const actual = relative(canonicalRoot, canonical);
      if (actual === ".." || actual.startsWith(`..${sep}`) || actual.startsWith(sep))
        return missing();
      if (!publicFile(actual) && !sourceDirectory(actual)) return missing();
      const stat = statSync(canonical);
      if (stat.isDirectory() && sourceDirectory(actual)) {
        if (!url.pathname.endsWith("/")) {
          url.pathname += "/";
          return Response.redirect(url.href, 302);
        }
        const items = readdirSync(canonical, { withFileTypes: true })
          .filter(
            (item) =>
              !item.name.startsWith(".") &&
              (item.isDirectory() || publicFile(`${actual}/${item.name}`)),
          )
          .map(
            (item) =>
              `<li><a href="${encodeURIComponent(item.name)}${item.isDirectory() ? "/" : ""}">${escapeHtml(item.name)}${item.isDirectory() ? "/" : ""}</a></li>`,
          )
          .join("");
        return new Response(
          `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${escapeHtml(path)}</title><h1>${escapeHtml(path)}</h1><ul>${items}</ul></html>`,
          {
            headers: { ...textHeaders, "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (!stat.isFile() || !publicFile(actual)) return missing();
      if (extname(actual) === ".md")
        return new Response(
          request.method === "HEAD"
            ? null
            : renderDocsMarkdown(readFileSync(canonical, "utf8"), path, url.href),
          {
            headers: {
              ...textHeaders,
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": docsMarkdownCsp,
            },
          },
        );
      const type: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
      };
      return new Response(request.method === "HEAD" ? null : Bun.file(canonical), {
        headers: {
          ...textHeaders,
          "Content-Type": type[extname(actual)] ?? textHeaders["Content-Type"],
        },
      });
    } catch {
      return missing();
    }
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const port =
    args.length === 0 ? 4173 : args.length === 2 && args[0] === "--port" ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Usage: bun run docs:preview [--port 4173]");
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: createDocsHandler(resolve(import.meta.dir, "..")),
  });
  console.log(`Documentation: http://localhost:${server.port}/docs/load-report/index.html`);
  console.log(`Architecture: http://localhost:${server.port}/docs/architecture.html`);
}
