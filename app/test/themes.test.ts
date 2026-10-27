// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { THEMES, DEFAULT_THEME, themeById } from "../src/shared/themes";
import { THEME } from "../src/shared/theme";
import { applyTheme, currentTheme, onTheme } from "../src/renderer/theme";
import { holePixels } from "../src/shared/hole";

// WCAG relative luminance and contrast ratio (alpha ignored: only opaque tokens are checked).
const lum = (c: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("themes", () => {
  const ref = Object.keys(themeById(DEFAULT_THEME).vars).sort();

  it("has unique ids, Singularity first and as the default", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(THEMES[0].id).toBe("singularity");
    expect(themeById("no-such-theme").id).toBe(DEFAULT_THEME);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s defines every token with a valid colour", (_, t) => {
    expect(Object.keys(t.vars).sort()).toEqual(ref);
    for (const [k, v] of Object.entries(t.vars)) {
      if (k === "syn-kw-weight") continue;
      expect(v, k).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
    expect(t.hole).toHaveLength(6);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s keeps text, buttons and code readable", (_, t) => {
    const v = t.vars;
    // Body text: our own themes clear 7:1 (Nightside is dim on purpose, about 8:1). The classic
    // schemes keep their published colours, which only promise WCAG AA (Solarized Light is 5:1).
    const body = t.group === "classic" ? 4.5 : 7;
    expect(contrast(v.text, v.void)).toBeGreaterThanOrEqual(body);
    expect(contrast(v.text, v.bg2)).toBeGreaterThanOrEqual(body - 1);
    expect(contrast(v.dim, v.bg2)).toBeGreaterThanOrEqual(3);
    // Primary buttons: label on accent.
    expect(contrast(v["on-accent"], v.ember)).toBeGreaterThanOrEqual(3.5);
    // Syntax colours and the status colours on the editor background.
    for (const k of ["syn-kw", "syn-str", "syn-num", "syn-fn", "syn-type", "syn-deco", "ok", "redshift"]) expect(contrast(v[k], v.void), k).toBeGreaterThanOrEqual(3);
    expect(contrast(v["syn-com"], v.void)).toBeGreaterThanOrEqual(2.2);
  });

  it("applies tokens, fonts and density to :root and tells listeners", () => {
    const seen: string[] = [];
    const off = onTheme((t) => seen.push(t.id));
    const t = applyTheme("albedo");
    const root = document.documentElement;
    expect(t.id).toBe("albedo");
    expect(currentTheme().id).toBe("albedo");
    expect(root.style.getPropertyValue("--void")).toBe(t.vars.void);
    expect(root.style.getPropertyValue("--syn-kw")).toBe(t.vars["syn-kw"]);
    expect(root.style.getPropertyValue("--code-size")).toBe("13.5px");
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("albedo");
    expect(THEME.void).toBe(t.vars.void);
    expect(localStorage.getItem("bh.theme")).toBe("albedo");
    applyTheme("unknown");
    expect(currentTheme().id).toBe(DEFAULT_THEME);
    expect(root.style.colorScheme).toBe("dark");
    off();
    applyTheme("dune");
    expect(seen).toEqual(["albedo", DEFAULT_THEME]);
  });

  it("marks the shadow in the hole art so light themes can paint it black", () => {
    const grid = holePixels(48);
    const flat = grid.flat();
    expect(flat.some((v) => v < 0)).toBe(true);
    expect(flat.some((v) => v === 6)).toBe(true);
    // The shadow sits in the middle of the art, ringed by lit pixels.
    const mid = grid[Math.floor(grid.length / 2)];
    expect(mid[24]).toBeLessThanOrEqual(0);
  });
});
