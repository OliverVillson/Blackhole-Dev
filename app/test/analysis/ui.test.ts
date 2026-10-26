// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { niceTicks, rampColor, renderBlock, SERIES } from "../../src/analysis/charts";
import type { Block, ModelRow } from "../../src/analysis/shared";
import { AnalysisStore, modelTree, renderSidebar, renderTab } from "../../src/analysis/ui";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const BLOCKS: Block[] = [
  { kind: "tiles", items: [{ label: "Size", value: 9.8, note: "GB" }, { label: "Fits", value: "yes", tone: "ok" }] },
  { kind: "line", title: "kurtosis by layer", x: [0, 1, 2], series: [{ name: "attention", values: [3, 4, null] }, { name: "experts", values: [5, 6, 7] }], xlabel: "layer" },
  { kind: "bar", title: "Size by part", labels: ["experts", "attention"], series: [{ name: "GB", values: [8, 1.5] }], horizontal: true },
  { kind: "bar", title: "grouped", labels: ["a", "b"], series: [{ name: "this", values: [1, -2] }, { name: "other", values: [2, 1] }] },
  { kind: "hist", title: "w", edges: [-1, 0, 1], counts: [10, 1000], logy: true },
  { kind: "heatmap", title: "REAP", rows: ["0", "1"], cols: ["0", "1", "2"], values: [[1, 2, null], [3, 4, 5]], label: "saliency" },
  { kind: "scatter", title: "s", series: [{ name: "experts", x: [1, 2], y: [3, 4], labels: ["e0", "e1"] }] },
  { kind: "table", title: "t", columns: ["a", "b"], rows: [["x", 1.5]] },
  { kind: "text", text: "use `reap-score` first" },
];

describe("charts", () => {
  it("draws every block kind, with legends only for several series", () => {
    for (const b of BLOCKS) {
      const el = renderBlock(b);
      document.body.append(el);
      expect(el.textContent).not.toContain("cannot draw");
    }
    const line = renderBlock(BLOCKS[1]);
    expect(line.querySelectorAll(".an-legend-it")).toHaveLength(2);
    expect([...line.querySelectorAll("path.an-line")].map((p) => p.getAttribute("stroke"))).toEqual([SERIES[0], SERIES[1]]);
    expect(line.querySelector("path.an-line")!.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/); // a gap for null
    expect(renderBlock(BLOCKS[2]).querySelector(".an-legend")).toBeNull();
    expect(renderBlock(BLOCKS[5]).querySelectorAll("rect.an-cell-empty")).toHaveLength(1);
    expect(renderBlock(BLOCKS[8]).querySelector("code")!.textContent).toBe("reap-score");
  });

  it("swaps any chart for a table of its numbers", () => {
    const el = renderBlock(BLOCKS[1]);
    const btn = el.querySelector("button")!;
    btn.click();
    const rows = [...el.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows).toEqual([["0", "3", "5"], ["1", "4", "6"], ["2", "–", "7"]]);
    btn.click();
    expect(el.querySelector("table")).toBeNull();
  });

  it("keeps labels as text, never markup", () => {
    const el = renderBlock({ kind: "bar", title: "<img src=x onerror=alert(1)>", labels: ["<b>x</b>"], series: [{ name: "v", values: [1] }] });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<b>x</b>");
  });

  it("has clean ticks and a monotone ramp", () => {
    expect(niceTicks(0, 9.3)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1);
    expect(rampColor(0)).not.toBe(rampColor(1));
  });
});

describe("models tree", () => {
  it("puts forks under their parent", () => {
    const row = (name: string, parent: string | null): ModelRow => ({ path: `/m/${name}`, name, parent: parent && `/m/${parent}`, forkedAt: null, mode: null, edits: 0, base: null, sizeBytes: 1 });
    const t = modelTree([row("b-fork", "b"), row("a", null), row("b", null), row("b-fork-2", "b-fork"), row("orphan", "gone")]);
    expect(t.map((x) => `${"  ".repeat(x.depth)}${x.row.name}`)).toEqual(["a", "b", "  b-fork", "    b-fork-2", "orphan"]);
  });
});

function fakeCtx(calls: { ch: string; args: any[] }[]) {
  const responses: Record<string, unknown> = {
    "analysis:list": { analyses: [{ name: "overview", title: "Overview", doc: "what it is", needs: "headers", params: { device: { type: "str", default: "M-series-16GB", required: false } }, origin: "builtin", path: "/x/overview.py", group: "model" }], problems: [], dir: "/w/analysis", model: null },
    "analysis:models": { models: [{ path: "/m/base", name: "base", parent: null, edits: 0, sizeBytes: 9.8e9 }, { path: "/m/f", name: "f", parent: "/m/base", edits: 2, sizeBytes: 9.8e9 }] },
    "analysis:estimate": { bytes: 0, known: true, remote: false, seconds: 0, needs: "headers", model: null },
    "analysis:run": { ok: true, report: { title: "Overview", name: "overview", blocks: [BLOCKS[0]], metrics: {}, params: {}, reads: 0, seconds: 0.01, model: "/m/f" } },
  };
  return {
    invoke: async (ch: string, ...args: any[]) => { calls.push({ ch, args }); return responses[ch]; },
    on: () => () => undefined,
    notify: () => undefined,
    executeCommand: async () => undefined,
    workspace: { open: async () => undefined },
    editor: { getText: () => "" },
  } as any;
}

describe("sidebar and tab", () => {
  it("lists models with forks indented and analyses by group, and picks a model", async () => {
    const calls: { ch: string; args: any[] }[] = [];
    const ctx = fakeCtx(calls);
    const store = new AnalysisStore(ctx);
    const el = document.createElement("div");
    const opened: any[] = [];
    renderSidebar(el, ctx, store, (s) => opened.push(s));
    await tick();
    const rows = [...el.querySelectorAll(".an-row")];
    expect(rows.map((r) => r.querySelector(".nm")!.textContent)).toEqual(["base", "f", "Overview"]);
    expect(rows[1].querySelector(".an-tag")!.textContent).toBe("fork");
    (rows[1] as HTMLElement).click();
    expect(store.model).toBe("/m/f");
    (el.querySelectorAll(".an-row")[2] as HTMLElement).click();
    expect(opened).toEqual([{ name: "overview", model: "/m/f" }]);
  });

  it("runs a free analysis on open and draws it", async () => {
    const calls: { ch: string; args: any[] }[] = [];
    const ctx = fakeCtx(calls);
    const store = new AnalysisStore(ctx);
    const el = document.createElement("div");
    renderTab(el, ctx, store, { name: "overview", model: "/m/f" });
    await tick(50);
    expect(el.querySelector(".an-tile-value")?.textContent).toBe("9.8");
    const run = calls.find((c) => c.ch === "analysis:run")!;
    expect(run.args[0]).toMatchObject({ name: "overview", model: "/m/f", params: { device: "M-series-16GB" } });
    expect(el.querySelector(".an-est")!.textContent).toBe("Headers only: reads no weights.");
  });
});
