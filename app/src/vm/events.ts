// events.log -> JobState. The log is the pipeline's stdout: REAPer's JSON progress lines
// ({"stage", "status", "pct", "msg", "ts", ...}) mixed with plain log lines. Pure, so the job
// monitor, the status bar and the tests all fold the same lines the same way.

import type { JobEvent, JobState, KlPoint, LogLine, StageState } from "./shared";

const STATUSES = new Set(["running", "done", "error", "skipped"]);
export const MAX_LINES = 2000;

/** The protocol's parse(): an event for a JSON progress line, else a text line. */
export function parseLine(line: string): LogLine {
  const s = line.replace(/\r?\n$/, "");
  const t = s.trim();
  if (t.startsWith("{")) {
    try {
      const ev = JSON.parse(t);
      if (ev && typeof ev === "object" && typeof ev.stage === "string" && STATUSES.has(ev.status)) {
        return { kind: "event", ev: ev as JobEvent };
      }
    } catch {
      /* a log line that happens to start with { */
    }
  }
  return { kind: "text", text: s };
}

/** Splits a byte stream into lines, keeping the unfinished tail for the next chunk. */
export class LineSplitter {
  private rest = "";
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    const r = this.rest;
    this.rest = "";
    return r ? [r] : [];
  }
}

export function emptyState(stages: string[] = []): JobState {
  return {
    status: "pending",
    stages: stages.map((name) => ({ name, status: "pending", pct: 0 })),
    kl: [],
    metrics: {},
    lines: [],
  };
}

// Held-out KL as the heal stages word it today:
//   "distil step 160: held-out KL 0.019 (start 0.020, best 0.019 at step 152)"
// A step's own event can instead carry {"kl": 0.0191, "step": 160}, which wins when present.
const HELD_OUT = /(?:^|\s)(?:(\S[^:]*?)\s+)?step\s+(\d+)(?:\/\d+)?:\s*held-out KL\s+([0-9]*\.?[0-9]+)/i;

export function klPoint(ev: JobEvent): KlPoint | null {
  if (ev.status === "running" && typeof ev.kl === "number" && typeof ev.step === "number") {
    return { step: ev.step, kl: ev.kl, stage: ev.stage, phase: typeof ev.phase === "string" ? ev.phase : undefined };
  }
  const m = typeof ev.msg === "string" ? HELD_OUT.exec(ev.msg) : null;
  if (!m) return null;
  return { step: Number(m[2]), kl: Number(m[3]), stage: ev.stage, phase: m[1]?.trim() || undefined };
}

const RESULT_SKIP = new Set(["stage", "status", "ts", "pct", "msg", "outcome"]);

function stageOf(st: JobState, name: string): StageState {
  let s = st.stages.find((x) => x.name === name);
  if (!s) {
    s = { name, status: "pending", pct: 0 };
    st.stages.push(s);
  }
  return s;
}

/** Folds lines into the state. Returns a new state; the input is not changed. */
export function reduce(prev: JobState, lines: LogLine[]): JobState {
  const st: JobState = {
    ...prev,
    stages: prev.stages.map((s) => ({ ...s })),
    kl: prev.kl.slice(),
    metrics: { ...prev.metrics },
    lines: prev.lines.concat(lines),
  };
  if (st.lines.length > MAX_LINES) st.lines = st.lines.slice(-MAX_LINES);
  for (const line of lines) {
    if (line.kind !== "event") continue;
    const ev = line.ev;
    if (ev.ts) {
      st.updatedAt = ev.ts;
      st.startedAt ??= ev.ts;
    }
    if (ev.stage === "pipeline") {
      if (ev.status === "running") st.status = "running";
      else if (ev.status === "done") {
        st.status = "done";
        if (typeof ev.model === "string") st.model = ev.model;
        if (typeof ev.gates_passed === "boolean") st.gatesPassed = ev.gates_passed;
        if (typeof ev.size_gb === "number") st.metrics.size_gb = ev.size_gb;
        st.current = undefined;
      } else if (ev.status === "error") {
        st.status = ev.outcome === "stopped" || ev.msg === "stopped" ? "stopped" : "error";
        for (const s of st.stages) if (s.status === "running") s.status = st.status === "stopped" ? "pending" : "error";
      }
      continue;
    }
    const s = stageOf(st, ev.stage);
    if (st.status === "pending") st.status = "running";
    s.status = ev.status;
    if (ev.status === "running") {
      s.startedAt ??= ev.ts;
      st.current = s.name;
      // a later stage running means the earlier ones finished, even if their done line was lost
      const i = st.stages.indexOf(s);
      for (const e of st.stages.slice(0, i)) if (e.status === "running") e.status = "done";
    } else {
      s.endedAt = ev.ts;
      if (st.current === s.name) st.current = undefined;
    }
    if (typeof ev.pct === "number") s.pct = ev.pct;
    if (ev.status === "done" || ev.status === "skipped") s.pct = 100;
    if (ev.msg) s.msg = ev.msg;
    if (ev.status === "error") st.status = "error";
    if (ev.status === "done") {
      const result: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(ev)) {
        if (RESULT_SKIP.has(k) || (typeof v !== "number" && typeof v !== "string")) continue;
        result[k] = v;
        st.metrics[k] = v;
      }
      if (Object.keys(result).length) s.result = result;
    }
    const p = klPoint(ev);
    if (p) {
      st.kl.push(p);
      st.metrics.heldout_kl = p.kl;
    }
  }
  return st;
}

/** A short line for the status bar and the jobs list: "distil 62%", "done", "failed in mlx". */
export function summary(st: JobState): string {
  if (st.status === "done") return st.gatesPassed === false ? "done · a gate failed" : "done";
  if (st.status === "stopped") return "stopped";
  if (st.status === "error") {
    const s = st.stages.find((x) => x.status === "error");
    return s ? `failed in ${s.name}` : "failed";
  }
  const cur = st.stages.find((x) => x.name === st.current);
  if (cur) return `${cur.name} ${Math.round(cur.pct)}%`;
  return st.status;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} m`;
  if (m) return `${m} m`;
  return `${s} s`;
}
