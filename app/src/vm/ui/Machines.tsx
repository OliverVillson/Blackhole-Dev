// The Machines sidebar view: every host, what its GPU and disk are doing, its jobs, and for VMs
// made by `blackhole up` the stop / start / delete buttons (each behind the confirm gate).

import { useCallback, useEffect, useState } from "react";
import type { Host, Probe, RemoteJob } from "../shared";
import type { VmApi } from "./api";
import { hostLine } from "./RunOnVm";

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function jobLine(j: RemoteJob): string {
  if (j.running) return `running · ${j.last?.stage ?? ""} ${j.last?.pct != null ? Math.round(j.last.pct) + "%" : ""}`.trim();
  if (j.outcome === "done") return `done · ${ago(j.updatedAt)}`;
  if (j.outcome === "stopped") return `stopped · ${ago(j.updatedAt)}`;
  if (j.outcome === "error") return `failed${j.last?.stage && j.last.stage !== "pipeline" ? ` in ${j.last.stage}` : ""} · ${ago(j.updatedAt)}`;
  return `not running · ${ago(j.updatedAt)}`;
}

function Meter({ label, value, max, unit, color }: { label: string; value: number; max: number; unit: string; color: string }) {
  const pct = max > 0 ? Math.min(100, (100 * value) / max) : 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}><span className="dim">{label}</span><span>{unit === "%" ? `${value.toFixed(0)}%` : `${value.toFixed(0)} / ${max.toFixed(0)} ${unit}`}</span></div>
      <div className="bar" style={{ marginTop: 4 }} role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><u style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

function HostCard(props: { api: VmApi; host: Host; open: boolean; toggle(): void; openJob(h: Host, j: RemoteJob): void; openTerminal(h: Host): void }) {
  const { api, host: h } = props;
  const [probe, setProbe] = useState<Probe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    if (!h.target) return;
    const r = await api.testHost(h.id);
    setProbe(r.probe ?? null);
    setErr(r.ok ? null : r.error ?? "unreachable");
  }, [api, h.id, h.target]);

  useEffect(() => {
    if (!props.open) return;
    void refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [props.open, refresh]);

  const act = async (f: () => Promise<{ approved: boolean; done?: boolean; blockedBy?: string[]; message?: string }>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await f();
      if (r.approved && r.done === false) setBlocked(r.blockedBy ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gpu = probe?.gpus[0];
  const status = err ? "bad" : probe ? "ok" : "";
  return (
    <div className={`host ${props.open ? "open" : ""}`}>
      <button onClick={props.toggle} aria-expanded={props.open}>
        <b><span className={`dot ${status}`} aria-hidden="true" />{h.label}</b>
        <span>{hostLine(h)}</span>
      </button>
      {props.open && (
        <>
          {err && <span className="err" role="alert">{err}</span>}
          {gpu && (
            <div className="col" style={{ gap: 6 }}>
              <Meter label="GPU util" value={gpu.util} max={100} unit="%" color="var(--ember, #ff6a00)" />
              <Meter label="GPU memory" value={gpu.usedGb} max={gpu.memGb} unit="GB" color="var(--redshift, #d7261e)" />
              {probe && <Meter label="Disk" value={probe.diskTotalGb - probe.diskFreeGb} max={probe.diskTotalGb} unit="GB" color="var(--crimson, #9e1b07)" />}
            </div>
          )}
          {probe && !probe.pipeline && <span className="err">no harness venv found on this machine</span>}
          {probe?.jobs.length ? <div className="hd" style={{ marginTop: 6 }}>Jobs</div> : null}
          {probe?.jobs.slice(0, 12).map((j) => (
            <button key={j.name} className="job" onClick={() => props.openJob(h, j)}>
              <b>{j.name}</b>
              <span className={j.running ? "run" : undefined}>{jobLine(j)}</span>
            </button>
          ))}
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn sm" onClick={refresh} disabled={!h.target}>Refresh</button>
            <button className="btn sm" onClick={() => props.openTerminal(h)} disabled={!h.target}>TUI</button>
            {h.kind === "vm" && h.state === "running" && <button className="btn sm" disabled={busy} onClick={() => act(() => api.down(h.id, { keepDisk: true }))}>Stop VM</button>}
            {h.kind === "vm" && h.state === "stopped" && <button className="btn sm" disabled={busy} onClick={() => act(() => api.down(h.id, { keepDisk: false, resume: true }))}>Start VM</button>}
            {h.kind === "vm" && <button className="btn sm dng" disabled={busy} onClick={() => act(() => api.down(h.id, { keepDisk: false }))}>Delete…</button>}
            {h.source === "app" && <button className="btn sm" onClick={() => api.removeHost(h.id)}>Remove</button>}
          </div>
          {blocked && (
            <div className="col" style={{ gap: 4 }}>
              <span className="err">These models are still on the VM and would be lost:</span>
              {blocked.map((b) => <span key={b} className="mono" style={{ fontSize: 11 }}>{b}</span>)}
              <span className="dim">Copy them off first (open the job, Copy result to Mac), or stop the VM to keep the disk.</span>
              <div className="row">
                <button className="btn sm" onClick={() => setBlocked(null)}>Keep it</button>
                <button className="btn sm dng" disabled={busy} onClick={() => act(async () => { const r = await api.down(h.id, { keepDisk: false, force: true }); if (r.approved) setBlocked(null); return r; })}>Delete anyway…</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Machines(props: { api: VmApi; openJob(h: Host, j: RemoteJob): void; openTerminal(h: Host): void }) {
  const { api } = props;
  const [hosts, setHosts] = useState<Host[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.hosts().then((hs) => {
      setHosts(hs);
      setOpen((o) => o ?? hs[0]?.id ?? null);
    });
    return api.onHosts(setHosts);
  }, [api]);

  const add = async () => {
    try {
      const h = await api.addHost(adding.trim());
      setAdding("");
      setOpen(h.id);
      setHosts(await api.hosts());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="bhvm side">
      <div className="hd" style={{ padding: "0 4px 6px" }}>Machines</div>
      {hosts.map((h) => (
        <HostCard key={h.id} api={api} host={h} open={open === h.id} toggle={() => setOpen(open === h.id ? null : h.id)} openJob={props.openJob} openTerminal={props.openTerminal} />
      ))}
      {!hosts.length && <span className="dim" style={{ padding: "0 4px" }}>Hosts from ~/.ssh/config and VMs from blackhole up show here.</span>}
      <div className="col" style={{ padding: "10px 4px", gap: 6 }}>
        <label htmlFor="bhvm-side-add" className="hd">Add SSH host</label>
        <div className="row">
          <input id="bhvm-side-add" type="text" placeholder="user@host[:port]" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && adding && add()} style={{ flex: 1 }} />
          <button className="btn sm" onClick={add} disabled={!adding.trim()}>Add</button>
        </div>
        {err && <span className="err">{err}</span>}
      </div>
    </div>
  );
}
