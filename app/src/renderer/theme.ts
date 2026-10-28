// Applies a theme from shared/themes.ts: CSS custom properties on :root, fonts and density, the
// live THEME values, then a "bh:theme" window event so Monaco, xterm and the hole art repaint.
// The id is cached in localStorage so the next launch (and the gate window) paints the right
// colours before the settings round trip; settings.json ("ui.theme") stays the source of truth.

import { THEMES, themeById, type Theme } from "../shared/themes";
import { THEME, pick } from "../shared/theme";

const CACHE = "bh.theme";
let current: Theme = themeById(cachedThemeId());

export function cachedThemeId(): string | null {
  try {
    return localStorage.getItem(CACHE);
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return current;
}

export function themes(): Theme[] {
  return THEMES;
}

const family = (name: string, fallback: string) => `"${name}", ${fallback}`;

export function applyTheme(id: string | null | undefined): Theme {
  const t = themeById(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(`--${k}`, v);
  const d = t.metrics;
  root.style.setProperty("--font-display", family(t.fonts.display, "system-ui, sans-serif"));
  root.style.setProperty("--font-ui", family(t.fonts.ui, "system-ui, sans-serif"));
  root.style.setProperty("--font-mono", family(t.fonts.mono, "ui-monospace, Menlo, monospace"));
  root.style.setProperty("--ui-size", `${d.ui}px`);
  root.style.setProperty("--code-size", `${d.code}px`);
  root.style.setProperty("--code-lh", `${d.lh}px`);
  root.style.setProperty("--row-h", `${d.row}px`);
  root.style.colorScheme = t.light ? "light" : "dark";
  root.dataset.theme = t.id;
  let fx = document.getElementById("bh-theme-fx");
  if (!fx && t.fx) {
    fx = document.createElement("style");
    fx.id = "bh-theme-fx";
    document.head.append(fx);
  }
  if (fx) fx.textContent = t.fx;
  Object.assign(THEME, pick(t.vars));
  try {
    localStorage.setItem(CACHE, t.id);
  } catch {
    /* private storage off: the setting still applies on boot */
  }
  current = t;
  window.dispatchEvent(new CustomEvent<Theme>("bh:theme", { detail: t }));
  return t;
}

/** Calls cb on every theme change; returns the unsubscribe. */
export function onTheme(cb: (t: Theme) => void): () => void {
  const fn = (e: Event) => cb((e as CustomEvent<Theme>).detail);
  window.addEventListener("bh:theme", fn);
  return () => window.removeEventListener("bh:theme", fn);
}

/** Monaco and xterm measure glyphs once; call after a font change once the faces are in. */
export function fontsReady(t: Theme): Promise<void> {
  const d = t.metrics;
  const faces = [`400 ${d.code}px "${t.fonts.mono}"`, `400 ${d.ui}px "${t.fonts.ui}"`, `500 11px "${t.fonts.display}"`];
  return Promise.all(faces.map((f) => document.fonts?.load(f).catch(() => undefined))).then(() => undefined);
}
