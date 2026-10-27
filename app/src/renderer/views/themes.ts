// Theme picker for Settings, and the "Theme: …" palette commands. Picking applies at once and
// saves "ui.theme" in settings.json; every theme comes from shared/themes.ts.

import { h, clear } from "../dom";
import { bh } from "../bridge";
import { applyTheme, currentTheme, onTheme, themes } from "../theme";
import type { Theme, ThemeGroup } from "../../shared/themes";

const GROUPS: [ThemeGroup, string][] = [
  ["blackhole", "BlackHole"],
  ["comfort", "Comfort and focus"],
  ["greyscale", "Greyscale"],
  ["beige", "Beige and red"],
  ["classic", "Classic schemes"],
  ["experimental", "Experimental"],
];

export async function setTheme(id: string): Promise<void> {
  const t = applyTheme(id);
  await bh.invoke("settings:set", "ui.theme", t.id);
}

function card(t: Theme): HTMLElement {
  const [bg, surface, accent, kw, str, fn] = t.swatch;
  const bar = (color: string, w: number) => h("i", { style: `background:${color};width:${w}%` });
  return h("button", {
    class: "thm" + (t.id === currentTheme().id ? " on" : ""),
    "data-theme-id": t.id,
    title: t.blurb,
    "aria-pressed": String(t.id === currentTheme().id),
    onclick: () => void setTheme(t.id),
  },
    h("span", { class: "thm-prev", style: `background:${bg};border-color:${surface}` },
      h("span", { class: "thm-line" }, bar(kw, 22), bar(fn, 40)),
      h("span", { class: "thm-line" }, bar(str, 58), h("b", { style: `background:${accent}` })),
      h("span", { class: "thm-line" }, bar(kw, 14), bar(str, 30))),
    h("span", { class: "thm-name" }, t.name, t.light ? h("span", { class: "meta" }, "light") : null));
}

/** The Settings section body: theme cards grouped by family, marked as the theme changes. */
export function themePicker(): HTMLElement {
  const el = h("div", { class: "themes-box" });
  const draw = () => {
    clear(el);
    for (const [g, label] of GROUPS) {
      const list = themes().filter((t) => t.group === g);
      if (!list.length) continue;
      el.append(h("div", { class: "meta thm-group" }, label), h("div", { class: "themes" }, ...list.map(card)));
    }
  };
  draw();
  const off = onTheme(() => (el.isConnected ? draw() : off()));
  return el;
}

/** Registers "Theme: <name>" for each theme so Cmd+Shift+P can switch. */
export function registerThemeCommands(cmd: (id: string, title: string, run: () => unknown) => void): void {
  for (const t of themes()) cmd(`theme.${t.id}`, `Theme: ${t.name}`, () => setTheme(t.id));
}
