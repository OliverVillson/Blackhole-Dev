// More themes, kept apart from themes.ts because beyond colours and fonts most carry effect CSS
// ("&" is the theme's root selector) for glow, scanlines, grain, glass and the like; Dark Matter
// also dims the editor away from the cursor (Spec.focus). They join the regular groups (THEMES
// orders them by group). Fonts: renderer/fonts-lab.ts.

import type { Spec } from "./themes";

const GRAIN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .6 0"/></filter><rect width="180" height="180" filter="url(#n)"/></svg>')}")`;
/** A full-window layer over the app for scanlines, grain and the like. */
const OVER = "& body::after { content: \"\"; position: fixed; inset: 0; pointer-events: none; z-index: 40;";
const SYNTAX = "& .monaco-editor .view-line span[class^=\"mtk\"]:not(.mtk1)";
const GRID = "linear-gradient(rgba(255,255,255,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.09) 1px, transparent 1px), linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px)";
const SEL_ROWS = "& .rc.sel, & .it.sel";
const SEL_TEXT = (c: string) => `${SEL_ROWS} { color: ${c}; box-shadow: none; } & .rc.sel *, & .it.sel * { color: ${c} !important; }`;

export const LAB: Spec[] = [
  {
    id: "white-hole", name: "White Hole", group: "greyscale", light: true,
    blurb: "Strictly 1-bit black and white; syntax by weight, slant and underline. The mark inverts.",
    bg: "#ffffff", chrome: "#ffffff", surface: "#ffffff", surface2: "#ffffff", sel: "#000000",
    border: "#000000", border2: "#000000",
    text: "#000000", textHi: "#000000", dim: "#000000",
    accent: "#000000", onAccent: "#ffffff", accent2: "#000000", ok: "#000000", bad: "#000000",
    lineHl: "#ffffff", gutter: "#000000", gutterHi: "#000000", caret: "#000000",
    syn: { kw: "#000000", str: "#000000", num: "#000000", com: "#000000", fn: "#000000", deco: "#000000", punc: "#000000" },
    styles: { kw: "bold", str: "underline", deco: "bold italic" },
    mark: ["#000000", "#000000", "#000000", "#000000", "#000000"], ring: "#000000",
    hole: ["#000000", "#000000", "#000000", "#000000", "#000000", "#000000"], holeShadow: "#ffffff",
    vars: { "status-bg": "#000000", "status-fg": "#ffffff", "status-line": "#000000", "tint-bg": "#ffffff", hover: "#ffffff", "line2": "#000000", ash: "#000000", edge: "#000000" },
    editor: Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`editorBracketHighlight.foreground${i}`, "#000000"])),
    fonts: { display: "DotGothic16", ui: "Anonymous Pro", mono: "Anonymous Pro" }, metrics: { ui: 13, code: 14, lh: 21, row: 26 },
    fx: `& .titlebar { background: repeating-linear-gradient(180deg, #000 0 1px, #fff 1px 3px); }
      & .brand, & .titlebar .chip, & .search button { background: #fff; } & .brand { padding: 2px 10px; }
      & .brand svg circle[r="3.72"] { fill: #fff; }
      ${SEL_TEXT("#fff")}
      & .monaco-editor .view-overlays .current-line { box-shadow: inset 0 0 0 1px #000; }
      & .dot:not(.ok):not(.live) { background: #fff; box-shadow: inset 0 0 0 1.5px #000; } & .status .dot { background: #fff; }
      & .btn, & .card, & .chip { box-shadow: 2px 2px 0 #000; }
      & .activity { background-image: radial-gradient(#000 .8px, transparent 1px); background-size: 4px 4px; }
      & .ab { background: #fff; } & .ab.on { background: #000; color: #fff; box-shadow: none; }
      & .bh-ghost { color: transparent; -webkit-text-stroke: .6px #000; opacity: 1; }`,
  },
  {
    id: "hawking-radiation", name: "Hawking Radiation", group: "blackhole",
    blurb: "Amber CRT: one hue, phosphor glow on every letter, scanlines and a curved-glass vignette.",
    bg: "#0c0700", chrome: "#110a00", surface: "#140c01", surface2: "#1f1404", sel: "#3a2606",
    border: "#2a1c05", border2: "#4a3209",
    text: "#ffbf47", textHi: "#ffd98a", dim: "#9a6a1c",
    accent: "#ffb000", onAccent: "#1a0e00", accent2: "#ffe1a0", ok: "#b5e655", bad: "#ff5a36",
    lineHl: "#1a1003", gutter: "#5a3e10", gutterHi: "#ffd98a", caret: "#ffb000",
    syn: { kw: "#ffcf5c", str: "#ffe7b0", num: "#ff9a1f", com: "#7a5418", fn: "#fff1cc", deco: "#ff9a1f", punc: "#b98330" },
    mark: ["#3a2606", "#9a6a1c", "#ffb000", "#ffd98a", "#fff1cc"], ring: "#ffd98a",
    fonts: { display: "VT323", ui: "Share Tech Mono", mono: "IBM Plex Mono" }, density: "compact", kwBold: true,
    fx: `& #app { text-shadow: 0 0 5px rgba(255,176,0,.45); }
      & .brand b { font-size: 20px; font-weight: 400; } & .hd { font-size: 15px; }
      ${OVER} background: radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,.6) 100%), repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,.22) 2px 3px); }`,
  },
  {
    id: "blueprint", name: "Blueprint", group: "blackhole",
    blurb: "Engineering drawing: Prussian blue, white line work, a drafting grid, hand-lettered headings.",
    bg: "#0f3b84", chrome: "#0c3272", surface: "#0e367a", surface2: "#144594", sel: "#1d55ad",
    border: "#3f6bb3", border2: "#6f93cc",
    text: "#e8f0ff", textHi: "#ffffff", dim: "#a9c0e8",
    accent: "#ffffff", onAccent: "#0f3b84", accent2: "#ffd84a", ok: "#8affc1", bad: "#ff8a8a",
    lineHl: "#123f8c", gutter: "#7f9fd4", gutterHi: "#ffffff", caret: "#ffd84a",
    syn: { kw: "#ffffff", str: "#bfe0ff", num: "#ffd84a", com: "#8eaadb", fn: "#9ff0ff", deco: "#ffb3c7", punc: "#c4d5f2" },
    mark: ["#1d55ad", "#6f93cc", "#bfe0ff", "#ffffff", "#ffffff"], ring: "#ffd84a",
    fonts: { display: "Architects Daughter", ui: "Barlow", mono: "Overpass Mono" }, kwBold: true,
    fx: `& .monaco-editor .monaco-editor-background, & .sidebar, & .right, & .panel { background-image: ${GRID}; background-size: 40px 40px, 40px 40px, 8px 8px, 8px 8px; }
      & .btn, & input, & .chip, & .card, & textarea, & .search button { border-style: dashed; border-radius: 0; }
      & .brand b { font-weight: 400; letter-spacing: .06em; } & .hd { font-size: 13px; letter-spacing: .06em; }
      & .tab.on { box-shadow: inset 0 2px 0 #ffd84a; }
      & .monaco-editor .view-overlays .current-line { outline: 1px dashed rgba(255,216,74,.7); outline-offset: -1px; }`,
  },
  {
    id: "concrete", name: "Concrete", group: "blackhole", light: true,
    blurb: "Neo-brutalist: hard black borders and offset shadows, safety yellow, square corners.",
    bg: "#f2f2ef", chrome: "#e4e4df", surface: "#ebebe7", surface2: "#ffffff", sel: "#ffe600",
    border: "#111111", border2: "#111111",
    text: "#111111", textHi: "#000000", dim: "#55554f",
    accent: "#ffe600", onAccent: "#000000", accent2: "#ff3d00", ok: "#0a8f3c", bad: "#e00000",
    lineHl: "#e6e6e0", gutter: "#8a8a82", gutterHi: "#111111", caret: "#111111",
    syn: { kw: "#000000", str: "#0040dd", num: "#c4003c", com: "#77776f", fn: "#a83200", deco: "#7000c4", punc: "#33332f" },
    mark: ["#111111", "#ff3d00", "#ffe600", "#ffe600", "#ffffff"], ring: "#111111",
    vars: { "status-bg": "#111111", "status-fg": "#f2f2ef", "status-line": "#111111" },
    fonts: { display: "Archivo Black", ui: "Archivo", mono: "DM Mono" }, density: "regular", kwBold: true,
    fx: `& .titlebar, & .tabs, & .panel, & .sidebar, & .right, & .activity, & .status, & .crumbs, & .right-tabs { border-width: 2px; border-color: #111; }
      & .btn, & .chip, & input, & .card, & textarea, & .search button { border: 2px solid #111; box-shadow: 3px 3px 0 #111; border-radius: 0; }
      & .tab { font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }
      & .tab.on { box-shadow: inset 0 -4px 0 #ffe600; background: #fff; }
      & .hd { color: #111; letter-spacing: .06em; } & .brand b { font-weight: 400; } & .brand b span { color: #ff3d00; }
      ${SEL_ROWS} { font-weight: 700; box-shadow: none; }
      & .ab.on { color: #000; box-shadow: inset 4px 0 0 #ffe600; } & .crumbs .live, & .tone-warn { color: #a83200; font-weight: 700; }`,
  },
  {
    id: "overprint", name: "Overprint", group: "blackhole", light: true,
    blurb: "Risograph duotone: pink and blue inks slightly out of register, paper grain.",
    bg: "#f5f2ec", chrome: "#ece8df", surface: "#efebe3", surface2: "#e4dfd4", sel: "#ffd6ea",
    border: "#d9d3c6", border2: "#a9b4dc",
    text: "#1f3a8a", textHi: "#142a6b", dim: "#56669f",
    accent: "#ff48b0", onAccent: "#142a6b", accent2: "#c2127a", ok: "#00838a", bad: "#e8202e",
    lineHl: "#f9e6ee", gutter: "#a3acd0", gutterHi: "#1f3a8a", caret: "#ff48b0",
    syn: { kw: "#e0157f", str: "#1f3a8a", num: "#6b2fa0", com: "#8a93b8", fn: "#142a6b", deco: "#e0157f", punc: "#4a5a90" },
    mark: ["#1f3a8a", "#6b2fa0", "#ff48b0", "#ff9ad2", "#f5f2ec"], ring: "#1f3a8a",
    vars: { "status-bg": "#1f3a8a", "status-fg": "#f5f2ec", "status-line": "#1f3a8a" },
    fonts: { display: "Bricolage Grotesque", ui: "Bricolage Grotesque", mono: "Spline Sans Mono" }, density: "regular", kwBold: true,
    fx: `& .brand b, & .hd, & .ptab.on, & .tab.on { text-shadow: 1.5px 1px 0 rgba(255,72,176,.75); }
      & .tabs, & .panel-tabs { background-image: radial-gradient(rgba(255,72,176,.28) 1px, transparent 1.4px); background-size: 4px 4px; }
      & .btn.pri { box-shadow: 2px 1.5px 0 #1f3a8a; }
      ${OVER} background-image: ${GRAIN}; opacity: .16; mix-blend-mode: multiply; }`,
  },
  {
    id: "ultraviolet", name: "Ultraviolet", group: "blackhole",
    blurb: "Blacklight poster: fluorescent chartreuse, pink and cyan that glow.",
    bg: "#0d0020", chrome: "#12002c", surface: "#110028", surface2: "#1d0442", sel: "#33066e",
    border: "#250952", border2: "#3e0f80",
    text: "#efe0ff", textHi: "#ffffff", dim: "#9a7fd0",
    accent: "#c6ff00", onAccent: "#0d0020", accent2: "#ff3df2", ok: "#39ff88", bad: "#ff3d6e",
    lineHl: "#170036", gutter: "#4d2a8a", gutterHi: "#c6ff00", caret: "#c6ff00",
    syn: { kw: "#ff3df2", str: "#c6ff00", num: "#ff9a00", com: "#6a4fa8", fn: "#00e5ff", deco: "#ffe600", punc: "#b49ae6" },
    mark: ["#33066e", "#ff3df2", "#c6ff00", "#00e5ff", "#ffffff"], ring: "#c6ff00",
    fonts: { display: "Syne", ui: "Syne", mono: "Red Hat Mono" }, kwBold: true,
    fx: `${SYNTAX} { text-shadow: 0 0 7px currentColor; }
      & .brand b { text-shadow: 0 0 10px rgba(198,255,0,.7); } & .brand b span { color: #ff3df2; }
      & .btn.pri { box-shadow: 0 0 14px rgba(198,255,0,.55); }
      & .tab.on { box-shadow: inset 0 2px 0 #ff3df2, 0 0 12px rgba(255,61,242,.3); }
      & .dot.ok { box-shadow: 0 0 6px #39ff88; } & .dot.bad { box-shadow: 0 0 6px #ff3d6e; }
      ${OVER} background: radial-gradient(ellipse at 50% 120%, rgba(130,0,255,.24), transparent 60%); mix-blend-mode: screen; }`,
  },
  {
    id: "broadsheet", name: "Broadsheet", group: "beige", light: true,
    blurb: "Newspaper: serif headlines and UI, typewriter code, double rules, one red spot colour.",
    bg: "#f6f5f0", chrome: "#ebe9e2", surface: "#efede7", surface2: "#e4e1d8", sel: "#dcd8cc",
    border: "#cbc7bb", border2: "#1a1a1a",
    text: "#1a1a1a", textHi: "#000000", dim: "#625e55",
    accent: "#c8102e", onAccent: "#ffffff", accent2: "#1d4e89", ok: "#2e6b30", bad: "#c8102e",
    lineHl: "#edebe4", gutter: "#a8a498", gutterHi: "#1a1a1a", caret: "#c8102e",
    syn: { kw: "#111111", str: "#2b5b3a", num: "#c8102e", com: "#8a857a", fn: "#1d4e89", deco: "#c8102e", punc: "#555048" },
    mark: ["#3a3832", "#6b675d", "#c8102e", "#e8667a", "#f6f5f0"], ring: "#1a1a1a",
    vars: { "status-bg": "#f6f5f0", "status-fg": "#4a463e", "status-line": "#1a1a1a" },
    fonts: { display: "Instrument Serif", ui: "Newsreader", mono: "Courier Prime" }, kwBold: true,
    fx: `& .titlebar { border-bottom: 3px double #1a1a1a; }
      & .brand b { font-size: 20px; font-weight: 400; letter-spacing: .01em; }
      & .hd { font-style: italic; text-transform: none; letter-spacing: .01em; font-size: 15px; color: #1a1a1a; }
      & .ptab { font-variant: small-caps; text-transform: lowercase; letter-spacing: .08em; font-size: 13px; }
      & .status { border-top: 3px double #1a1a1a; font-variant: small-caps; letter-spacing: .04em; }
      & .tab { font-style: italic; } & .tab.on { font-style: normal; font-weight: 600; }`,
  },
  {
    id: "abyssal", name: "Abyssal", group: "comfort",
    blurb: "Deep sea: glowing teal and jellyfish magenta, light spots and drifting marine snow.",
    bg: "#010a12", chrome: "#020d17", surface: "#03111d", surface2: "#071a2a", sel: "#0b2b42",
    border: "#0a2134", border2: "#12344f",
    text: "#bfe9f2", textHi: "#eafcff", dim: "#5a93a8",
    accent: "#00ffd0", onAccent: "#00140f", accent2: "#ff5fe0", ok: "#5dffa8", bad: "#ff5f7a",
    lineHl: "#04131f", gutter: "#1d4a60", gutterHi: "#00ffd0", caret: "#00ffd0",
    syn: { kw: "#00ffd0", str: "#8fd3ff", num: "#ff5fe0", com: "#3a6b80", fn: "#eafcff", deco: "#ffb86b", punc: "#5f99ad" },
    mark: ["#06283a", "#007a8a", "#00ffd0", "#ff5fe0", "#eafcff"], ring: "#00ffd0",
    fonts: { display: "Outfit", ui: "Outfit", mono: "Martian Mono" }, metrics: { code: 12, lh: 20 },
    fx: `${SYNTAX} { text-shadow: 0 0 6px currentColor; }
      & .monaco-editor .monaco-editor-background { background-image: radial-gradient(rgba(143,211,255,.25) .8px, transparent 1.3px), radial-gradient(rgba(0,255,208,.2) .7px, transparent 1.2px); background-size: 53px 61px, 37px 43px; background-position: 0 0, 19px 23px; }
      & .monaco-host::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 5; mix-blend-mode: screen; background: radial-gradient(circle at 82% 22%, rgba(0,255,208,.2), transparent 40%), radial-gradient(circle at 16% 82%, rgba(255,95,224,.17), transparent 38%); }
      & .btn.pri { box-shadow: 0 0 14px rgba(0,255,208,.45); }
      & .brand b span { color: #ff5fe0; text-shadow: 0 0 8px #ff5fe0; }`,
  },
  {
    id: "four-shades", name: "Four Shades", group: "classic", light: true,
    blurb: "The four greens of the first handheld LCDs and nothing else. Pixel fonts.",
    bg: "#9bbc0f", chrome: "#8bac0f", surface: "#9bbc0f", surface2: "#8bac0f", sel: "#0f380f",
    border: "#306230", border2: "#306230",
    text: "#0f380f", textHi: "#0f380f", dim: "#306230",
    accent: "#0f380f", onAccent: "#9bbc0f", accent2: "#306230", ok: "#0f380f", bad: "#306230",
    lineHl: "#8bac0f", gutter: "#306230", gutterHi: "#0f380f", caret: "#0f380f",
    syn: { kw: "#0f380f", str: "#306230", num: "#0f380f", com: "#306230", fn: "#0f380f", deco: "#306230", punc: "#306230" },
    mark: ["#0f380f", "#306230", "#306230", "#8bac0f", "#9bbc0f"], ring: "#0f380f",
    hole: ["#8bac0f", "#306230", "#306230", "#0f380f", "#0f380f", "#0f380f"], holeShadow: "#0f380f",
    vars: { "status-bg": "#0f380f", "status-fg": "#9bbc0f", "status-line": "#0f380f", hover: "#8bac0f", "tint-bg": "#8bac0f", "line2": "#306230" },
    fonts: { display: "Silkscreen", ui: "DotGothic16", mono: "VT323" }, metrics: { ui: 13, code: 17, lh: 19, row: 24 }, kwBold: true,
    fx: `& .dot:not(.ok):not(.live) { background: transparent; box-shadow: inset 0 0 0 2px #0f380f; }
      & .btn, & .chip, & input, & .card, & textarea, & .search button { border-width: 2px; border-radius: 0; }
      & .hd { letter-spacing: .04em; font-size: 10px; } & .tab.on { box-shadow: inset 0 3px 0 #0f380f; }
      ${SEL_TEXT("#9bbc0f")}
      & .brand svg circle[r="3.72"] { fill: #0f380f; }
      & #app { font-variant-ligatures: none; } & .kv, & .log, & .mono, & .fn, & .nm, & .step b, & kbd, & textarea { font-size: 16px; }
      ${OVER} background: repeating-linear-gradient(0deg, rgba(15,56,15,.08) 0 1px, transparent 1px 3px), repeating-linear-gradient(90deg, rgba(15,56,15,.08) 0 1px, transparent 1px 3px); }`,
  },
  {
    id: "observatory", name: "Observatory", group: "blackhole",
    blurb: "Red only, so night vision survives, the way astronomers read charts in the dark.",
    bg: "#050000", chrome: "#080000", surface: "#0a0101", surface2: "#140303", sel: "#2e0606",
    border: "#1e0404", border2: "#3a0909",
    text: "#e8402f", textHi: "#ff5a45", dim: "#b8301f",
    accent: "#ff2a1a", onAccent: "#050000", accent2: "#ff6a55", ok: "#ff5a45", bad: "#c4321f",
    lineHl: "#100101", gutter: "#5a1209", gutterHi: "#ff5a45", caret: "#ff2a1a",
    syn: { kw: "#ff4a36", str: "#d9382a", num: "#ff7a62", com: "#93241a", fn: "#ff8f7a", deco: "#ff4a36", punc: "#a8281a" },
    mark: ["#3a0909", "#8a1a0f", "#d42a1a", "#ff4a36", "#ff8f7a"], ring: "#ff5a45",
    fonts: { display: "Oxanium", ui: "Oxanium", mono: "B612 Mono" }, kwBold: true,
    fx: `& .dot:not(.ok):not(.live) { background: transparent; box-shadow: inset 0 0 0 1.5px #b8301f; }`,
  },
  {
    id: "aurora", name: "Aurora", group: "comfort",
    blurb: "Northern lights: green and violet ribbons over a blue-black night sky.",
    bg: "#060a13", chrome: "#070c17", surface: "#08101c", surface2: "#0e1828", sel: "#15263d",
    border: "#111d2e", border2: "#1d2f48",
    text: "#d0dcef", textHi: "#f1f6ff", dim: "#6d7f9c",
    accent: "#3dffa2", onAccent: "#002814", accent2: "#b07bff", ok: "#3dffa2", bad: "#ff6b8b",
    lineHl: "#0a1220", gutter: "#2f4060", gutterHi: "#3dffa2", caret: "#3dffa2",
    syn: { kw: "#3dffa2", str: "#7ad7ff", num: "#ff9ad5", com: "#4f6382", fn: "#f1f6ff", deco: "#b07bff", punc: "#8494b0" },
    mark: ["#0e2a3a", "#1f9e8a", "#3dffa2", "#b07bff", "#f1f6ff"], ring: "#3dffa2",
    fonts: { display: "Plus Jakarta Sans", ui: "Plus Jakarta Sans", mono: "Fragment Mono" },
    fx: `& .titlebar { background: linear-gradient(100deg, rgba(61,255,162,.26), rgba(61,255,162,0) 30%, rgba(122,215,255,.18) 50%, rgba(176,123,255,.26) 72%, rgba(176,123,255,0) 92%), #070c17; }
      & .monaco-host::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 5; mix-blend-mode: screen; background: radial-gradient(ellipse 60% 85% at 20% 0, rgba(61,255,162,.26), transparent 70%), radial-gradient(ellipse 55% 75% at 76% 0, rgba(176,123,255,.3), transparent 70%), radial-gradient(ellipse 50% 40% at 50% 100%, rgba(122,215,255,.1), transparent 70%); }
      & .status { border-top: 1px solid; border-image: linear-gradient(90deg, #3dffa2, #7ad7ff, #b07bff, #ff9ad5) 1; }
      & .btn.pri { background: linear-gradient(90deg, #3dffa2, #7ad7ff); border-color: transparent; }
      & .right { background: linear-gradient(180deg, rgba(176,123,255,.08), transparent 40%), var(--bg2); }`,
  },
  {
    id: "bauhaus", name: "Bauhaus", group: "beige", light: true,
    blurb: "Red, blue and yellow on cream, thick black rules, geometric type.",
    bg: "#f3eee3", chrome: "#e9e2d3", surface: "#ece6d9", surface2: "#fffaf0", sel: "#f2c12e",
    border: "#1a1a1a", border2: "#1a1a1a",
    text: "#1a1a1a", textHi: "#000000", dim: "#5e5747",
    accent: "#d62718", onAccent: "#ffffff", accent2: "#1b4fa0", ok: "#1f7a3a", bad: "#d62718",
    lineHl: "#ebe4d4", gutter: "#9a917e", gutterHi: "#1a1a1a", caret: "#d62718",
    syn: { kw: "#d62718", str: "#1b4fa0", num: "#9a6a00", com: "#8a8270", fn: "#1a1a1a", deco: "#1b4fa0", punc: "#4a4538" },
    mark: ["#1a1a1a", "#1b4fa0", "#d62718", "#f2c12e", "#fffaf0"], ring: "#1a1a1a",
    vars: { "status-bg": "#1b4fa0", "status-fg": "#ffffff", "status-line": "#1a1a1a" },
    fonts: { display: "Josefin Sans", ui: "Jost", mono: "Spline Sans Mono" }, density: "regular", kwBold: true,
    fx: `& .titlebar, & .activity, & .sidebar, & .right, & .panel, & .status { border-width: 3px; border-color: #1a1a1a; }
      & .tabs { border-bottom: 2px solid #1a1a1a; }
      & .tab.on { box-shadow: inset 0 4px 0 #d62718; } & .group:not(:first-child) .tab.on { box-shadow: inset 0 4px 0 #1b4fa0; }
      & .ptab.on { box-shadow: inset 0 -3px 0 #f2c12e; }
      & .hd { font-weight: 700; letter-spacing: .18em; color: #1a1a1a; }
      & .brand b::after { content: ""; display: inline-block; width: 44px; height: 12px; margin-left: 10px; vertical-align: -1px; background: radial-gradient(circle at 6px 6px, #d62718 0 5.5px, transparent 6px), linear-gradient(#1b4fa0, #1b4fa0) 15px 1px / 10px 10px no-repeat, conic-gradient(from 150deg at 35px 1px, #f2c12e 0 60deg, transparent 60deg); }
      ${SEL_ROWS} { font-weight: 600; box-shadow: none; }`,
  },
  {
    id: "dark-matter", name: "Dark Matter", group: "comfort",
    blurb: "Focus mode: only the code around the cursor is lit; everything else fades into the dark.",
    bg: "#050506", chrome: "#050506", surface: "#050506", surface2: "#0d0d10", sel: "#18181e",
    border: "#111115", border2: "#1d1d24",
    text: "#c9c9d6", textHi: "#ffffff", dim: "#5e5e6a",
    accent: "#8f7dff", onAccent: "#07051a", accent2: "#8f7dff", ok: "#7fd19b", bad: "#e5534b",
    lineHl: "#0e0e13", gutter: "#26262e", gutterHi: "#b4a8ff", caret: "#b4a8ff",
    syn: { kw: "#b4a8ff", str: "#dcdce8", num: "#9fd0ff", com: "#55555f", fn: "#ffffff", deco: "#b4a8ff", punc: "#6a6a78" },
    mark: ["#14121f", "#2e2860", "#5a4fb0", "#8f7dff", "#e6e2ff"], ring: "#e6e2ff",
    fonts: { display: "Inter Tight", ui: "Inter Tight", mono: "Source Code Pro" }, focus: true,
    fx: `& .bh-dim { opacity: .2; }
      & .editor-area.multi .group:not(.active) .monaco-host, & .editor-area.multi .group:not(.active) .tabs { opacity: .28; }
      & .sidebar .rc:not(.sel), & .sidebar .it:not(.sel), & .sidebar .hd, & .sidebar input, & .panel { opacity: .4; }
      & .monaco-editor .view-overlays .current-line { background: radial-gradient(ellipse 60% 100% at 30% 50%, rgba(143,125,255,.14), transparent) !important; }`,
  },
  {
    id: "cryo", name: "Cryo", group: "comfort", light: true,
    blurb: "Frosted glass: translucent, blurred panels over soft ice-blue light.",
    bg: "#f7fbff", chrome: "#eaf3fc", surface: "#eef5fd", surface2: "#ffffff", sel: "#d3e6fb",
    border: "#d2e2f2", border2: "#b5cde6",
    text: "#1d2b3a", textHi: "#0b1622", dim: "#56697e",
    accent: "#1a7cff", onAccent: "#ffffff", accent2: "#0089a8", ok: "#12865a", bad: "#d93a4a",
    lineHl: "#eef5fd", gutter: "#a4b8cc", gutterHi: "#1d2b3a", caret: "#1a7cff",
    syn: { kw: "#1a5fd6", str: "#0b7a6b", num: "#8a3fd1", com: "#8a9bb0", fn: "#0b1622", deco: "#c2367a", punc: "#4d6075" },
    mark: ["#b5cde6", "#6fb0ff", "#1a7cff", "#0089a8", "#ffffff"], ring: "#ffffff",
    fonts: { display: "Lexend", ui: "Lexend", mono: "Inconsolata" }, density: "regular", metrics: { code: 14 }, kwBold: true,
    fx: `& body { background: radial-gradient(circle 560px at 8% 22%, #5fa8ff, transparent), radial-gradient(circle 520px at 92% 18%, #6fdde8, transparent), radial-gradient(circle 600px at 58% 100%, #a996ff, transparent), #dcebfb; }
      & #app { background: transparent; }
      & .titlebar, & .activity, & .sidebar, & .right, & .tabs, & .panel, & .status { background: rgba(255,255,255,.34); backdrop-filter: blur(16px) saturate(1.3); border-color: rgba(255,255,255,.8); }
      & .center { background: rgba(255,255,255,.66); }
      & .monaco-editor, & .monaco-editor .monaco-editor-background, & .monaco-editor .margin, & .monaco-editor .sticky-widget { background: transparent !important; }
      & .tab.on { background: rgba(255,255,255,.92); }
      & .btn, & .chip, & .card, & input, & textarea, & .search button { border-radius: 8px; }
      & .card { background: rgba(255,255,255,.7); box-shadow: 0 6px 18px rgba(26,124,255,.10); }
      & .btn.pri { box-shadow: 0 4px 12px rgba(26,124,255,.35); }`,
  },
  {
    id: "pulsar", name: "Pulsar", group: "blackhole",
    blurb: "Maximum contrast: black, white, yellow and cyan, 2px outlines, a yellow focus ring.",
    bg: "#000000", chrome: "#000000", surface: "#000000", surface2: "#141414", sel: "#ffff00",
    border: "#9a9a9a", border2: "#ffffff",
    text: "#ffffff", textHi: "#ffffff", dim: "#d6d6d6",
    accent: "#ffff00", onAccent: "#000000", accent2: "#00ffff", ok: "#00ff00", bad: "#ff5050",
    lineHl: "#1a1a1a", gutter: "#bdbdbd", gutterHi: "#ffff00", caret: "#ffff00",
    syn: { kw: "#ffff00", str: "#00ffff", num: "#ff9eff", com: "#c8c8c8", fn: "#ffffff", deco: "#ff9eff", punc: "#ffffff" },
    mark: ["#555555", "#aaaaaa", "#ffff00", "#00ffff", "#ffffff"], ring: "#ffff00",
    vars: { "status-line": "#ffffff" },
    fonts: { display: "Atkinson Hyperlegible", ui: "Atkinson Hyperlegible", mono: "Atkinson Hyperlegible Mono" }, density: "roomy", metrics: { code: 14 }, kwBold: true,
    fx: `${SEL_TEXT("#000")} ${SEL_ROWS} { font-weight: 700; }
      & .group.active { outline: 2px solid #ffff00; outline-offset: -2px; }
      & .btn, & .chip, & input, & .card, & textarea, & .search button { border-width: 2px; border-color: #fff; }
      & .btn.pri { border-color: #ffff00; }
      & .tab.on { box-shadow: inset 0 3px 0 #ffff00; text-decoration: underline; text-underline-offset: 4px; }
      & .ab.on { color: #000; background: #ffff00; box-shadow: none; }`,
  },
];
