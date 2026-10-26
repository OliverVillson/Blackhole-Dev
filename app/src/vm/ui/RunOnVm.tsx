// The Run on VM dialog (sketch board "Run on VM"): checks, machine pick, the exact commands, cost
// at the user's own rate, then one click that still passes the shell's confirm gate in main.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Check, Host, JobRef, LaunchPlan } from "../shared";
import type { VmApi } from "./api";

const MARK: Record<Check["tone"], string> = { ok: "✓", warn: "!", bad: "✗", info: "i" };

export function hostLine(h: Host): string {
  const bits = [h.kind === "vm" ? `${h.provider ?? "vm"} · ${h.state ?? ""}` : "ssh", h.gpu ? `1× ${h.gpu.toUpperCase()}` : null,
    h.ratePerHour != null ? `${h.currency ?? "$"}${h.ratePerHour.toFixed(2)}/h` : null, h.target || "no address yet"];
  return bits.filter(Boolean).join(" · ");
}

export function RunOnVm(props: { api: VmApi; recipe: string; close(): void; onLaunched(ref: JobRef): void }) {
  const { api, recipe } = props;
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"launch" | "up" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [pull, setPull] = useState(true);
  const [notify, setNotify] = useState(true);
  const [adding, setAdding] = useState("");
  const [newVm, setNewVm] = useState<{ open: boolean; provider: string; gpu: string; spot: boolean; offer?: string }>({ open: false, provider: "nebius", gpu: "b300", spot: false });
  const [rate, setRate] = useState("");

  const refreshHosts = useCallback(async (select?: string) => {
    const hs = await api.hosts();
    setHosts(hs);
    setHostId((cur) => select ?? cur ?? hs.find((h) => h.state !== "stopped" && h.target)?.id ?? null);
  }, [api]);

  useEffect(() => {
    void refreshHosts();
    const offs = [api.onHosts(setHosts), api.onLog((l) => (l.scope === "launch" || l.scope === "vm.up") && setLog((x) => [...x, l.text].slice(-200)))];
    return () => offs.forEach((o) => o());
  }, [api, refreshHosts]);

  const check = useCallback(async () => {
    if (!hostId) return;
    setChecking(true);
    setError(null);
    setPlan(null);
    try {
      setPlan(await api.prepare(recipe, hostId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, [api, hostId, recipe]);

  useEffect(() => {
    void check();
  }, [check]);

  const host = hosts.find((h) => h.id === hostId);

  const launch = async () => {
    if (!plan) return;
    setBusy("launch");
    setError(null);
    try {
      const ref = await api.launch(plan.id, { pullWhenDone: pull, notify });
      if (ref) {
        props.onLaunched(ref);
        props.close();
      }
    } catch (e) {
      setError((e as Error).message);
      void check();
    } finally {
      setBusy(null);
    }
  };

  const addHost = async () => {
    try {
      const h = await api.addHost(adding.trim());
      setAdding("");
      await refreshHosts(h.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const getOffer = async () => {
    setError(null);
    try {
      const o = await api.offer({ provider: newVm.provider, gpu: newVm.gpu, spot: newVm.spot });
      setNewVm((v) => ({ ...v, offer: o.line + (o.note ? ` (${o.note})` : "") }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startVm = async () => {
    setBusy("up");
    setError(null);
    try {
      const r = await api.up({ provider: newVm.provider, gpu: newVm.gpu, spot: newVm.spot });
      if (r.approved) {
        setNewVm((v) => ({ ...v, open: false }));
        await refreshHosts(r.name ? `vm:${r.name}` : undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveRate = async () => {
    const n = Number(rate);
    if (!host || !isFinite(n) || n <= 0) return;
    await api.updateHost(host.id, { ratePerHour: n, currency: "$" });
    setRate("");
    await refreshHosts();
    void check();
  };

  // Check -> Machine -> Send -> Watch: "Send" is next once the checks pass on the picked machine
  const step = busy === "launch" ? 2 : plan?.ok ? 2 : 0;
  const fileName = recipe.split("/").pop();
  const steps = useMemo(() => ["Check", "Machine", "Send", "Watch"], []);

  return (
    <div className="bhvm run" role="dialog" aria-label={`Run ${fileName} on a VM`}>
      <div className="top">
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="hd">Run on VM</div>
          <div className="title">{fileName}</div>
        </div>
        <div className="steps" aria-label="Progress">
          {steps.map((s, i) => (
            <span key={s} className={`sn ${i < step ? "done" : i === step ? "on" : ""}`}>
              <i>{i < step ? "✓" : i + 1}</i>{s}
            </span>
          ))}
        </div>
      </div>

      <div className="body">
        <div className="col">
          <div className="hd">Checks</div>
          {checking && <div className="dim">checking {host?.label ?? ""}…</div>}
          {plan?.checks.map((c, i) => (
            <div key={i} className={`ck ${c.tone}`}><b aria-label={c.tone}>{MARK[c.tone]}</b><span>{c.label}</span><span className="v">{c.detail}</span></div>
          ))}
          {!checking && !plan && !error && <div className="dim">pick a machine</div>}
          <div style={{ height: 6 }} />
          <div className="hd">Estimate</div>
          <div style={{ lineHeight: "20px" }}>
            {plan?.estHours != null ? `~${plan.estHours.toFixed(1)} h on ${host?.gpu ? "1× " + host.gpu.toUpperCase() : host?.label ?? "this machine"}` : "run time unknown until the plan has an estimate"}
            <br />
            <span className="dim">≈ {plan?.estCost ?? "[your VM hourly rate] × run time"}. The app never starts or pays for a VM without your click.</span>
          </div>
          {host && host.ratePerHour == null && host.kind === "ssh" && (
            <div className="row">
              <label htmlFor="bhvm-rate" className="dim">Your rate for {host.label}</label>
              <input id="bhvm-rate" type="number" min="0" step="0.01" placeholder="$/h" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 90 }} />
              <button className="btn sm" onClick={saveRate} disabled={!rate}>Save</button>
            </div>
          )}
        </div>

        <div className="col">
          <div className="hd">Machine</div>
          {hosts.map((h) => (
            <label key={h.id} className={`mc ${h.id === hostId ? "sel" : ""}`}>
              <input type="radio" name="bhvm-host" checked={h.id === hostId} disabled={!h.target || h.state === "stopped"} onChange={() => setHostId(h.id)} />
              <div className="t"><b>{h.label}</b><span>{hostLine(h)}</span></div>
            </label>
          ))}
          {!hosts.length && <div className="dim">No machines yet. Add one you already run, or start a cloud VM.</div>}
          <div className="mc" style={{ cursor: "default" }}>
            <div className="t">
              <label htmlFor="bhvm-add"><b>+ Add SSH host</b></label>
              <span>user@host or user@host:port; ssh uses your ~/.ssh keys, config and agent</span>
              <div className="row" style={{ marginTop: 6 }}>
                <input id="bhvm-add" type="text" placeholder="ubuntu@203.0.113.7" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && adding && addHost()} style={{ flex: 1 }} />
                <button className="btn sm" onClick={addHost} disabled={!adding.trim()}>Add</button>
              </div>
            </div>
          </div>
          <div className="mc" style={{ cursor: "default" }}>
            <div className="t">
              <button className="btn sm" style={{ alignSelf: "flex-start" }} aria-expanded={newVm.open} onClick={() => setNewVm((v) => ({ ...v, open: !v.open }))}>Start a new cloud VM…</button>
              <span>blackhole up: rents a GPU VM in your own cloud account and installs the harness</span>
              {newVm.open && (
                <div className="col" style={{ marginTop: 6 }}>
                  <div className="row">
                    <label className="dim" htmlFor="bhvm-prov">Provider</label>
                    <input id="bhvm-prov" type="text" value={newVm.provider} onChange={(e) => setNewVm((v) => ({ ...v, provider: e.target.value, offer: undefined }))} style={{ width: 90 }} />
                    <label className="dim" htmlFor="bhvm-gpu">GPU</label>
                    <input id="bhvm-gpu" type="text" value={newVm.gpu} onChange={(e) => setNewVm((v) => ({ ...v, gpu: e.target.value, offer: undefined }))} style={{ width: 70 }} />
                    <label className="row dim"><input type="checkbox" checked={newVm.spot} onChange={(e) => setNewVm((v) => ({ ...v, spot: e.target.checked, offer: undefined }))} />spot</label>
                  </div>
                  {newVm.offer && <span className="mono">{newVm.offer}</span>}
                  <div className="row">
                    <button className="btn sm" onClick={getOffer}>Show price</button>
                    <button className="btn sm pri" onClick={startVm} disabled={!newVm.offer || busy !== null}>{busy === "up" ? "Starting…" : "Start VM…"}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "0 22px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="hd">What will run</div>
        <div className="preview" aria-label="Commands">
          {(plan?.steps ?? []).map((s, i) => (
            <div key={i}>
              <div className="L"><span className="c"># {i + 1}. {s.title}</span></div>
              <div className="L"><span className="p">$</span> {s.cmd}</div>
            </div>
          ))}
          {!plan && <div className="L"><span className="c"># the commands appear once the checks have run</span></div>}
        </div>
        <div className="row" style={{ gap: 20, marginTop: 4 }}>
          <label className="row"><input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />Copy the finished model to this Mac</label>
          <label className="row"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Notify me at each gate and when it ends</label>
        </div>
        {error && <div className="err" role="alert">{error}</div>}
        {log.length > 0 && <div className="log" aria-live="polite">{log.join("\n")}</div>}
      </div>

      <div className="foot">
        <button className="btn" onClick={props.close}>Cancel</button>
        <button className="btn" onClick={() => checking || check()} disabled={checking || !hostId}>Check again</button>
        <button className="btn" onClick={() => plan && api.exportBundle(plan.bundle)} disabled={!plan?.bundle}>Export bundle only</button>
        <button className="btn pri" onClick={launch} disabled={!plan?.ok || busy !== null}>
          {busy === "launch" ? "Starting…" : `Run on ${host?.label ?? "…"} ▸`}
        </button>
      </div>
    </div>
  );
}
