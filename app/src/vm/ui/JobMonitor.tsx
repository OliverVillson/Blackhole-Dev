// The job monitor tab (sketch board "Job monitor"): stages, the held-out KL during healing, the
// event stream and the raw log, live from the job's events.log on the machine.

import { useEffect, useState } from "react";
import { formatDuration, summary } from "../events";
import type { JobRef, JobUpdate, KlPoint, LogLine, PullProgress } from "../shared";
import { jobKey } from "../shared";
import type { VmApi } from "./api";

export function KlChart({ points }: { points: KlPoint[] }) {
  if (points.length < 2) {
    return <div className="dim" style={{ height: 120, display: "flex", alignItems: "center" }}>{points.length ? `one reading so far: ${points[0].kl.toFixed(4)}` : "no held-out KL yet (it is measured every few steps while healing)"}</div>;
  }
  const W = 600;
  const H = 120;
  const pad = { l: 46, r: 8, t: 8, b: 18 };
  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.kl);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1e-6) {
    lo -= 0.001;
    hi += 0.001;
  }
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, xs.length - 1);
  const y = (v: number) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo);
  const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.kl).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const label = `Held-out KL from ${first.kl.toFixed(4)} at step ${first.step} to ${last.kl.toFixed(4)} at step ${last.step}, ${points.length} readings`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 120, marginTop: 8 }} role="img" aria-label={label}>
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="var(--line2, #2b0d05)" />
      <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="var(--line2, #2b0d05)" />
      <text x={pad.l - 6} y={pad.t + 8} textAnchor="end" fontSize="10" fill="var(--dim, #a2735b)">{hi.toFixed(4)}</text>
      <text x={pad.l - 6} y={H - pad.b} textAnchor="end" fontSize="10" fill="var(--dim, #a2735b)">{lo.toFixed(4)}</text>
      <text x={pad.l} y={H - 4} fontSize="10" fill="var(--dim, #a2735b)">step {first.step}</text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" fontSize="10" fill="var(--dim, #a2735b)">step {last.step}</text>
      <polyline points={pts} fill="none" stroke="var(--ember, #ff6a00)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={x(points.length - 1)} cy={y(last.kl)} r="3" fill="var(--flare, #ffae42)" />
    </svg>
  );
}

const clock = (ts?: number) => (ts ? new Date(ts * 1000).toTimeString().slice(0, 8) : "");

function EventRow({ line }: { line: LogLine }) {
  if (line.kind === "text") return <div className="dim">{line.text}</div>;
  const e = line.ev;
  return (
    <div className={e.status === "error" ? "e" : undefined}>
      <span className="ts">{clock(e.ts)}</span>
      <span className="sg">{e.stage}</span>
      {e.status !== "running" ? `${e.status} · ` : ""}{e.msg ?? (e.pct != null ? `${e.pct}%` : "")}
    </div>
  );
}

export interface MonitorState { job: JobRef; hostLabel: string; estHours?: number }

export function JobMonitor(props: { api: VmApi; tab: MonitorState; openTerminal(mode: "tui" | "attach" | "shell"): void; ask(question: string): Promise<boolean> }) {
  const { api, tab } = props;
  const ref = tab.job;
  const [u, setU] = useState<JobUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let live = true;
    api.watch(ref).then((x) => live && setU(x), (e) => setError((e as Error).message));
    const offJob = api.onJob((x) => jobKey(x.job) === jobKey(ref) && setU(x));
    const offPull = api.onPull((p) => jobKey(p.job) === jobKey(ref) && setPull(p));
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      live = false;
      offJob();
      offPull();
      clearInterval(t);
      void api.unwatch(ref);
    };
  }, [api, ref]);

  const st = u?.state;
  const running = st?.status === "running";
  const elapsed = st?.startedAt ? (running ? now : st.updatedAt ?? now) - st.startedAt : undefined;
  const left = tab.estHours != null && elapsed != null && running ? tab.estHours * 3600 - elapsed : undefined;
  // while healing: the latest held-out reading; once finished: the final model's KL
  const kl = running ? st?.metrics.heldout_kl ?? st?.metrics.kl : st?.metrics.kl ?? st?.metrics.heldout_kl;
  const stagesDone = st?.stages.filter((s) => s.status === "done" || s.status === "skipped").length ?? 0;
  const events = (st?.lines ?? []).filter((l) => l.kind === "event").slice(-200).reverse();
  const text = (st?.lines ?? []).filter((l) => l.kind === "text").slice(-200);

  const stop = async () => {
    if (!(await props.ask(`Stop ${ref.name}? The running stage stops and frees the GPU. Finished stages are kept, so a rerun resumes from the stage that was stopped.`))) return;
    setStopping(true);
    try {
      await api.stop(ref);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const copy = async () => {
    setError(null);
    try {
      await api.pull(ref);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="bhvm mon">
      <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="hd">Job · {tab.hostLabel} · {ref.name}</div>
          <h1>
            {ref.name}
            {st && <span className={`badge ${st.status}`}>● {st ? summary(st) : ""}</span>}
          </h1>
          {u && u.link !== "live" && <div className="dim">{u.link === "reconnecting" ? "reconnecting to the machine…" : "offline"}{u.error ? `: ${u.error}` : ""}</div>}
        </div>
        <button className="btn" onClick={() => props.openTerminal("tui")}>Open TUI</button>
        <button className="btn" onClick={() => props.openTerminal("attach")} disabled={!running}>Attach</button>
        <button className="btn" onClick={copy} disabled={st?.status !== "done" || (pull != null && !pull.done && !pull.error)}>Copy result to Mac</button>
        <button className="btn dng" onClick={stop} disabled={!running || stopping}>{stopping ? "Stopping…" : "Stop job"}</button>
      </div>

      {error && <div className="err" role="alert">{error}</div>}
      {pull && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="hd">Copy to this Mac</span>
            <span className="dim">{pull.error ? <span className="err">{pull.error}</span> : pull.done ? `done · ${pull.dest}` : `${pull.pct.toFixed(0)}%`}</span>
          </div>
          <div className="bar" style={{ marginTop: 8 }}><u style={{ width: `${pull.done ? 100 : pull.pct}%` }} /></div>
          {!pull.done && pull.line && <div className="dim mono" style={{ fontSize: 11, marginTop: 6 }}>{pull.line}</div>}
        </div>
      )}

      <div className="stages" aria-label="Stages">
        {(st?.stages ?? []).map((s) => (
          <div key={s.name} className={`st ${s.status}`} title={s.msg}>
            <i><u style={{ width: s.status === "running" ? `${s.pct}%` : 0 }} /></i>
            <b>{s.name}{s.status === "running" ? ` ${Math.round(s.pct)}%` : s.status === "skipped" ? " (cached)" : ""}</b>
          </div>
        ))}
        {!st?.stages.length && <div className="dim">waiting for the first event…</div>}
      </div>

      <div className="cards">
        <div className="card"><div className="hd">Held-out KL</div><div className="big">{typeof kl === "number" ? kl.toFixed(4) : "–"}</div><div className="dim" style={{ fontSize: 12 }}>safety check, 0 = identical</div></div>
        <div className="card"><div className="hd">Elapsed</div><div className="big">{elapsed != null ? formatDuration(elapsed) : "–"}</div><div className="dim" style={{ fontSize: 12 }}>{left != null ? (left > 0 ? `about ${formatDuration(left)} left` : "past the estimate") : running ? "running" : st?.status ?? ""}</div></div>
        <div className="card"><div className="hd">Stages</div><div className="big">{stagesDone} / {st?.stages.length ?? 0}</div><div className="dim" style={{ fontSize: 12 }}>{st?.current ? `now: ${st.current}` : st?.status === "done" ? "all finished" : ""}</div></div>
        <div className="card"><div className="hd">Gates</div><div className="big" style={{ color: st?.gatesPassed === false ? "#ff8c5a" : "var(--flare, #ffae42)" }}>{st?.gatesPassed == null ? "–" : st.gatesPassed ? "passed" : "failed"}</div><div className="dim" style={{ fontSize: 12 }}>{[typeof st?.metrics.size_gb === "number" ? `${st.metrics.size_gb} GB` : null, typeof st?.metrics.top1 === "number" ? `top-1 ${(Number(st.metrics.top1) * 100).toFixed(1)}%` : null].filter(Boolean).join(" · ")}</div></div>
      </div>

      <div className="card" style={{ padding: "14px 14px 8px" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="hd">Held-out KL while healing</span>
          <span className="dim" style={{ fontSize: 12 }}>measured before quantization; the end bench is the verdict</span>
        </div>
        <KlChart points={st?.kl ?? []} />
      </div>

      <div className="two">
        <div className="card"><div className="hd" style={{ marginBottom: 8 }}>Events · newest first</div><div className="lines" aria-live="polite">{events.map((l, i) => <EventRow key={i} line={l} />)}</div></div>
        <div className="card" style={{ background: "var(--void, #000)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className="hd">Log · events.log</span>
            <button className="btn sm" onClick={() => props.openTerminal("tui")}>TUI in terminal</button>
          </div>
          <div className="lines">{text.map((l, i) => <EventRow key={i} line={l} />)}</div>
        </div>
      </div>
    </div>
  );
}
