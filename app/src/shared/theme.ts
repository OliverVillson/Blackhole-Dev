// The active theme's palette tokens as plain values, for code that needs colours outside CSS
// (canvas, xterm, modules via ctx.theme). Starts as Singularity; renderer/theme.ts updates it in
// place whenever the theme changes, so read it when drawing rather than copying it at import time.
// Every theme and its derived tokens live in ./themes.ts.
import { themeById, DEFAULT_THEME } from "./themes";

const TOKENS = ["void", "ash", "crimson", "redshift", "ember", "flare", "photon", "text", "dim", "bg1", "bg2", "line", "line2", "sel", "ok", "err"] as const;

export type ThemeToken = (typeof TOKENS)[number];

export const THEME: Record<ThemeToken, string> = pick(themeById(DEFAULT_THEME).vars);

export function pick(vars: Record<string, string>): Record<ThemeToken, string> {
  return Object.fromEntries(TOKENS.map((k) => [k, vars[k]])) as Record<ThemeToken, string>;
}
