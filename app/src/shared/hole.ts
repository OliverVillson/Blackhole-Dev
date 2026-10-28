// The black-hole art, drawn as square pixels on a canvas. Same model and palette steps as the
// TUI's art (BlackHole-Harness harness/blackhole_tui/art.py) and the landing page: shadow,
// photon ring, a tilted accretion disk in front and its lensed far side bent over the top.

import { themeById } from "./themes";

/** The active theme's hole palette (renderer/theme.ts marks the theme on <html data-theme>). */
function palette(): { steps: string[]; shadow: string | null } {
  const t = themeById(typeof document === "undefined" ? null : document.documentElement.dataset.theme);
  return { steps: t.hole, shadow: t.holeShadow };
}
const CUTS = [0.06, 0.16, 0.3, 0.46, 0.64, 0.82];
const DIN = 1.4, DOUT = 3.1, TILT = 0.17;

/** Brightness 0..1 at (x, y) in shadow radii (+y down); px is one pixel in the same units. */
function intensity(x: number, y: number, px: number): number {
  const r = Math.hypot(x, y);
  if (y >= 0) {
    const rho = Math.hypot(x, y / TILT);
    if (rho >= DIN && rho <= DOUT) {
      const phi = Math.atan2(y / TILT, x);
      const fall = (DOUT - rho) / (DOUT - DIN);
      const beam = 1 + 0.45 * (-x / rho);
      const swirl = 0.9 + 0.1 * Math.sin(phi * 3 + rho * 2);
      return Math.min((0.25 + 0.75 * fall ** 1.4) * beam * swirl, 1);
    }
  }
  if (r < 1) return 0;
  const d = Math.abs(r - 1 - 0.5 * px) / px; // pixels from the photon ring's centre line
  const ring = d <= 0.6 ? 1 : Math.exp(-(((d - 0.6) / 0.7) ** 2));
  const above = Math.min(1, Math.max(0, 1 - y / 0.45));
  const edge = 1.57 + 0.5 * above;
  let halo = 0;
  if (r < edge) {
    const k = (r - 1) / (edge - 1);
    halo = (1 - k) ** 1.6 * (0.5 + 0.35 * above) * (1 + 0.35 * (-x / r));
    halo *= 0.94 + 0.06 * Math.sin(Math.atan2(y, x) * 2 + r * 2);
  }
  let back = 0;
  if (y < 0) {
    const rho = Math.hypot(x, y / TILT);
    if (rho >= DIN && rho <= DOUT) back = 0.55 * (DOUT - rho) / (DOUT - DIN) * (1 + 0.4 * (-x / rho));
  }
  const glow = r < DOUT + 0.3 ? 0.1 * Math.exp(-Math.max(0, r - 1.1) * 1.6) : 0;
  return Math.min(1, Math.max(ring * 0.95, halo, back, glow));
}

/** Palette step per pixel (0 = unlit, -1 = inside the shadow), cropped to the lit rows. */
export function holePixels(cols: number): number[][] {
  const rows = Math.round(cols * 13 / 16);
  const unit = cols / 2 / (DOUT + 0.1);
  const grid: number[][] = [];
  for (let py = 0; py < rows; py++) {
    const line: number[] = [];
    for (let px = 0; px < cols; px++) {
      const x = (px + 0.5 - cols / 2) / unit, y = (py + 0.5 - rows / 2) / unit;
      const v = intensity(x, y, 1 / unit);
      let i = 0;
      while (i < CUTS.length && v >= CUTS[i]) i++;
      line.push(i === 0 && Math.hypot(x, y) < 1 ? -1 : i);
    }
    grid.push(line);
  }
  return grid.filter((line) => line.some((v) => v > 0));
}

/** A canvas with the hole `cols` art pixels wide, each `size` CSS pixels square. It repaints
 *  itself when the theme changes. Light themes paint the shadow so the hole stays black. */
export function holeCanvas(cols = 48, size = 4): HTMLCanvasElement {
  const grid = holePixels(cols);
  const k = Math.max(1, Math.round(size * (window.devicePixelRatio || 1)));
  const canvas = document.createElement("canvas");
  canvas.width = cols * k;
  canvas.height = grid.length * k;
  canvas.style.width = `${cols * size}px`;
  canvas.style.height = `${grid.length * size}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const paint = () => {
    const { steps, shadow } = palette();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    grid.forEach((line, y) => line.forEach((v, x) => {
      if (v === 0 || (v < 0 && !shadow)) return;
      ctx.fillStyle = v < 0 ? shadow! : steps[v - 1];
      ctx.fillRect(x * k, y * k, k, k);
    }));
  };
  paint();
  const onTheme = () => (canvas.isConnected ? paint() : window.removeEventListener("bh:theme", onTheme));
  window.addEventListener("bh:theme", onTheme);
  return canvas;
}
