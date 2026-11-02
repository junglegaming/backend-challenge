import { docsThemeCsp, docsThemeScript, docsThemeStyles, renderDocsTopbar } from "./docs-theme";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const allowedTags = new Set(
  "h1 h2 h3 h4 h5 h6 p a pre code blockquote ul ol li hr table thead tbody tr td th strong em del br img input details summary".split(
    " ",
  ),
);

function safeUrl(value: string, image: boolean, base: string): string | null {
  try {
    const url = new URL(value, base);
    return ["http:", "https:", ...(image ? [] : ["mailto:"])].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** GitHub-style Unicode anchors retain the accents used by the documentation's links. */
function headingIds(markdown: string): string[] {
  const ids: string[] = [];
  const used = new Set<string>();
  Bun.markdown.render(markdown, {
    html: () => "",
    heading(text) {
      const base = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
        .replace(/\s/g, "-");
      let id = base;
      let suffix = 0;
      while (used.has(id)) id = `${base}-${++suffix}`;
      used.add(id);
      ids.push(id);
      return "";
    },
  });
  return ids;
}

/** Keep document formatting, details and explicit anchors; exclude active HTML and URLs. */
function renderBody(markdown: string, base: string): string {
  const ids = headingIds(markdown);
  let heading = 0;
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (!allowedTags.has(tag) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
          element.remove();
          return;
        }
        if (tag === "input" && element.getAttribute("type") !== "checkbox") {
          element.remove();
          return;
        }
        for (const [attribute, value] of [...element.attributes]) {
          if ((attribute === "href" && tag === "a") || (attribute === "src" && tag === "img")) {
            const url = safeUrl(value, tag === "img", base);
            // Absolute URLs keep entity-obfuscated schemes in an HTTP path, never executable.
            if (url) element.setAttribute(attribute, url);
            else element.removeAttribute(attribute);
            continue;
          }
          const allowed =
            (attribute === "id" && /^(a|h[1-6])$/.test(tag)) ||
            (attribute === "title" && (tag === "a" || tag === "img")) ||
            (attribute === "alt" && tag === "img") ||
            (attribute === "align" &&
              /^(td|th)$/.test(tag) &&
              /^(left|center|right)$/.test(value)) ||
            (attribute === "start" && tag === "ol" && /^\d+$/.test(value)) ||
            (attribute === "open" && tag === "details") ||
            (tag === "input" && ["type", "disabled", "checked"].includes(attribute));
          if (!allowed) element.removeAttribute(attribute);
        }
        if (/^h[1-6]$/.test(tag)) element.setAttribute("id", ids[heading++] ?? "");
        if (tag === "input") element.setAttribute("disabled", "");
      },
      comments(comment) {
        comment.remove();
      },
    })
    .transform(Bun.markdown.html(markdown));
}

export const docsMarkdownCsp = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; ${docsThemeCsp}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const styles = `:root{color-scheme:light dark;--bg:#f4f7f8;--panel:#fff;--ink:#18313f;--muted:#526774;--line:#d6e1e6;--accent:#087f8c;--code:#edf3f5}*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.doc-shell{max-width:1120px;margin:auto;padding:28px 28px 64px}a{color:var(--accent);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.markdown-body{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:clamp(22px,5vw,58px);overflow-wrap:anywhere}.markdown-body>:first-child{margin-top:0}.markdown-body>:last-child{margin-bottom:0}h1,h2,h3,h4,h5,h6{line-height:1.3;letter-spacing:-.025em;scroll-margin-top:24px}h1{font-size:clamp(27px,4vw,40px);margin:0 0 28px}h2{font-size:26px;margin:44px 0 20px;padding-bottom:12px;border-bottom:1px solid var(--line)}h3{font-size:21px;margin-top:30px}h4,h5,h6{font-size:17px;margin-top:26px}p,ul,ol,blockquote,pre,table,details{margin:0 0 20px}li+li{margin-top:6px}li>p{margin:8px 0}li>ul,li>ol{margin:8px 0}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.88em}code{padding:3px 6px;border-radius:5px;background:var(--code)}pre{padding:20px;border:1px solid var(--line);border-radius:10px;overflow-x:auto;line-height:1.65;overflow-wrap:normal}pre,pre code{background:var(--code)}pre code{padding:0;font-size:inherit;white-space:pre}table{display:block;width:max-content;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:14px}th,td{border:1px solid var(--line);padding:10px 14px;vertical-align:top;text-align:left}th{background:var(--code);font-weight:650}blockquote{border-left:3px solid var(--accent);padding:5px 20px;color:var(--muted)}blockquote>:last-child{margin-bottom:0}hr{border:0;border-top:1px solid var(--line);margin:32px 0}img{max-width:100%;height:auto}details{padding:16px 20px;border:1px solid var(--line);border-radius:10px}summary{cursor:pointer;font-weight:650}details[open]>summary{margin-bottom:18px}input[type=checkbox]{accent-color:var(--accent);margin-right:7px}.doc-footer{margin:22px 0 0;text-align:center;color:var(--muted);font-size:12px}@media(max-width:600px){.doc-shell{padding:16px 12px 32px}.markdown-body{border-radius:12px;padding:22px 18px}h2{font-size:23px}pre{padding:14px}}@media print{:root{color-scheme:light;--bg:#fff;--panel:#fff;--ink:#18313f;--muted:#526774;--line:#d6e1e6;--accent:#087f8c;--code:#edf3f5}.doc-shell{max-width:none;padding:0}.doc-footer{display:none}.markdown-body{border:0;padding:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}pre code{white-space:pre-wrap}table{display:table;width:100%;font-size:11px}}`;
const darkStyles = `:root{--bg:#101c23;--panel:#172730;--ink:#e5eff3;--muted:#a5bac6;--line:#314b59;--accent:#68cbd1;--code:#101e26}`;

export function renderDocsMarkdown(markdown: string, path: string, url: string): string {
  const title = path.split("/").at(-1) ?? path;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Jungle Docs</title><style>${styles}${docsThemeStyles}</style><style data-docs-dark media="screen and (prefers-color-scheme: dark)">${darkStyles}</style>${docsThemeScript}</head><body><div class="doc-shell">${renderDocsTopbar("/")}<main class="markdown-body">${renderBody(markdown, url)}</main><footer class="doc-footer">Jungle · Distributed Wagering Processor</footer></div></body></html>`;
}
