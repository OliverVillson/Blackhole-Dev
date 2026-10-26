// Draws a Report's blocks: SVG charts (line, bar, histogram, heatmap, scatter), stat tiles,
// tables, text and images. No chart library: thin marks, hairline grid, one y axis, a hover
// readout on every chart and a table view of every chart's numbers.
//
// Palette (dark surface #0c0402, validated with the dataviz validator: lightness band, chroma
// floor, CVD and normal-vision separation, 3:1 contrast all pass). Slot 1 is the brand orange
// stepped into the band; series take slots in order and never cycle (a 7th folds to the table).
import { fmtNum, type Block, type Series, type Tile } from "./shared";

export const SERIES = ["#e8650c", "#3987e5", "#d55181", "#c98500", "#9085e9", "#199e70"] as const;
const STATUS = { ok: "#0ca30c", warn: "#fab219", bad: "#d03b3b" } as const;
const STATUS_MARK = { ok: "✓", warn: "!", bad: "✕" } as const;
// Sequential (heatmap): one warm hue, dark (low) to bright (high); the darkest step still
// clears 2:1 on the surface so low cells never vanish into it.
const RAMP = ["#7a2d0b", "#93360b", "#ad420c", "#c64f0e", "#dd5f14", "#ee7426", "#f78f48", "#fcac6e", "#ffca9a"];
const SVGNS = "http://www.w3.org/2000/svg";
const MAX_SERIES = SERIES.length;

type Attrs = Record<string, string | number | undefined>;

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function d<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ------------------------------------------------------------------ scales

export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo === hi) {
    const p = Math.abs(lo) || 1;
    lo -= p * 0.5;
    hi += p * 0.5;
  }
  const raw = (hi - lo) / Math.max(n, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const out: number[] = [];
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function extent(vals: (number | null | undefined)[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) if (v != null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

const log = (v: number) => Math.log10(Math.max(v, 0) + 1);

// ------------------------------------------------------------------ chart card

interface Plot {
  svg: SVGSVGElement;
  tip: (x: number, y: number, rows: { color?: string; label: string; value: string }[], head?: string) => void;
  hide: () => void;
}

interface Card {
  el: HTMLElement;
  body: HTMLElement;
}

function card(b: { title?: string; note?: string }, legend: string[] | null, legendShape: "line" | "rect", table: () => HTMLElement): Card {
  const el = d("section", "an-card");
  const head = d("div", "an-card-head");
  head.append(d("h3", "an-title", b.title ?? ""));
  const toggle = d("button", "an-link", "Table");
  toggle.type = "button";
  head.append(toggle);
  el.append(head);
  if (b.note) el.append(d("div", "an-note", b.note));
  if (legend && legend.length > 1) {
    const lg = d("div", "an-legend");
    legend.slice(0, MAX_SERIES).forEach((name, i) => {
      const it = d("span", "an-legend-it");
      const key = d("i", legendShape === "line" ? "an-key-line" : "an-key-rect");
      key.style.background = SERIES[i];
      it.append(key, document.createTextNode(name));
      lg.append(it);
    });
    if (legend.length > MAX_SERIES) lg.append(d("span", "an-legend-it", `+${legend.length - MAX_SERIES} more in the table`));
    el.append(lg);
  }
  const body = d("div", "an-plot");
  el.append(body);
  let shown: HTMLElement | null = null;
  toggle.addEventListener("click", () => {
    if (shown) {
      shown.remove();
      shown = null;
      body.style.display = "";
      toggle.textContent = "Table";
    } else {
      shown = table();
      body.style.display = "none";
      body.after(shown);
      toggle.textContent = "Chart";
    }
  });
  return { el, body };
}

function plot(body: HTMLElement, w: number, h: number, label: string): Plot {
  body.replaceChildren();
  const svg = s("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": label });
  const tip = d("div", "an-tip");
  tip.setAttribute("role", "status");
  body.append(svg, tip);
  return {
    svg,
    tip(x, y, rows, head) {
      tip.replaceChildren();
      if (head) tip.append(d("div", "an-tip-head", head));
      for (const r of rows) {
        const row = d("div", "an-tip-row");
        if (r.color) {
          const k = d("i", "an-key-line");
          k.style.background = r.color;
          row.append(k);
        }
        row.append(d("b", undefined, r.value), d("span", undefined, r.label));
        tip.append(row);
      }
      tip.style.display = "block";
      const bw = body.clientWidth || w;
      const tw = tip.offsetWidth || 160;
      tip.style.left = `${Math.min(Math.max(x + 14, 0), Math.max(bw - tw - 4, 0))}px`;
      tip.style.top = `${Math.max(y - 10, 0)}px`;
    },
    hide() {
      tip.style.display = "none";
    },
  };
}

/** Redraw on resize: draw(width) is called with the plot's current width. */
function responsive(body: HTMLElement, draw: (w: number) => void): void {
  const width = () => Math.max(320, Math.floor(body.clientWidth || 720));
  draw(width());
  if (typeof ResizeObserver === "undefined") return;
  let last = width();
  let t: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      const w = width();
      if (Math.abs(w - last) > 8) {
        last = w;
        draw(w);
      }
    }, 80);
  }).observe(body);
}

const M = { l: 64, r: 16, t: 10, b: 38 };

function axes(svg: SVGSVGElement, w: number, h: number, yt: number[], y: (v: number) => number, fmt: (v: number) => string, xlabel?: string, ylabel?: string): void {
  const g = s("g", { class: "an-axis" });
  for (const v of yt) {
    const yy = Math.round(y(v)) + 0.5;
    g.append(s("line", { x1: M.l, x2: w - M.r, y1: yy, y2: yy, class: "an-grid" }));
    g.append(s("text", { x: M.l - 8, y: yy + 4, "text-anchor": "end" }, fmt(v)));
  }
  if (xlabel) g.append(s("text", { x: (M.l + w - M.r) / 2, y: h - 4, "text-anchor": "middle", class: "an-axis-label" }, xlabel));
  if (ylabel) g.append(s("text", { x: 10, y: (M.t + h - M.b) / 2, "text-anchor": "middle", class: "an-axis-label", transform: `rotate(-90 10 ${(M.t + h - M.b) / 2})` }, ylabel));
  svg.append(g);
}

function xTicks(n: number, maxTicks: number): number[] {
  if (n <= maxTicks) return [...Array(n).keys()];
  const step = Math.ceil(n / maxTicks);
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

// ------------------------------------------------------------------ tables

export function tableEl(columns: string[], rows: unknown[][], limit = 200): HTMLElement {
  const wrap = d("div", "an-table-wrap");
  const t = d("table", "an-table");
  const thead = d("thead");
  const tr = d("tr");
  for (const c of columns) tr.append(d("th", undefined, c));
  thead.append(tr);
  const tbody = d("tbody");
  const fill = (n: number) => {
    tbody.replaceChildren();
    for (const r of rows.slice(0, n)) {
      const row = d("tr");
      for (const v of r) row.append(d("td", typeof v === "number" ? "num" : undefined, fmtNum(v)));
      tbody.append(row);
    }
  };
  fill(limit);
  t.append(thead, tbody);
  wrap.append(t);
  if (rows.length > limit) {
    const more = d("button", "an-link", `Show all ${rows.length} rows`);
    more.type = "button";
    more.addEventListener("click", () => {
      fill(rows.length);
      more.remove();
    });
    wrap.append(more);
  }
  return wrap;
}

function seriesTable(xname: string, xs: (string | number)[], series: Series[]): () => HTMLElement {
  return () => tableEl([xname || "x", ...series.map((x) => x.name)], xs.map((x, i) => [x, ...series.map((sr) => sr.values[i] ?? null)]));
}

// ------------------------------------------------------------------ line

function lineChart(b: Extract<Block, { kind: "line" }>): HTMLElement {
  const series = b.series.slice(0, MAX_SERIES);
  const c = card(b, b.series.map((x) => x.name), "line", seriesTable(b.xlabel ?? "x", b.x, b.series));
  const numericX = b.x.every((v) => typeof v === "number");
  const h = 260;
  responsive(c.body, (w) => {
    const p = plot(c.body, w, h, b.title);
    const xv = (i: number) => (numericX ? (b.x[i] as number) : i);
    const [x0, x1] = numericX ? extent(b.x as number[]) : [0, Math.max(b.x.length - 1, 1)];
    const X = (v: number) => M.l + ((v - x0) / (x1 - x0 || 1)) * (w - M.l - M.r);
    const tf = (v: number | null) => (v == null ? null : b.logy ? log(v) : v);
    const [ylo, yhi] = extent(series.flatMap((x) => x.values.map(tf)));
    const yt = niceTicks(Math.min(ylo, b.logy ? 0 : ylo), yhi);
    const Y = (v: number) => h - M.b - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * (h - M.t - M.b);
    axes(p.svg, w, h, yt, Y, (v) => (b.logy ? fmtNum(Math.round(10 ** v - 1)) : fmtNum(v)), b.xlabel, b.ylabel);
    const xa = s("g", { class: "an-axis" });
    for (const i of xTicks(b.x.length, Math.max(2, Math.floor((w - M.l - M.r) / 56)))) {
      xa.append(s("text", { x: X(xv(i)), y: h - M.b + 16, "text-anchor": "middle" }, typeof b.x[i] === "number" ? fmtNum(b.x[i]) : String(b.x[i])));
    }
    xa.append(s("line", { x1: M.l, x2: w - M.r, y1: h - M.b + 0.5, y2: h - M.b + 0.5, class: "an-baseline" }));
    p.svg.append(xa);
    series.forEach((sr, k) => {
      let dpath = "";
      let pen = false;
      sr.values.forEach((v, i) => {
        const t = tf(v);
        if (t == null) { pen = false; return; }
        dpath += `${pen ? "L" : "M"}${X(xv(i)).toFixed(1)},${Y(t).toFixed(1)}`;
        pen = true;
      });
      p.svg.append(s("path", { d: dpath, class: "an-line", stroke: SERIES[k] }));
      if (sr.values.length <= 40) {
        sr.values.forEach((v, i) => {
          const t = tf(v);
          if (t != null) p.svg.append(s("circle", { cx: X(xv(i)), cy: Y(t), r: 3, fill: SERIES[k], class: "an-dot-small" }));
        });
      }
      const last = [...sr.values.keys()].reverse().find((i) => sr.values[i] != null);
      if (last !== undefined) p.svg.append(s("circle", { cx: X(xv(last)), cy: Y(tf(sr.values[last])!), r: 4, fill: SERIES[k], class: "an-dot" }));
    });
    const cross = s("line", { y1: M.t, y2: h - M.b, class: "an-cross", visibility: "hidden" });
    p.svg.append(cross);
    const hit = s("rect", { x: M.l, y: M.t, width: w - M.l - M.r, height: h - M.t - M.b, fill: "transparent", tabindex: 0 });
    let focusI = 0;
    const show = (i: number) => {
      const xx = X(xv(i));
      cross.setAttribute("x1", String(xx));
      cross.setAttribute("x2", String(xx));
      cross.setAttribute("visibility", "visible");
      p.tip(xx, M.t, series.map((sr, k) => ({ color: SERIES[k], label: sr.name, value: fmtNum(sr.values[i]) })), `${b.xlabel || "x"} ${typeof b.x[i] === "number" ? fmtNum(b.x[i]) : b.x[i]}`);
    };
    const nearest = (px: number) => {
      let best = 0, bd = Infinity;
      b.x.forEach((_, i) => { const dd = Math.abs(X(xv(i)) - px); if (dd < bd) { bd = dd; best = i; } });
      return best;
    };
    hit.addEventListener("pointermove", (e) => { const r = p.svg.getBoundingClientRect(); show((focusI = nearest(e.clientX - r.left))); });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); p.hide(); });
    hit.addEventListener("focus", () => show(focusI));
    hit.addEventListener("blur", () => { cross.setAttribute("visibility", "hidden"); p.hide(); });
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        focusI = Math.min(Math.max(focusI + (e.key === "ArrowRight" ? 1 : -1), 0), b.x.length - 1);
        show(focusI);
        e.preventDefault();
      }
    });
    p.svg.append(hit);
  });
  return c.el;
}

// ------------------------------------------------------------------ bars (and histogram)

/** A bar with a 4px rounded data end and a square baseline end. */
function barPath(x: number, y: number, bw: number, bh: number, horizontal: boolean, neg: boolean): string {
  const r = Math.min(4, bw / 2, Math.abs(bh));
  if (bh <= 0) return "";
  if (!horizontal) {
    if (!neg) return `M${x},${y + bh}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + bh}Z`;
    return `M${x},${y}V${y + bh - r}Q${x},${y + bh} ${x + r},${y + bh}H${x + bw - r}Q${x + bw},${y + bh} ${x + bw},${y + bh - r}V${y}Z`;
  }
  // horizontal: x is the baseline side, bh is the length, y/bw the band
  const L = bh;
  if (!neg) return `M${x},${y}H${x + L - r}Q${x + L},${y} ${x + L},${y + r}V${y + bw - r}Q${x + L},${y + bw} ${x + L - r},${y + bw}H${x}Z`;
  return `M${x},${y}H${x - L + r}Q${x - L},${y} ${x - L},${y + r}V${y + bw - r}Q${x - L},${y + bw} ${x - L + r},${y + bw}H${x}Z`;
}

function barChart(b: Extract<Block, { kind: "bar" }>): HTMLElement {
  const series = b.series.slice(0, MAX_SERIES);
  const c = card(b, b.series.map((x) => x.name), "rect", seriesTable(b.xlabel || "label", b.labels, b.series));
  const n = b.labels.length;
  const horizontal = !!b.horizontal;
  const h = horizontal ? Math.max(120, n * (Math.min(24, 14 * series.length) + 14) + M.t + M.b) : 260;
  responsive(c.body, (w) => {
    const p = plot(c.body, w, h, b.title);
    const [lo, hi] = extent(series.flatMap((x) => x.values));
    const ticks = niceTicks(Math.min(lo, 0), Math.max(hi, 0));
    const t0 = ticks[0], t1 = ticks[ticks.length - 1];
    const ml = horizontal ? Math.min(180, 12 + 7 * Math.max(...b.labels.map((l) => l.length), 4)) : M.l;
    const span = horizontal ? w - ml - M.r - 48 : h - M.t - M.b;
    const V = (v: number) => ((v - t0) / (t1 - t0 || 1)) * span;
    const band = (horizontal ? h - M.t - M.b : w - ml - M.r) / Math.max(n, 1);
    const gap = 2;
    const bw = Math.max(1, Math.min(24, (band * 0.72 - gap * (series.length - 1)) / series.length));
    const groupW = bw * series.length + gap * (series.length - 1);
    const g = s("g", { class: "an-axis" });
    if (!horizontal) {
      for (const v of ticks) {
        const yy = Math.round(h - M.b - V(v)) + 0.5;
        g.append(s("line", { x1: ml, x2: w - M.r, y1: yy, y2: yy, class: v === 0 ? "an-baseline" : "an-grid" }));
        g.append(s("text", { x: ml - 8, y: yy + 4, "text-anchor": "end" }, fmtNum(v)));
      }
      const every = xTicks(n, Math.max(2, Math.floor((w - ml - M.r) / 40)));
      for (const i of every) g.append(s("text", { x: ml + band * (i + 0.5), y: h - M.b + 16, "text-anchor": "middle" }, b.labels[i]));
      if (b.xlabel) g.append(s("text", { x: (ml + w - M.r) / 2, y: h - 4, "text-anchor": "middle", class: "an-axis-label" }, b.xlabel));
      if (b.ylabel) g.append(s("text", { x: 10, y: (M.t + h - M.b) / 2, "text-anchor": "middle", class: "an-axis-label", transform: `rotate(-90 10 ${(M.t + h - M.b) / 2})` }, b.ylabel));
    } else {
      for (const v of ticks) {
        const xx = Math.round(ml + V(v)) + 0.5;
        g.append(s("line", { x1: xx, x2: xx, y1: M.t, y2: h - M.b, class: v === 0 ? "an-baseline" : "an-grid" }));
        g.append(s("text", { x: xx, y: h - M.b + 16, "text-anchor": "middle" }, fmtNum(v)));
      }
      b.labels.forEach((l, i) => g.append(s("text", { x: ml - 8, y: M.t + band * (i + 0.5) + 4, "text-anchor": "end" }, l)));
      if (b.ylabel) g.append(s("text", { x: (ml + w - M.r) / 2, y: h - 4, "text-anchor": "middle", class: "an-axis-label" }, b.ylabel));
    }
    p.svg.append(g);
    const zero = V(0);
    const labelTips = series.length === 1 && n <= 16;
    for (let i = 0; i < n; i++) {
      series.forEach((sr, k) => {
        const v = sr.values[i];
        if (v == null) return;
        const len = Math.abs(V(v) - zero);
        const neg = v < 0;
        const off = (band - groupW) / 2 + k * (bw + gap);
        let path: string, tx: number, ty: number;
        if (!horizontal) {
          const x = ml + band * i + off;
          const y = neg ? h - M.b - zero : h - M.b - zero - len;
          path = barPath(x, y, bw, len, false, neg);
          tx = x + bw / 2;
          ty = neg ? y + len + 12 : y - 5;
        } else {
          const y = M.t + band * i + off;
          const x = ml + zero;
          path = barPath(x, y, bw, len, true, neg);
          tx = neg ? x - len - 4 : x + len + 4;
          ty = y + bw / 2 + 4;
        }
        const mark = s("path", { d: path || `M0,0`, fill: SERIES[k], class: "an-bar", tabindex: 0 });
        const showTip = () => {
          const r = safeBox(mark);
          p.tip(r ? r.x + r.width : tx, r ? r.y : ty, [{ color: SERIES[k], label: sr.name, value: fmtNum(v) }], b.labels[i]);
        };
        mark.addEventListener("pointerenter", showTip);
        mark.addEventListener("focus", showTip);
        mark.addEventListener("pointerleave", () => p.hide());
        mark.addEventListener("blur", () => p.hide());
        p.svg.append(mark);
        if (labelTips || horizontal) {
          p.svg.append(s("text", { x: tx, y: ty, "text-anchor": horizontal ? (neg ? "end" : "start") : "middle", class: "an-value" }, fmtNum(v)));
        }
      });
    }
  });
  return c.el;
}

function safeBox(el: SVGGraphicsElement): DOMRect | null {
  try {
    const r = el.getBBox();
    return r.width || r.height ? r : null;
  } catch {
    return null;
  }
}

function histChart(b: Extract<Block, { kind: "hist" }>): HTMLElement {
  const rows = b.counts.map((n, i) => [b.edges[i], b.edges[i + 1], n]);
  const c = card(b, null, "rect", () => tableEl(["from", "to", "count"], rows));
  const h = 260;
  responsive(c.body, (w) => {
    const p = plot(c.body, w, h, b.title);
    // log scale: ticks at powers of ten, an empty bin draws nothing
    const tf = (v: number) => (b.logy ? (v > 0 ? Math.log10(v) + 1 : 0) : v);
    const top = Math.max(...b.counts.map(tf), 1);
    const yt = b.logy ? [...Array(Math.ceil(top - 1e-9) + 1).keys()] : niceTicks(0, top);
    const Y = (v: number) => h - M.b - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * (h - M.t - M.b);
    axes(p.svg, w, h, yt, Y, (v) => (b.logy ? (v === 0 ? "0" : fmtNum(10 ** (v - 1))) : fmtNum(v)), b.xlabel, b.logy ? "count (log)" : "count");
    const x0 = b.edges[0], x1 = b.edges[b.edges.length - 1];
    const X = (v: number) => M.l + ((v - x0) / (x1 - x0 || 1)) * (w - M.l - M.r);
    const xa = s("g", { class: "an-axis" });
    for (const v of niceTicks(x0, x1, Math.max(2, Math.floor((w - M.l - M.r) / 70)))) {
      if (v >= x0 && v <= x1) xa.append(s("text", { x: X(v), y: h - M.b + 16, "text-anchor": "middle" }, fmtNum(v)));
    }
    xa.append(s("line", { x1: M.l, x2: w - M.r, y1: h - M.b + 0.5, y2: h - M.b + 0.5, class: "an-baseline" }));
    p.svg.append(xa);
    b.counts.forEach((n, i) => {
      const xa0 = X(b.edges[i]);
      const full = X(b.edges[i + 1]) - xa0;
      const bw = Math.max(1, full - (full > 4 ? 2 : 0));
      const y = Y(tf(n));
      const len = h - M.b - y;
      if (len > 0) p.svg.append(s("path", { d: barPath(xa0, y, bw, len, false, false), fill: SERIES[0], class: "an-bar" }));
      const hitR = s("rect", { x: xa0, y: M.t, width: Math.max(full, 1), height: h - M.t - M.b, fill: "transparent" });
      hitR.addEventListener("pointerenter", () => p.tip(xa0 + bw, Math.min(y, h - M.b - 20), [{ label: "weights", value: fmtNum(n) }], `${fmtNum(b.edges[i])} to ${fmtNum(b.edges[i + 1])}`));
      hitR.addEventListener("pointerleave", () => p.hide());
      p.svg.append(hitR);
    });
  });
  return c.el;
}

// ------------------------------------------------------------------ heatmap

export function rampColor(t: number): string {
  const x = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  return RAMP[Math.round(x)];
}

function heatmap(b: Extract<Block, { kind: "heatmap" }>): HTMLElement {
  const c = card(b, null, "rect", () => tableEl([b.ylabel || "row", ...b.cols], b.rows.map((r, i) => [r, ...(b.values[i] ?? [])])));
  const nr = b.rows.length, nc = b.cols.length;
  const [lo, hi] = extent(b.values.flat());
  responsive(c.body, (w) => {
    const ml = 44, mt = 6, mb = 52;
    const cw = Math.max(2, (w - ml - M.r) / Math.max(nc, 1));
    const ch = Math.min(18, Math.max(4, cw));
    const h = mt + ch * nr + mb;
    const p = plot(c.body, w, h, b.title);
    const g = s("g");
    b.values.forEach((row, i) => row.forEach((v, j) => {
      const gapX = cw > 6 ? 1 : 0, gapY = ch > 6 ? 1 : 0;
      g.append(s("rect", { x: ml + j * cw, y: mt + i * ch, width: Math.max(cw - gapX, 1), height: Math.max(ch - gapY, 1), fill: v == null ? "transparent" : rampColor((v - lo) / (hi - lo || 1)), class: v == null ? "an-cell-empty" : undefined }));
    }));
    p.svg.append(g);
    const ax = s("g", { class: "an-axis" });
    for (const i of xTicks(nr, Math.max(2, Math.floor((ch * nr) / 14)))) ax.append(s("text", { x: ml - 6, y: mt + ch * (i + 0.5) + 4, "text-anchor": "end" }, b.rows[i]));
    for (const j of xTicks(nc, Math.max(2, Math.floor((w - ml - M.r) / 34)))) ax.append(s("text", { x: ml + cw * (j + 0.5), y: mt + ch * nr + 14, "text-anchor": "middle" }, b.cols[j]));
    if (b.xlabel) ax.append(s("text", { x: ml + (cw * nc) / 2, y: mt + ch * nr + 30, "text-anchor": "middle", class: "an-axis-label" }, b.xlabel));
    // scale legend
    const lgW = Math.min(220, w - ml - M.r), lgY = h - 12;
    RAMP.forEach((col, k) => ax.append(s("rect", { x: w - M.r - lgW + (k * lgW) / RAMP.length, y: lgY - 8, width: lgW / RAMP.length, height: 8, fill: col })));
    ax.append(s("text", { x: w - M.r - lgW - 6, y: lgY, "text-anchor": "end" }, `${b.label ? b.label + " " : ""}${fmtNum(lo)}`));
    ax.append(s("text", { x: w - M.r, y: lgY - 12, "text-anchor": "end" }, fmtNum(hi)));
    p.svg.append(ax);
    const ring = s("rect", { width: cw, height: ch, class: "an-cell-hover", visibility: "hidden" });
    p.svg.append(ring);
    const hit = s("rect", { x: ml, y: mt, width: cw * nc, height: ch * nr, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const r = p.svg.getBoundingClientRect();
      const j = Math.floor((e.clientX - r.left - ml) / cw), i = Math.floor((e.clientY - r.top - mt) / ch);
      if (i < 0 || j < 0 || i >= nr || j >= nc) return;
      ring.setAttribute("x", String(ml + j * cw));
      ring.setAttribute("y", String(mt + i * ch));
      ring.setAttribute("visibility", "visible");
      p.tip(ml + (j + 1) * cw, mt + i * ch, [{ label: b.label || "value", value: fmtNum(b.values[i]?.[j]) }], `${b.ylabel || "row"} ${b.rows[i]} · ${b.xlabel || "col"} ${b.cols[j]}`);
    });
    hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); p.hide(); });
    p.svg.append(hit);
  });
  return c.el;
}

// ------------------------------------------------------------------ scatter

function scatter(b: Extract<Block, { kind: "scatter" }>): HTMLElement {
  const series = b.series.slice(0, 3); // any two points can sit side by side: three slots pass all-pairs
  const c = card(b, b.series.map((x) => x.name), "rect", () =>
    tableEl(["series", "label", b.xlabel || "x", b.ylabel || "y"], b.series.flatMap((sr) => sr.x.map((x, i) => [sr.name, sr.labels?.[i] ?? i, x, sr.y[i]]))));
  const h = 280;
  responsive(c.body, (w) => {
    const p = plot(c.body, w, h, b.title);
    const [ylo, yhi] = extent(series.flatMap((x) => x.y));
    const [xlo, xhi] = extent(series.flatMap((x) => x.x));
    const yt = niceTicks(ylo, yhi);
    const xt = niceTicks(xlo, xhi, Math.max(2, Math.floor((w - M.l - M.r) / 80)));
    const Y = (v: number) => h - M.b - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * (h - M.t - M.b);
    const X = (v: number) => M.l + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * (w - M.l - M.r);
    axes(p.svg, w, h, yt, Y, fmtNum, b.xlabel, b.ylabel);
    const xa = s("g", { class: "an-axis" });
    for (const v of xt) xa.append(s("text", { x: X(v), y: h - M.b + 16, "text-anchor": "middle" }, fmtNum(v)));
    p.svg.append(xa);
    const pts: { x: number; y: number; k: number; i: number }[] = [];
    series.forEach((sr, k) => sr.x.forEach((xv, i) => {
      if (xv == null || sr.y[i] == null) return;
      const pt = { x: X(xv), y: Y(sr.y[i]), k, i };
      pts.push(pt);
      p.svg.append(s("circle", { cx: pt.x, cy: pt.y, r: 4, fill: SERIES[k], class: "an-dot" }));
    }));
    const ring = s("circle", { r: 7, class: "an-dot-hover", visibility: "hidden" });
    p.svg.append(ring);
    const hit = s("rect", { x: M.l, y: M.t, width: w - M.l - M.r, height: h - M.t - M.b, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const r = p.svg.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      let best: (typeof pts)[number] | null = null, bd = 30 * 30;
      for (const q of pts) { const dd = (q.x - px) ** 2 + (q.y - py) ** 2; if (dd < bd) { bd = dd; best = q; } }
      if (!best) { ring.setAttribute("visibility", "hidden"); p.hide(); return; }
      const sr = series[best.k];
      ring.setAttribute("cx", String(best.x));
      ring.setAttribute("cy", String(best.y));
      ring.setAttribute("visibility", "visible");
      p.tip(best.x, best.y, [{ color: SERIES[best.k], label: b.ylabel || "y", value: fmtNum(sr.y[best.i]) }, { label: b.xlabel || "x", value: fmtNum(sr.x[best.i]) }], sr.labels?.[best.i] ?? sr.name);
    });
    hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); p.hide(); });
    p.svg.append(hit);
  });
  return c.el;
}

// ------------------------------------------------------------------ tiles, text, tables, images

function tiles(b: Extract<Block, { kind: "tiles" }>): HTMLElement {
  const el = d("section", "an-tiles");
  if (b.title) el.append(d("h3", "an-title", b.title));
  const grid = d("div", "an-tile-grid");
  for (const t of b.items as Tile[]) {
    const tile = d("div", "an-tile");
    tile.append(d("div", "an-tile-label", t.label));
    const v = d("div", "an-tile-value", fmtNum(t.value));
    tile.append(v);
    if (t.tone) {
      const st = d("div", `an-status an-status-${t.tone}`);
      const mark = d("i", undefined, STATUS_MARK[t.tone]);
      mark.style.background = STATUS[t.tone];
      st.append(mark, document.createTextNode(t.tone === "ok" ? "ok" : t.tone === "warn" ? "check" : "problem"));
      tile.append(st);
    }
    if (t.note) tile.append(d("div", "an-tile-note", t.note));
    grid.append(tile);
  }
  el.append(grid);
  return el;
}

function text(b: Extract<Block, { kind: "text" }>): HTMLElement {
  const p = d("p", "an-text");
  b.text.split(/(`[^`]+`)/).forEach((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) p.append(d("code", undefined, part.slice(1, -1)));
    else if (part) p.append(document.createTextNode(part));
  });
  return p;
}

/** Long x axes, heatmaps and wide tables get the full row; small charts sit two to a row. */
export function isWide(b: Block): boolean {
  switch (b.kind) {
    case "line": return b.x.length > 12;
    case "heatmap": return b.cols.length > 12;
    case "bar": return !b.horizontal && b.labels.length * b.series.length > 16;
    case "table": return b.columns.length > 4 || b.rows.some((r) => r.some((v) => String(v).length > 40));
    default: return false;
  }
}

export function renderBlock(b: Block): HTMLElement {
  const el = drawBlock(b);
  if (isWide(b)) el.classList.add("an-wide");
  return el;
}

function drawBlock(b: Block): HTMLElement {
  switch (b.kind) {
    case "line": return lineChart(b);
    case "bar": return barChart(b);
    case "hist": return histChart(b);
    case "heatmap": return heatmap(b);
    case "scatter": return scatter(b);
    case "tiles": return tiles(b);
    case "text": return text(b);
    case "table": {
      const el = d("section", "an-card");
      if (b.title) el.append(d("h3", "an-title", b.title));
      el.append(tableEl(b.columns, b.rows));
      return el;
    }
    case "image": {
      const el = d("section", "an-card");
      if (b.title) el.append(d("h3", "an-title", b.title));
      const img = d("img", "an-img");
      img.src = `data:image/png;base64,${b.png}`;
      img.alt = b.title ?? "figure";
      el.append(img);
      return el;
    }
    default: {
      const unknown = b as { kind?: string };
      return d("p", "an-text", `(a ${String(unknown.kind)} block this app version cannot draw)`);
    }
  }
}
