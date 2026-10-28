// Per-machine actions, shared by the Machines view and the Run on VM machine list: the right-click
// menu, the × that forgets a machine, and the Forget confirmation. Forget only takes a machine off
// the list; Delete VM goes to main, where the confirm gate (vm.delete) asks for a human click.

import { useEffect, useRef, useState } from "react";
import type { ForgetResult, Host } from "../shared";
import { CONSOLES } from "../shared";
import type { VmApi } from "./api";

export type DownResult = { approved: boolean; done?: boolean; blockedBy?: string[]; message?: string };

export interface MenuItem { label: string; danger?: boolean; run(): void }

/** What the menu offers for one machine. */
export function hostMenuItems(h: Host, a: { stop(): void; start(): void; del(): void; forget(): void }): MenuItem[] {
  const items: MenuItem[] = [];
  if (h.kind === "vm" && h.state === "running") items.push({ label: "Stop VM (keep disk)", run: a.stop });
  if (h.kind === "vm" && h.state === "stopped") items.push({ label: "Start VM", run: a.start });
  if (h.kind === "vm") items.push({ label: "Delete VM…", danger: true, run: a.del });
  items.push({ label: h.source === "ssh-config" ? "Hide from list" : "Forget machine…", run: a.forget });
  return items;
}

export function forgetLabel(h: Host): string {
  return h.source === "ssh-config" ? "Hide" : "Forget";
}

export function HostMenu(props: { x: number; y: number; items: MenuItem[]; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const off = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) props.close();
    };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", off, true);
    window.addEventListener("blur", props.close);
    return () => {
      window.removeEventListener("mousedown", off, true);
      window.removeEventListener("keydown", off, true);
      window.removeEventListener("blur", props.close);
    };
  }, [props.close]);
  return (
    <div ref={ref} className="bhvm-menu" role="menu" style={{ left: props.x, top: props.y }}>
      {props.items.map((i) => (
        <button key={i.label} role="menuitem" className={i.danger ? "dng" : undefined} onClick={() => { props.close(); i.run(); }}>{i.label}</button>
      ))}
    </div>
  );
}

/** The × at the end of a row. */
export function ForgetX(props: { host: Host; onClick(): void }) {
  const what = forgetLabel(props.host);
  return (
    <button className="x" title={`${what} ${props.host.label}`} aria-label={`${what} ${props.host.label}`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); props.onClick(); }}>×</button>
  );
}

/** Asks once. The row is gone once it is forgotten, so the list shows the outcome (ForgetDone). */
export function ForgetConfirm(props: { api: VmApi; host: Host; close(): void; done(r: ForgetResult & { hidden: boolean }): void; del?(): void }) {
  const { api, host: h } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const forget = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.forgetHost(h.id);
      props.done({ ...r, hidden: h.source === "ssh-config" });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="forget col" role="alertdialog" aria-label={`${forgetLabel(h)} ${h.label}`}>
      {h.kind === "vm" ? (
        <span><b>{h.label}</b> is a cloud VM blackhole rented. Forgetting it only drops it from this list: the VM keeps running and billing. To stop paying for it, delete it instead.</span>
      ) : h.source === "ssh-config" ? (
        <span>Hide <b>{h.label}</b>? It stays in ~/.ssh/config; the app just stops listing it.</span>
      ) : (
        <span>Forget <b>{h.label}</b>? It leaves this list; the machine itself is not touched. If it is a cloud VM it keeps running and billing until you delete it in your provider's console.</span>
      )}
      {err && <span className="err" role="alert">{err}</span>}
      <div className="row">
        <button className="btn sm" onClick={props.close}>Cancel</button>
        {h.kind === "vm" && props.del && <button className="btn sm dng" disabled={busy} onClick={() => { props.close(); props.del?.(); }}>Delete VM…</button>}
        <button className="btn sm" disabled={busy} onClick={forget}>{forgetLabel(h)}</button>
      </div>
    </div>
  );
}

/** What Forget did, and where a VM that may still exist has to be deleted. */
export function ForgetDone(props: { result: ForgetResult & { hidden: boolean }; close(): void }) {
  const r = props.result;
  return (
    <div className="forget col" role="status">
      <span>{r.hidden ? `${r.label} is hidden. It is still in ~/.ssh/config.` : `Forgot ${r.label}.`}</span>
      {!r.hidden && <Consoles list={r.consoles} />}
      <div className="row"><button className="btn sm" onClick={props.close}>OK</button></div>
    </div>
  );
}

function Consoles(props: { list: { provider: string; url: string }[] }) {
  const list = props.list.length ? props.list : CONSOLES;
  return (
    <span className="dim">
      If it is a cloud VM it is still running and billing. Delete it in {list.length === 1 ? "the console" : "your provider's console"}:{" "}
      {list.map((c, i) => (
        <span key={c.provider}>{i ? ", " : ""}<a href={c.url} target="_blank" rel="noreferrer">{c.provider}</a></span>
      ))}
    </span>
  );
}
