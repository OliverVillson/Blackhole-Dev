// Palette tokens, same names and values as landing/index.html in BlackHole-Harness.
export const THEME = {
  void: "#000000",
  ash: "#4a0d02",
  crimson: "#9e1b07",
  redshift: "#d7261e",
  ember: "#ff6a00",
  flare: "#ffae42",
  photon: "#f5efe6",
  text: "#f0dccb",
  dim: "#a2735b",
  bg1: "#060201",
  bg2: "#0c0402",
  line: "#1e0804",
  line2: "#2b0d05",
  sel: "#2a0c04",
} as const;

export type ThemeToken = keyof typeof THEME;
