import { describe, expect, it } from "vitest";
import { forkModel, READ_BUDGET, runAnalysis, scriptTemplate, type Deps } from "../../src/analysis/core";
import { DEFAULT_SETTINGS, fmtBytes, fmtNum, type Estimate } from "../../src/analysis/shared";
import type { ConfirmRequest } from "../../src/shared/gate";

class Err extends Error {
  constructor(public code: number, msg: string) { super(msg); }
}

function deps(est: Partial<Estimate>, run: (budget: number | undefined, n: number) => unknown, approve = true) {
  const asked: ConfirmRequest[] = [];
  const budgets: (number | undefined)[] = [];
  const d: Deps = {
    settings: () => DEFAULT_SETTINGS,
    confirm: async (r) => { asked.push(r); return approve; },
    call: (async (method: string, params?: any) => {
      if (method === "analysis.estimate") return { bytes: 1000, known: true, remote: false, seconds: 0, needs: "weights", model: null, ...est };
      if (method === "analysis.run") { budgets.push(params.budget); return run(params.budget, budgets.length); }
      if (method === "model.forkPlan") return { src: params.src, files: 1, weightBytes: 5e9, copyBytes: params.mode === "copy" ? 5e9 : 100, mode: params.mode };
      if (method === "model.fork") return { path: "/m/f", name: "f", mode: params.mode };
      throw new Error(method);
    }) as Deps["call"],
  };
  return { d, asked, budgets };
}

const report = { title: "t", name: "x", blocks: [], metrics: {}, params: {}, reads: 1, seconds: 0, model: null };

describe("runAnalysis", () => {
  it("runs a small known read under the limit as a budget, without asking", async () => {
    const t = deps({ bytes: 1e6 }, () => report);
    const out = await runAnalysis(t.d, { name: "layer-stats" });
    expect(out.ok).toBe(true);
    expect(t.asked).toEqual([]);
    expect(t.budgets).toEqual([2e9]);
  });

  it("asks before a big local read and then runs without a budget", async () => {
    const t = deps({ bytes: 9e9, seconds: 8 }, () => report);
    const out = await runAnalysis(t.d, { name: "layer-stats", requestedBy: "copilot" });
    expect(out.ok && out.approved).toBe(true);
    expect(t.asked[0].action).toBe("compute.local");
    expect(t.asked[0].requestedBy).toBe("copilot");
    expect(t.asked[0].details?.find((x) => x.label === "Reads")?.value).toBe("~9.00 GB");
    expect(t.budgets).toEqual([undefined]);
  });

  it("treats a Hub model's reads as a download with its own lower limit", async () => {
    const t = deps({ bytes: 300e6, remote: true }, () => report);
    await runAnalysis(t.d, { name: "weight-histogram" });
    expect(t.asked[0].action).toBe("download");
  });

  it("does not run when the user declines", async () => {
    const t = deps({ bytes: 9e9 }, () => report, false);
    const out = await runAnalysis(t.d, { name: "layer-stats" });
    expect(out).toEqual({ ok: false, cancelled: true, reason: "not approved" });
    expect(t.budgets).toEqual([]);
  });

  it("asks only when an unknown-cost script hits the budget, then repeats it unbounded", async () => {
    const t = deps({ bytes: null, known: false }, (b) => {
      if (b !== undefined) throw new Err(READ_BUDGET, "over");
      return report;
    });
    const out = await runAnalysis(t.d, { path: "/w/analysis/x.py" });
    expect(out.ok).toBe(true);
    expect(t.budgets).toEqual([2e9, undefined]);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].title).toContain("a lot of");
  });

  it("reports helper errors as text", async () => {
    const t = deps({}, () => { throw new Err(-32000, "ValueError: layer 9 has no experts"); });
    expect(await runAnalysis(t.d, { name: "expert-stats" })).toEqual({ ok: false, error: "ValueError: layer 9 has no experts" });
  });
});

describe("forkModel", () => {
  it("links without asking, and asks before a full copy", async () => {
    const a = deps({}, () => report);
    expect(await forkModel(a.d, { src: "/m/base" })).toEqual({ ok: true, path: "/m/f", name: "f", mode: "link" });
    expect(a.asked).toEqual([]);
    const b = deps({}, () => report, false);
    expect(await forkModel(b.d, { src: "/m/base", mode: "copy" })).toEqual({ ok: false, cancelled: true });
    expect(b.asked[0].title).toBe("Copy 5.00 GB to fork this model");
  });
});

describe("formatting and the template", () => {
  it("formats numbers and bytes for people", () => {
    expect(fmtNum(1284)).toBe("1,284");
    expect(fmtNum(12_900)).toBe("12.9K");
    expect(fmtNum(30.5e9)).toBe("30.5B");
    expect(fmtNum(0.0123456)).toBe("0.01235");
    expect(fmtNum(null)).toBe("–");
    expect(fmtBytes(9.8e9)).toBe("9.80 GB");
  });

  it("writes a runnable @analysis script", () => {
    const t = scriptTemplate("kurt");
    expect(t).toContain('@analysis("kurt"');
    expect(t).toContain("def run(r, m, sample: int = 128)");
  });
});
