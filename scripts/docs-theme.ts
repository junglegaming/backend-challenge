import { createHash } from "node:crypto";

export const docsThemeStyles = `.docs-topbar{position:relative;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:18px;margin:0 0 30px;padding:14px 16px;border:1px solid var(--line,var(--edge,#d6e1e6));border-radius:16px;background:var(--panel,var(--paper,#fff));color:var(--ink,#18313f);font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 18px #00000005}.docs-topbar-links{display:flex;align-items:center;justify-content:center;gap:4px}.docs-topbar-links a{padding:8px 11px;border-radius:8px;color:var(--muted,#526774);font-size:12px;font-weight:650;text-decoration:none;white-space:nowrap}.docs-topbar-links a:hover{color:var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));background:var(--soft,var(--bg,#00000004))}.docs-topbar-links a:focus-visible{outline:3px solid var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));outline-offset:3px}.docs-topbar-brand{display:flex;align-items:center;gap:11px;min-width:0}.docs-topbar-mark{display:grid;place-items:center;flex:0 0 35px;width:35px;height:35px;border:1px solid var(--line,var(--edge,#d6e1e6));border-radius:10px;color:var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));font-size:17px;font-weight:800;line-height:1}.docs-topbar-name{display:block;font-size:14px;font-weight:800;letter-spacing:.025em;line-height:1.35}.docs-topbar-kicker{display:block;margin-top:2px;color:var(--muted,#526774);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.docs-theme-picker{position:relative;flex:0 0 auto}.docs-theme-toggle{display:flex;align-items:center;justify-content:center;gap:9px;min-height:40px;margin:0;padding:9px 12px;border:1px solid var(--line,var(--edge,#d6e1e6));border-radius:10px;background:transparent;color:var(--ink,#18313f);font:600 12px/1.5 system-ui,sans-serif;cursor:pointer}.docs-theme-toggle:hover,.docs-theme-toggle[aria-expanded="true"]{border-color:var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));background:var(--soft,var(--bg,#00000004))}.docs-theme-toggle svg{width:17px;height:17px;flex:0 0 auto}.docs-theme-toggle .docs-theme-chevron{width:12px;height:12px;color:var(--muted,#526774)}.docs-theme-toggle [data-theme-icon]{display:none}.docs-theme-toggle[data-theme="auto"] [data-theme-icon="auto"],.docs-theme-toggle[data-theme="light"] [data-theme-icon="light"],.docs-theme-toggle[data-theme="dark"] [data-theme-icon="dark"]{display:block}.docs-theme-menu{position:absolute;top:calc(100% + 9px);right:0;z-index:40;width:222px;max-width:calc(100vw - 48px);padding:6px;border:1px solid var(--line,var(--edge,#d6e1e6));border-radius:13px;background:var(--panel,var(--paper,#fff));color:var(--ink,#18313f);box-shadow:0 14px 36px #00000024}.docs-theme-menu[hidden]{display:none!important}.docs-theme-menu-title{padding:8px 10px 7px;color:var(--muted,#526774);font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.docs-theme-option{display:grid;grid-template-columns:18px 1fr 16px;align-items:center;gap:10px;width:100%;margin:2px 0;padding:10px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;text-align:left;font:500 13px/1.5 system-ui,sans-serif;cursor:pointer}.docs-theme-option svg{width:18px;height:18px}.docs-theme-option .docs-theme-check{width:16px;height:16px;visibility:hidden}.docs-theme-option[aria-checked="true"]{color:var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));font-weight:750}.docs-theme-option[aria-checked="true"] .docs-theme-check{visibility:visible}.docs-theme-option:hover,.docs-theme-option:focus-visible{background:var(--soft,var(--bg,#00000006))}.docs-theme-toggle:focus-visible,.docs-theme-option:focus-visible{outline:3px solid var(--accent,var(--link,light-dark(#087f8c,#68cbd1)));outline-offset:3px}@media(max-width:1200px){.docs-topbar{flex-wrap:wrap}.docs-theme-picker{position:static}.docs-theme-menu{top:calc(100% + 9px);right:12px}.docs-topbar-links{order:3;flex-basis:100%;gap:4px;padding-top:10px;border-top:1px solid var(--line,var(--edge,#d6e1e6))}.docs-topbar-links a{flex:1;text-align:center}}@media(max-width:480px){.docs-topbar-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.docs-topbar{gap:10px;padding:12px;margin-bottom:24px}.docs-topbar-brand{gap:9px}.docs-topbar-mark{flex-basis:32px;width:32px;height:32px;border-radius:10px}.docs-topbar-kicker{display:none}.docs-theme-toggle{gap:7px;padding:8px 10px;font-size:12px}}@media print{.docs-topbar{display:none!important}:root{color-scheme:light!important}}`;

const icon = (body: string, attributes = "") =>
  `<svg ${attributes}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const automatic = '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>';
const light =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42m0-14.14-1.42 1.42M6.35 17.65l-1.42 1.42"/>';
const dark = '<path d="M20.9 13.1A9 9 0 0 1 10.9 3a9 9 0 1 0 10 10.1Z"/>';
const check = icon('<path d="m5 12 4 4L19 6"/>', 'class="docs-theme-check" ');

export const docsThemeControl = `<div class="docs-topbar"><div class="docs-topbar-brand"><span class="docs-topbar-mark" aria-hidden="true">J</span><span><span class="docs-topbar-name">Jungle</span><span class="docs-topbar-kicker">Wagering Processor · Docs</span></span></div><nav class="docs-topbar-links" aria-label="Documentação principal"><a class="docs-topbar-home" href="docs/load-report/index.html">Início</a><a href="README.md">README</a><a href="docs/architecture.html">Arquitetura</a><a href="docs/verification.md">Verificação</a></nav><div class="docs-theme-picker"><button id="docs-theme-toggle" class="docs-theme-toggle" type="button" aria-label="Escolher tema" aria-haspopup="menu" aria-expanded="false" aria-controls="docs-theme-menu" data-theme="auto">${icon(automatic, 'data-theme-icon="auto" ')}${icon(light, 'data-theme-icon="light" ')}${icon(dark, 'data-theme-icon="dark" ')}<span id="docs-theme-label">Automático</span>${icon('<path d="m7 10 5 5 5-5"/>', 'class="docs-theme-chevron" ')}</button><div id="docs-theme-menu" class="docs-theme-menu" role="menu" aria-label="Tema de aparência" hidden><div class="docs-theme-menu-title" role="presentation">Aparência</div><button class="docs-theme-option" type="button" role="menuitemradio" aria-checked="true" data-docs-theme-value="auto" tabindex="-1">${icon(automatic)}<span>Automático</span>${check}</button><button class="docs-theme-option" type="button" role="menuitemradio" aria-checked="false" data-docs-theme-value="light" tabindex="-1">${icon(light)}<span>Claro</span>${check}</button><button class="docs-theme-option" type="button" role="menuitemradio" aria-checked="false" data-docs-theme-value="dark" tabindex="-1">${icon(dark)}<span>Escuro</span>${check}</button></div></div></div>`;

/** Relative roots keep the same navigation working in HTTP and standalone HTML files. */
export function renderDocsTopbar(rootHref: "/" | "../" | "../../" | "../../../"): string {
  return docsThemeControl.replaceAll('href="', `href="${rootHref}`);
}

/** Constant, self-contained code: report data never enters this script or its CSP hash. */
export const docsThemeScriptSource = `(() => {
  const key = "wagering-docs-theme";
  const valid = value => value === "light" || value === "dark" || value === "auto";
  const labels = { auto: "Automático", light: "Claro", dark: "Escuro" };
  let preference = "auto";
  try {
    const stored = localStorage.getItem(key);
    if (valid(stored)) preference = stored;
  } catch {}
  const apply = value => {
    preference = valid(value) ? value : "auto";
    const palette = document.querySelector("style[data-docs-dark]");
    if (palette) palette.media = preference === "auto" ? "screen and (prefers-color-scheme: dark)" : preference === "dark" ? "screen" : "not all";
    document.documentElement.style.colorScheme = preference === "auto" ? "light dark" : preference;
  };
  apply(preference);
  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("docs-theme-toggle");
    const menu = document.getElementById("docs-theme-menu");
    const label = document.getElementById("docs-theme-label");
    if (!toggle || !menu || !label) return;
    const picker = toggle.parentElement;
    const items = [...menu.querySelectorAll("[data-docs-theme-value]")];
    const sync = () => {
      toggle.dataset.theme = preference;
      toggle.setAttribute("aria-label", "Escolher tema (atual: " + labels[preference] + ")");
      label.textContent = labels[preference];
      items.forEach(item => item.setAttribute("aria-checked", String(item.dataset.docsThemeValue === preference)));
    };
    const close = focus => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (focus) toggle.focus();
    };
    const open = index => {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      const selected = items.findIndex(item => item.dataset.docsThemeValue === preference);
      items[index === undefined ? Math.max(0, selected) : index].focus();
    };
    sync();
    toggle.addEventListener("click", () => menu.hidden ? open() : close(false));
    toggle.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      open(event.key === "ArrowDown" ? 0 : items.length - 1);
    });
    menu.addEventListener("keydown", event => {
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      items[next].focus();
    });
    items.forEach(item => item.addEventListener("click", () => {
      apply(item.dataset.docsThemeValue);
      sync();
      try { localStorage.setItem(key, preference); } catch {}
      close(true);
    }));
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || menu.hidden) return;
      event.preventDefault();
      close(true);
    });
    document.addEventListener("pointerdown", event => {
      if (!menu.hidden && !picker.contains(event.target)) close(false);
    });
    document.addEventListener("focusin", event => {
      if (!menu.hidden && !picker.contains(event.target)) close(false);
    });
  });
})();`;

export const docsThemeScript = `<script data-docs-theme>${docsThemeScriptSource}</script>`;
export const docsThemeCsp = `script-src 'sha256-${createHash("sha256").update(docsThemeScriptSource).digest("base64")}'`;
