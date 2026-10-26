import { describe, expect, it } from "vitest";
import { emptyState, klPoint, LineSplitter, parseLine, reduce, summary } from "../../src/vm/events";

const ev = (o: object) => JSON.stringify(o);

describe("parseLine", () => {
  it("reads protocol lines and leaves log lines as text", () => {
    expect(parseLine(ev({ stage: "score", status: "running", pct: 42 }))).toEqual({ kind: "event", ev: { stage: "score", status: "running", pct: 42 } });
    expect(parseLine("10:18:04 job x: Qwen/Qwen3.6")).toEqual({ kind: "text", text: "10:18:04 job x: Qwen/Qwen3.6" });
    expect(parseLine('{"not": "an event"}').kind).toBe("text");
    expect(parseLine('{"stage": "x", "status": "weird"}').kind).toBe("text");
    expect(parseLine("{broken json").kind).toBe("text");
  });
});

describe("LineSplitter", () => {
  it("keeps a line cut between chunks", () => {
    const s = new LineSplitter();
    expect(s.push('{"stage":"a","sta')).toEqual([]);
    expect(s.push('tus":"done"}\nnext\npart')).toEqual(['{"stage":"a","status":"done"}', "next"]);
    expect(s.flush()).toEqual(["part"]);
  });
});

describe("klPoint", () => {
  it("reads the heal stage's held-out KL message as it is worded today", () => {
    const p = klPoint({ stage: "heal", status: "running", pct: 50, msg: "distil step 160: held-out KL 0.019 (start 0.020, best 0.019 at step 152)" });
    expect(p).toEqual({ step: 160, kl: 0.019, stage: "heal", phase: "distil" });
    expect(klPoint({ stage: "qheal", status: "running", msg: "on-policy 2 step 24: held-out KL 0.071 (start 0.072, best 0.071 at step 24)" }))
      .toMatchObject({ step: 24, kl: 0.071, phase: "on-policy 2" });
  });
  it("ignores the training-loss KL, which is not comparable", () => {
    expect(klPoint({ stage: "heal", status: "running", msg: "distil step 161/258 · KL 0.4123 · 1288 seqs · 52 min" })).toBeNull();
  });
  it("prefers structured fields", () => {
    expect(klPoint({ stage: "heal", status: "running", kl: 0.0191, step: 8 })).toEqual({ step: 8, kl: 0.0191, stage: "heal", phase: undefined });
  });
});

describe("reduce", () => {
  const lines = [
    ev({ stage: "pipeline", status: "running", pct: 0, ts: 100, msg: "started" }),
    "10:18:04 job q: Qwen",
    ev({ stage: "detect", status: "running", pct: 10, ts: 101 }),
    ev({ stage: "detect", status: "done", pct: 100, ts: 102, msg: "qwen3_moe · 48 layers" }),
    ev({ stage: "calibrate", status: "skipped", pct: 100, ts: 103, msg: "cached" }),
    ev({ stage: "heal", status: "running", pct: 40, ts: 104, msg: "distil step 8: held-out KL 0.0195 (start 0.0195, best 0.0195 at step 8)" }),
    ev({ stage: "heal", status: "running", pct: 60, ts: 105, msg: "distil step 16: held-out KL 0.0191 (start 0.0195, best 0.0191 at step 16)" }),
  ].map(parseLine);

  it("tracks stages, the current one and the KL series", () => {
    const st = reduce(emptyState(["detect", "calibrate", "heal", "mlx"]), lines);
    expect(st.status).toBe("running");
    expect(st.stages.map((s) => [s.name, s.status])).toEqual([["detect", "done"], ["calibrate", "skipped"], ["heal", "running"], ["mlx", "pending"]]);
    expect(st.current).toBe("heal");
    expect(st.kl.map((p) => p.kl)).toEqual([0.0195, 0.0191]);
    expect(st.metrics.heldout_kl).toBe(0.0191);
    expect(st.startedAt).toBe(100);
    expect(summary(st)).toBe("heal 60%");
    expect(st.lines).toHaveLength(7);
  });

  it("finishes with the stage results and the model path", () => {
    const st = reduce(emptyState(), [
      ...lines,
      parseLine(ev({ stage: "heal", status: "done", pct: 100, ts: 106, msg: "healed", kl: 0.0188, top1: 0.93 })),
      parseLine(ev({ stage: "pipeline", status: "done", pct: 100, ts: 107, model: "/j/out/m", outcome: "done", gates_passed: true })),
    ]);
    expect(st.status).toBe("done");
    expect(st.model).toBe("/j/out/m");
    expect(st.stages.find((s) => s.name === "heal")?.result).toEqual({ kl: 0.0188, top1: 0.93 });
    expect(st.metrics.kl).toBe(0.0188);
    expect(summary(st)).toBe("done");
  });

  it("knows a failed stage from a stopped job", () => {
    const failed = reduce(emptyState(), [...lines, parseLine(ev({ stage: "heal", status: "error", msg: "CUDA OOM" })), parseLine(ev({ stage: "pipeline", status: "error", msg: "heal failed", outcome: "error" }))]);
    expect(failed.status).toBe("error");
    expect(summary(failed)).toBe("failed in heal");
    const stopped = reduce(emptyState(), [...lines, parseLine(ev({ stage: "pipeline", status: "error", msg: "stopped", outcome: "stopped" }))]);
    expect(stopped.status).toBe("stopped");
    expect(stopped.stages.find((s) => s.name === "heal")?.status).toBe("pending");
  });

  it("does not change the state it was given", () => {
    const a = emptyState(["detect"]);
    reduce(a, lines);
    expect(a.stages[0].status).toBe("pending");
    expect(a.lines).toHaveLength(0);
  });
});
