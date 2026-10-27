// Colour themes. Each theme is a short spec (surfaces, text, accents, syntax, fonts, density);
// make() derives every token the app uses from it. Token names stay the ones the app has always
// used (--void, --ember, --flare ...) so modules keep working; their meaning is now semantic:
//   void   editor and page background      bg1   chrome (activity bar, tabs, panels)
//   bg2    side bars, modals                btn   buttons and menus
//   line   dividers                         line2 stronger dividers, tracks
//   edge   input borders                    ash   button borders, idle dots
//   sel    selected row                     crimson deep accent (meters, hover borders)
//   redshift errors                         ember primary accent (buttons, focus, live)
//   flare  secondary accent (links, notes)  photon brightest text
// Pure data: main reads it too (window background), the renderer applies it (renderer/theme.ts).

export type Density = "compact" | "regular" | "roomy";
export type ThemeGroup = "blackhole" | "comfort" | "greyscale" | "beige" | "classic";

interface Syntax { kw: string; str: string; num: string; com: string; fn: string; deco: string; punc: string; type?: string; key?: string; lit?: string; op?: string }

interface Spec {
  id: string;
  name: string;
  group: ThemeGroup;
  blurb: string;
  light?: boolean;
  bg: string; chrome: string; surface: string; surface2: string; sel: string;
  border: string; border2: string;
  text: string; textHi: string; dim: string;
  accent: string; onAccent: string; accent2: string; ok: string; bad: string;
  lineHl: string; gutter: string; gutterHi: string; caret?: string;
  syn: Syntax;
  /** Logo and hole art, darkest to brightest (5 steps), and the photon ring. Defaults to the accents. */
  mark?: string[]; ring?: string;
  /** Hole art, 6 steps dim to bright, when the mark ramp does not suit it (light greyscale). */
  hole?: string[];
  fonts?: { display: string; ui: string; mono: string };
  density?: Density;
  kwBold?: boolean;
}

export interface Theme {
  id: string;
  name: string;
  group: ThemeGroup;
  blurb: string;
  light: boolean;
  /** CSS custom properties without the leading "--". */
  vars: Record<string, string>;
  fonts: { display: string; ui: string; mono: string };
  density: Density;
  /** Monaco token colours and editor colours. */
  monaco: { rules: { token: string; foreground: string; fontStyle?: string }[]; colors: Record<string, string> };
  /** xterm colours. */
  terminal: Record<string, string>;
  /** Hole art palette, 6 steps dim to bright, and the colour behind the shadow (light themes paint it). */
  hole: string[];
  holeShadow: string | null;
  /** Swatches for the picker: background, surface, accent, then syntax kw, str, fn. */
  swatch: string[];
}

export const HEAT = ["#4a0d02", "#9e1b07", "#d7261e", "#ff6a00", "#ffae42", "#f5efe6"];

export const DENSITY: Record<Density, { ui: number; code: number; lh: number; row: number }> = {
  compact: { ui: 12.5, code: 12.5, lh: 19, row: 23 },
  regular: { ui: 13, code: 13, lh: 21, row: 26 },
  roomy: { ui: 13.5, code: 13.5, lh: 22, row: 28 },
};

const BRAND_FONTS = { display: "Chakra Petch", ui: "IBM Plex Sans", mono: "JetBrains Mono" };

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** Blend a toward b by t (0..1); both #rrggbb. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return "#" + x.map((v, i) => Math.round(v * (1 - t) + y[i] * t).toString(16).padStart(2, "0")).join("");
}
/** #rrggbb plus alpha as #rrggbbaa. */
export function alpha(c: string, a: number): string {
  return c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
}

function make(s: Spec): Theme {
  const light = !!s.light;
  const syn = { type: s.syn.deco, key: mix(s.syn.str, s.text, 0.35), lit: s.syn.num, op: s.syn.punc, ...s.syn };
  const mark = s.mark ?? (light ? HEAT.slice(1) : [mix(s.bg, s.accent, 0.3), mix(s.bg, s.accent, 0.65), s.accent, s.accent2, s.textHi]);
  const ring = s.ring ?? (light ? HEAT[5] : s.textHi);
  const err = light ? s.bad : mix(s.bad, s.textHi, 0.3);
  const caret = s.caret ?? s.accent;
  const vars: Record<string, string> = {
    void: s.bg, bg1: s.chrome, bg2: s.surface, btn: s.surface2, sel: s.sel,
    line: s.border, line2: mix(s.border, s.border2, 0.5), edge: s.border2, ash: mix(s.border2, s.dim, 0.3),
    crimson: mix(s.bg, s.accent, 0.55), redshift: s.bad, ember: s.accent, flare: s.accent2,
    photon: s.textHi, text: s.text, dim: s.dim,
    ok: s.ok, err, "on-accent": s.onAccent,
    hover: mix(s.surface, s.text, light ? 0.05 : 0.06),
    "tint-bg": mix(s.surface, s.accent, light ? 0.07 : 0.09),
    "bad-bg": mix(s.surface, s.bad, 0.14),
    "status-bg": s.chrome, "status-fg": s.dim, "status-line": s.border,
    ghost: s.dim, "copilot-line": alpha(s.accent, light ? 0.08 : 0.09), "user-line": alpha(s.textHi, light ? 0.05 : 0.04),
    "drop-bg": alpha(s.accent, 0.1), "drop-zone": alpha(s.accent, 0.16),
    overlay: alpha("#000000", light ? 0.28 : 0.6), shadow: light ? alpha("#000000", 0.18) : "#000000",
    "code-bg": light ? s.surface : mix(s.bg, "#000000", 0.4), "code-hd": mix(s.surface, s.accent, 0.05),
    "inline-bg": mix(s.surface, s.accent, 0.1), "inline-line": mix(s.surface, s.accent, 0.3), "inline-fg": light ? s.syn.str : s.accent2,
    glow: alpha(s.accent, 0.06), "accent-ring": alpha(s.accent, 0.25),
    "add-fg": light ? s.ok : mix(s.ok, s.textHi, 0.35), "add-bg": alpha(s.ok, 0.12), "del-fg": err, "del-bg": alpha(s.bad, 0.12),
    "line-hl": s.lineHl, gutter: s.gutter, "gutter-hi": s.gutterHi,
    "syn-text": s.text, "syn-kw": syn.kw, "syn-str": syn.str, "syn-key": syn.key, "syn-num": syn.num, "syn-lit": syn.lit,
    "syn-com": syn.com, "syn-fn": syn.fn, "syn-type": syn.type, "syn-deco": syn.deco, "syn-op": syn.op, "syn-punc": syn.punc,
    "syn-kw-weight": s.kwBold ? "600" : "500",
    "mark-0": mark[0], "mark-1": mark[1], "mark-2": mark[2], "mark-3": mark[3], "mark-4": mark[4], "mark-ring": ring,
  };
  const h = (c: string) => c.replace("#", "").slice(0, 6);
  const monaco = {
    rules: [
      { token: "", foreground: h(s.text) },
      { token: "keyword", foreground: h(syn.kw), ...(s.kwBold ? { fontStyle: "bold" } : {}) },
      { token: "string", foreground: h(syn.str) },
      { token: "string.escape", foreground: h(syn.num) },
      { token: "comment", foreground: h(syn.com), fontStyle: "italic" },
      { token: "number", foreground: h(syn.num) },
      { token: "tag", foreground: h(syn.deco) },
      { token: "delimiter", foreground: h(syn.punc) },
      { token: "type", foreground: h(syn.type) },
      { token: "identifier", foreground: h(s.text) },
    ],
    colors: {
      "editor.background": s.bg,
      "editor.foreground": s.text,
      "editorLineNumber.foreground": s.gutter,
      "editorLineNumber.activeForeground": s.gutterHi,
      "editor.lineHighlightBackground": s.lineHl,
      "editor.lineHighlightBorder": s.lineHl,
      // Selection and matches are strong on purpose: they have to pop on every theme.
      "editor.selectionBackground": alpha(s.accent, light ? 0.26 : 0.38),
      "editor.inactiveSelectionBackground": alpha(s.accent, light ? 0.14 : 0.2),
      "editor.selectionHighlightBackground": alpha(s.accent2, light ? 0.18 : 0.22),
      "editor.wordHighlightBackground": alpha(s.textHi, light ? 0.08 : 0.1),
      "editor.findMatchBackground": alpha(s.accent2, light ? 0.45 : 0.55),
      "editor.findMatchBorder": s.accent2,
      "editor.findMatchHighlightBackground": alpha(s.accent2, light ? 0.2 : 0.26),
      "editorBracketMatch.background": alpha(s.accent, 0.2),
      "editorBracketMatch.border": s.accent,
      "editorCursor.foreground": caret,
      "editorWidget.background": s.surface,
      "editorWidget.border": s.border2,
      "editorSuggestWidget.background": s.surface,
      "editorSuggestWidget.border": s.border2,
      "editorSuggestWidget.selectedBackground": s.sel,
      "editorSuggestWidget.highlightForeground": s.accent,
      "editorHoverWidget.background": s.surface,
      "editorHoverWidget.border": s.border2,
      "editorGutter.background": s.bg,
      "editorIndentGuide.background1": s.border,
      "editorIndentGuide.activeBackground1": s.border2,
      "editorStickyScroll.background": s.bg,
      "editorStickyScrollHover.background": s.lineHl,
      "scrollbarSlider.background": alpha(s.dim, 0.25),
      "scrollbarSlider.hoverBackground": alpha(s.dim, 0.4),
      "scrollbarSlider.activeBackground": alpha(s.dim, 0.55),
      "editorError.foreground": s.bad,
      "editorWarning.foreground": s.accent,
      "editorInfo.foreground": s.accent2,
      "editorGhostText.foreground": s.dim,
      "input.background": s.bg,
      "input.border": s.border2,
      "focusBorder": s.accent,
      "list.activeSelectionBackground": s.sel,
      "list.hoverBackground": mix(s.surface, s.text, 0.06),
      "list.highlightForeground": s.accent,
    } as Record<string, string>,
  };
  const ansi = light
    ? { yellow: "#9a6b00", blue: "#1f5fd6", magenta: "#a626a4", cyan: "#0e7c86" }
    : { yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2" };
  const terminal = {
    background: s.chrome, foreground: s.text, cursor: caret, cursorAccent: s.chrome,
    selectionBackground: alpha(s.accent, light ? 0.25 : 0.35),
    black: light ? s.text : s.surface2, red: s.bad, green: s.ok, yellow: ansi.yellow, blue: ansi.blue, magenta: ansi.magenta, cyan: ansi.cyan, white: light ? s.dim : s.text,
    brightBlack: s.dim, brightRed: err, brightGreen: s.ok, brightYellow: ansi.yellow, brightBlue: ansi.blue, brightMagenta: ansi.magenta, brightCyan: ansi.cyan, brightWhite: s.textHi,
  };
  return {
    id: s.id, name: s.name, group: s.group, blurb: s.blurb, light, vars,
    fonts: s.fonts ?? BRAND_FONTS, density: s.density ?? (light ? "roomy" : "regular"),
    monaco, terminal,
    hole: s.hole ?? (light ? HEAT : [mix(s.bg, mark[0], 0.6), ...mark]),
    holeShadow: light ? "#000000" : null,
    swatch: [s.bg, s.surface, s.accent, syn.kw, syn.str, syn.fn],
  };
}

const SPECS: Spec[] = [
  {
    id: "singularity", name: "Singularity", group: "blackhole",
    blurb: "Pure black and neutral greys. The heat ramp only on the mark, the hole art and anything live.",
    bg: "#000000", chrome: "#070707", surface: "#0b0b0b", surface2: "#141414", sel: "#1f1f1f",
    border: "#1b1b1b", border2: "#2b2b2b",
    text: "#d6d6d6", textHi: "#f5f5f5", dim: "#7b7b7b",
    accent: "#ff6a00", onAccent: "#140600", accent2: "#ffae42", ok: "#8fd694", bad: "#e8463d",
    lineHl: "#0e0e0e", gutter: "#3f3f3f", gutterHi: "#e6e6e6",
    syn: { kw: "#ff8a3d", str: "#f5d6a3", num: "#ffae42", com: "#5f5f5f", fn: "#ffffff", deco: "#e8463d", punc: "#8c8c8c", type: "#ffcf8a", key: "#ffb070" },
    mark: HEAT.slice(1), ring: HEAT[5],
  },
  {
    id: "event-horizon", name: "Event Horizon", group: "blackhole",
    blurb: "Graphite monochrome. No hue in the chrome; colour only where it means something.",
    bg: "#0c0d0f", chrome: "#0f1013", surface: "#131418", surface2: "#1a1c21", sel: "#23262d",
    border: "#202228", border2: "#30333b",
    text: "#c9ccd3", textHi: "#f4f5f7", dim: "#767b86",
    accent: "#eef0f3", onAccent: "#0c0d0f", accent2: "#aab4c4", ok: "#7fd19b", bad: "#e5534b",
    lineHl: "#15171b", gutter: "#40444d", gutterHi: "#d7dae0", caret: "#ffffff",
    syn: { kw: "#ffffff", str: "#a7b3c4", num: "#d6c7a4", com: "#5a5f69", fn: "#dfe3ea", deco: "#8f9aab", punc: "#8a8f99" },
    mark: ["#2a2d33", "#4d525c", "#8a909b", "#c8ccd3", "#ffffff"], ring: "#ffffff",
    fonts: { display: "Geist Sans", ui: "Geist Sans", mono: "Geist Mono" }, kwBold: true,
  },
  {
    id: "deep-field", name: "Deep Field", group: "blackhole",
    blurb: "Space navy with violet for actions and cyan for anything the copilot or a job is doing.",
    bg: "#070a14", chrome: "#090d1a", surface: "#0c1120", surface2: "#121a31", sel: "#1b2448",
    border: "#18203b", border2: "#26315a",
    text: "#c9d1ee", textHi: "#eef1ff", dim: "#6d79a3",
    accent: "#8b7cff", onAccent: "#0b0820", accent2: "#4cc9f0", ok: "#5ee0b0", bad: "#ff5d73",
    lineHl: "#0d1328", gutter: "#36406a", gutterHi: "#b9c3f0", caret: "#4cc9f0",
    syn: { kw: "#a796ff", str: "#62d6e8", num: "#f3a6ff", com: "#4a5582", fn: "#8fb5ff", deco: "#f3a6ff", punc: "#7f8ab4" },
    mark: ["#1d1650", "#4a37d6", "#8b7cff", "#4cc9f0", "#eaf6ff"], ring: "#eaf6ff",
    fonts: { display: "Sora", ui: "Sora", mono: "JetBrains Mono" },
  },
  {
    id: "lab-paper", name: "Lab Paper", group: "blackhole", light: true,
    blurb: "Light mode. Cool white, ink text and the brand red as the one accent; the hole stays black.",
    bg: "#ffffff", chrome: "#f3f4f7", surface: "#f7f8fa", surface2: "#eceef2", sel: "#e3e6ec",
    border: "#dfe2e8", border2: "#c9ced8",
    text: "#2a2e36", textHi: "#0f1115", dim: "#6a707c",
    accent: "#d7261e", onAccent: "#ffffff", accent2: "#1f5fd6", ok: "#1d8a4e", bad: "#c4211a",
    lineHl: "#f4f5f8", gutter: "#b4bac5", gutterHi: "#2a2e36",
    syn: { kw: "#b3170f", str: "#0b6e4f", num: "#7a3fb5", com: "#8d939e", fn: "#1f5fd6", deco: "#b3170f", punc: "#5b616d" },
    fonts: { display: "IBM Plex Sans", ui: "IBM Plex Sans", mono: "IBM Plex Mono" }, kwBold: true,
  },
  {
    id: "canopy", name: "Canopy", group: "comfort",
    blurb: "Deep moss green and sage text with one soft leaf green, for calm, long sessions.",
    bg: "#1a201c", chrome: "#161b18", surface: "#1d2420", surface2: "#26302a", sel: "#2f3c34",
    border: "#27312b", border2: "#36433b",
    text: "#d2dccf", textHi: "#eaf1e6", dim: "#8a9a8c",
    accent: "#8fcf9f", onAccent: "#0f1a13", accent2: "#d6c38a", ok: "#9ad48a", bad: "#e07a6e",
    lineHl: "#202822", gutter: "#4d5a50", gutterHi: "#d2dccf",
    syn: { kw: "#8fcf9f", str: "#d6c38a", num: "#e3a77a", com: "#6b7c6e", fn: "#a9d4e0", deco: "#b9a6d6", punc: "#9aa89b" },
  },
  {
    id: "blueshift", name: "Blueshift", group: "comfort",
    blurb: "Slate blue for hard, detailed work; off-white text, no pure black.",
    bg: "#1b2130", chrome: "#171c29", surface: "#1e2535", surface2: "#273045", sel: "#2f3b57",
    border: "#283147", border2: "#36415c",
    text: "#d5dcea", textHi: "#edf1f8", dim: "#8892aa",
    accent: "#6ea8ff", onAccent: "#0b1426", accent2: "#7fd4e6", ok: "#7fd49a", bad: "#f07a7a",
    lineHl: "#212839", gutter: "#4a5470", gutterHi: "#d5dcea",
    syn: { kw: "#8fb4ff", str: "#9fd8c4", num: "#f2c38b", com: "#626e8a", fn: "#e6ecf7", deco: "#c5a8f0", punc: "#8f9ab3" },
  },
  {
    id: "tranquility", name: "Tranquility", group: "comfort", light: true,
    blurb: "Pale grey-green paper with a quiet teal accent, for bright rooms and long reading.",
    bg: "#eef2f1", chrome: "#e3e8e7", surface: "#e8edec", surface2: "#dbe2e1", sel: "#cfdcdc",
    border: "#d6dedd", border2: "#bccacb",
    text: "#23302f", textHi: "#0f1a1a", dim: "#5f706f",
    accent: "#1f6f8b", onAccent: "#f2f8f8", accent2: "#3c8a5c", ok: "#2e7d4f", bad: "#b3362c",
    lineHl: "#e5ebea", gutter: "#9fb0af", gutterHi: "#23302f",
    syn: { kw: "#1f5f8b", str: "#2f7a4f", num: "#9a5a1f", com: "#829190", fn: "#6a3fa0", deco: "#b3362c", punc: "#4d5d5c" },
    mark: ["#a9c2c6", "#5f98a8", "#1f6f8b", "#0f4f66", "#ffffff"], ring: "#ffffff",
    hole: ["#bccacb", "#8fb0b5", "#5f98a8", "#1f6f8b", "#0f4f66", "#ffffff"], kwBold: true,
  },
  {
    id: "nightside", name: "Nightside", group: "comfort",
    blurb: "Everything dim for late nights: soft grey text, muted lavender and sage.",
    bg: "#141516", chrome: "#111213", surface: "#17181a", surface2: "#1f2023", sel: "#2a2b30",
    border: "#222326", border2: "#2f3034",
    text: "#a8acb2", textHi: "#c4c7cc", dim: "#6f737a",
    accent: "#9b95c9", onAccent: "#141516", accent2: "#8fb3a8", ok: "#7fb08f", bad: "#c97a74",
    lineHl: "#18191b", gutter: "#3d3f44", gutterHi: "#a8acb2",
    syn: { kw: "#a6a0d4", str: "#9fbfa7", num: "#c9ad86", com: "#565a60", fn: "#c4c7cc", deco: "#b28fa8", punc: "#7d8188" },
  },
  {
    id: "umbra", name: "Umbra", group: "greyscale",
    blurb: "Dark grey. Greys everywhere; green and red only on state.",
    bg: "#1c1d1f", chrome: "#17181a", surface: "#202124", surface2: "#2a2b2f", sel: "#36383d",
    border: "#2c2d31", border2: "#3c3e43",
    text: "#cfd0d3", textHi: "#f2f2f3", dim: "#85878d",
    accent: "#e6e7e9", onAccent: "#1c1d1f", accent2: "#a9abb0", ok: "#4ec27a", bad: "#e5534b",
    lineHl: "#232427", gutter: "#4c4e54", gutterHi: "#e0e1e3", caret: "#ffffff",
    syn: { kw: "#ffffff", str: "#b8babf", num: "#d0d1d4", com: "#6c6e74", fn: "#e9eaec", deco: "#9a9ca2", punc: "#8d8f95" },
    mark: ["#2a2b2f", "#4a4c52", "#85878d", "#c4c6ca", "#ffffff"], ring: "#ffffff", kwBold: true,
  },
  {
    id: "albedo", name: "Albedo", group: "greyscale", light: true,
    blurb: "Light grey with near-black ink. The hole stays a black disc with a white ring.",
    bg: "#e6e7e9", chrome: "#dcdde0", surface: "#e0e1e4", surface2: "#d3d5d8", sel: "#c8cacf",
    border: "#cfd1d5", border2: "#b9bcc1",
    text: "#2b2d31", textHi: "#0e0f11", dim: "#6a6d73",
    accent: "#1d1f22", onAccent: "#f2f2f3", accent2: "#4a4d52", ok: "#1e8a4c", bad: "#c4291f",
    lineHl: "#dfe0e3", gutter: "#9a9da3", gutterHi: "#2b2d31", caret: "#0e0f11",
    syn: { kw: "#0e0f11", str: "#4f5258", num: "#34363b", com: "#8a8d93", fn: "#1d1f22", deco: "#5d6066", punc: "#55585e" },
    mark: ["#9a9da3", "#6a6d73", "#3a3c40", "#1d1f22", "#ffffff"], ring: "#ffffff",
    hole: ["#c4c6ca", "#9a9da3", "#6a6d73", "#3a3c40", "#1d1f22", "#ffffff"], kwBold: true,
  },
  {
    id: "redshift", name: "Redshift", group: "beige", light: true,
    blurb: "Full-strength sand beige with signal red and dark brown-black ink.",
    bg: "#e8d5ae", chrome: "#dcc596", surface: "#e1cca2", surface2: "#d3ba88", sel: "#cdb07a",
    border: "#cdb585", border2: "#b89c68",
    text: "#2a1d14", textHi: "#120b06", dim: "#7a6346",
    accent: "#c8102e", onAccent: "#fff4e0", accent2: "#8a1c14", ok: "#2f7d32", bad: "#a3000f",
    lineHl: "#e2cda3", gutter: "#a8916b", gutterHi: "#2a1d14", caret: "#c8102e",
    syn: { kw: "#b0101f", str: "#3f6b2a", num: "#8a3b12", com: "#957c58", fn: "#7a1712", deco: "#b0101f", punc: "#5a4630" }, kwBold: true,
  },
  {
    id: "dune", name: "Dune", group: "beige", light: true,
    blurb: "Saturated camel across the whole window, oxblood red, navy function names.",
    bg: "#cfb07a", chrome: "#c3a26a", surface: "#c8a872", surface2: "#b8975f", sel: "#b08c52",
    border: "#b9995f", border2: "#a3834c",
    text: "#22170d", textHi: "#0d0804", dim: "#5e4728",
    accent: "#8e0f16", onAccent: "#f6e7c8", accent2: "#b5291c", ok: "#2d5f1e", bad: "#8e0f16",
    lineHl: "#c9a973", gutter: "#8a6d40", gutterHi: "#22170d", caret: "#8e0f16",
    syn: { kw: "#8e0f16", str: "#2f4f1a", num: "#7b2a0c", com: "#75592f", fn: "#14305e", deco: "#8e0f16", punc: "#4a3720" }, kwBold: true,
  },
  {
    id: "spyder-dark", name: "Spyder Dark", group: "classic",
    blurb: "Spyder's default dark scheme on its blue-grey chrome.",
    bg: "#19232d", chrome: "#141c24", surface: "#1c2731", surface2: "#263240", sel: "#23415e",
    border: "#2a3846", border2: "#3a4a5b",
    text: "#e0e1e3", textHi: "#ffffff", dim: "#8c9aa8",
    accent: "#259ae9", onAccent: "#04111c", accent2: "#57d6e4", ok: "#b0e686", bad: "#ee6772",
    lineHl: "#2b2b43", gutter: "#56677a", gutterHi: "#e0e1e3", caret: "#ffffff",
    syn: { kw: "#c670e0", str: "#b0e686", num: "#faed5c", com: "#999999", fn: "#57d6e4", deco: "#fab16c", punc: "#c0c5cc" },
  },
  {
    id: "spyder", name: "Spyder", group: "classic", light: true,
    blurb: "Spyder's classic light scheme with its violet current line.",
    bg: "#ffffff", chrome: "#f1f2f4", surface: "#f7f8f9", surface2: "#eaecef", sel: "#dbe6f5",
    border: "#dcdfe4", border2: "#c6cad1",
    text: "#1e1f22", textHi: "#000000", dim: "#6b6f76",
    accent: "#1a72bb", onAccent: "#ffffff", accent2: "#924900", ok: "#1f8a1f", bad: "#c4211a",
    lineHl: "#f7ecf8", gutter: "#a9adb4", gutterHi: "#1e1f22", caret: "#000000",
    syn: { kw: "#0000ff", str: "#00aa00", num: "#800000", com: "#adadad", fn: "#000000", deco: "#900090", punc: "#444444" },
  },
  {
    id: "monokai", name: "Monokai", group: "classic",
    blurb: "Olive-black, hot pink keywords, yellow strings, green functions.",
    bg: "#272822", chrome: "#1e1f1c", surface: "#23241f", surface2: "#3e3d32", sel: "#49483e",
    border: "#34352f", border2: "#4e4f47",
    text: "#f8f8f2", textHi: "#ffffff", dim: "#90908a",
    accent: "#f92672", onAccent: "#ffffff", accent2: "#66d9ef", ok: "#a6e22e", bad: "#f92672",
    lineHl: "#3e3d32", gutter: "#75715e", gutterHi: "#f8f8f2", caret: "#f8f8f0",
    syn: { kw: "#f92672", str: "#e6db74", num: "#ae81ff", com: "#75715e", fn: "#a6e22e", deco: "#66d9ef", punc: "#f8f8f2" },
  },
  {
    id: "solarized-light", name: "Solarized Light", group: "classic", light: true,
    blurb: "Solarized on parchment, accents a shade darker so they clear 3:1.",
    bg: "#fdf6e3", chrome: "#eee8d5", surface: "#f6efdb", surface2: "#eee8d5", sel: "#e4dcc4",
    border: "#e2dbc5", border2: "#d3cbb3",
    text: "#586e75", textHi: "#073642", dim: "#657b83",
    accent: "#268bd2", onAccent: "#ffffff", accent2: "#1f8a82", ok: "#738500", bad: "#dc322f",
    lineHl: "#eee8d5", gutter: "#93a1a1", gutterHi: "#586e75", caret: "#073642",
    syn: { kw: "#738500", str: "#1f8a82", num: "#d33682", com: "#93a1a1", fn: "#268bd2", deco: "#cb4b16", punc: "#657b83", type: "#9a7500" },
  },
  {
    id: "dracula", name: "Dracula", group: "classic",
    blurb: "Purple-grey with pink keywords and green functions.",
    bg: "#282a36", chrome: "#21222c", surface: "#252632", surface2: "#343746", sel: "#44475a",
    border: "#303241", border2: "#44475a",
    text: "#f8f8f2", textHi: "#ffffff", dim: "#7e88b3",
    accent: "#bd93f9", onAccent: "#1b1530", accent2: "#8be9fd", ok: "#50fa7b", bad: "#ff5555",
    lineHl: "#2f3142", gutter: "#6272a4", gutterHi: "#f8f8f2", caret: "#f8f8f2",
    syn: { kw: "#ff79c6", str: "#f1fa8c", num: "#bd93f9", com: "#6272a4", fn: "#50fa7b", deco: "#8be9fd", punc: "#f8f8f2" },
  },
  {
    id: "gruvbox-dark", name: "Gruvbox Dark", group: "classic",
    blurb: "Retro and warm by design: red keywords, yellow functions, aqua accents.",
    bg: "#282828", chrome: "#1d2021", surface: "#242424", surface2: "#3c3836", sel: "#504945",
    border: "#3c3836", border2: "#504945",
    text: "#ebdbb2", textHi: "#fbf1c7", dim: "#a89984",
    accent: "#fabd2f", onAccent: "#1d2021", accent2: "#8ec07c", ok: "#b8bb26", bad: "#fb4934",
    lineHl: "#32302f", gutter: "#7c6f64", gutterHi: "#ebdbb2", caret: "#ebdbb2",
    syn: { kw: "#fb4934", str: "#b8bb26", num: "#d3869b", com: "#928374", fn: "#fabd2f", deco: "#8ec07c", punc: "#bdae93", type: "#83a598" },
  },
  {
    id: "tokyo-night", name: "Tokyo Night", group: "classic",
    blurb: "Night-city navy with soft blue functions and violet keywords.",
    bg: "#1a1b26", chrome: "#16161e", surface: "#1b1c28", surface2: "#24283b", sel: "#283457",
    border: "#232433", border2: "#3b4261",
    text: "#c0caf5", textHi: "#e3e8ff", dim: "#737aa2",
    accent: "#7aa2f7", onAccent: "#11131c", accent2: "#7dcfff", ok: "#9ece6a", bad: "#f7768e",
    lineHl: "#1e2030", gutter: "#3b4261", gutterHi: "#c0caf5",
    syn: { kw: "#bb9af7", str: "#9ece6a", num: "#ff9e64", com: "#565f89", fn: "#7aa2f7", deco: "#2ac3de", punc: "#89ddff", type: "#2ac3de" },
  },
  {
    id: "one-dark", name: "One Dark", group: "classic",
    blurb: "Atom's charcoal blue-grey with purple keywords and blue functions.",
    bg: "#282c34", chrome: "#1e2227", surface: "#21252b", surface2: "#2c313a", sel: "#3e4451",
    border: "#2f343d", border2: "#3e4451",
    text: "#abb2bf", textHi: "#e6e6e6", dim: "#7f848e",
    accent: "#61afef", onAccent: "#0f1720", accent2: "#56b6c2", ok: "#98c379", bad: "#e06c75",
    lineHl: "#2c313c", gutter: "#4b5263", gutterHi: "#abb2bf", caret: "#528bff",
    syn: { kw: "#c678dd", str: "#98c379", num: "#d19a66", com: "#5c6370", fn: "#61afef", deco: "#e5c07b", punc: "#abb2bf" },
  },
  {
    id: "catppuccin-mocha", name: "Catppuccin Mocha", group: "classic",
    blurb: "Soft pastels on dark indigo.",
    bg: "#1e1e2e", chrome: "#181825", surface: "#1a1a29", surface2: "#313244", sel: "#45475a",
    border: "#2a2b3c", border2: "#45475a",
    text: "#cdd6f4", textHi: "#eef1ff", dim: "#9399b2",
    accent: "#cba6f7", onAccent: "#1e1e2e", accent2: "#89dceb", ok: "#a6e3a1", bad: "#f38ba8",
    lineHl: "#252536", gutter: "#585b70", gutterHi: "#cdd6f4", caret: "#f5e0dc",
    syn: { kw: "#cba6f7", str: "#a6e3a1", num: "#fab387", com: "#6c7086", fn: "#89b4fa", deco: "#f9e2af", punc: "#9399b2" },
  },
];

export const THEMES: Theme[] = SPECS.map(make);
export const DEFAULT_THEME = "singularity";

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}
