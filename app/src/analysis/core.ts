// Analysis runs and model forks, with the confirm gate in front of anything expensive.
// Main calls these itself (a renderer that skips a dialog still meets the gate).
//
// A named analysis says up front what it will read (analysis.estimate). Over the limit, the
// user is asked once; approved, it runs with no budget. Under it, or when the read is unknown
// (a script), it runs with the limit as a read budget: the helper stops BEFORE the read that
// would pass it (-32004), and only then is the user asked, and the run repeated.

import type { ConfirmRequest } from "../shared/gate";
import { fmtBytes, fmtSeconds, type AnalysisSettings, type Estimate, type ForkRequest, type Report, type RunOutcome, type RunRequest } from "./shared";

export const READ_BUDGET = -32004;
export const RUN_TIMEOUT_MS = 30 * 60_000;

export interface Deps {
  call<T = unknown>(method: string, params?: object, timeoutMs?: number): Promise<T>;
  confirm(req: ConfirmRequest): Promise<boolean>;
  settings(): AnalysisSettings;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function what(req: RunRequest): string {
  return req.name ?? (req.path ? req.path.split(/[\\/]/).pop()! : "analysis");
}

function limitFor(est: Pick<Estimate, "remote">, s: AnalysisSettings): number {
  return est.remote ? s.remoteConfirmMb * 1e6 : s.confirmGb * 1e9;
}

function ask(deps: Deps, req: RunRequest, est: Estimate | null, why: string, bytes: number | null): Promise<boolean> {
  const remote = !!est?.remote;
  const details = [
    { label: "Analysis", value: what(req) },
    { label: "Model", value: est?.model?.name ?? req.model ?? "the open model" },
    { label: remote ? "Downloads" : "Reads", value: bytes == null ? "more than the limit" : `~${fmtBytes(bytes)}` },
  ];
  if (est?.seconds != null && bytes != null) details.push({ label: "Takes", value: fmtSeconds(est.seconds) });
  return deps.confirm({
    action: remote ? "download" : "compute.local",
    title: remote ? `Download weights for ${what(req)}` : `Read ${bytes == null ? "a lot of" : fmtBytes(bytes) + " of"} weights`,
    why,
    details,
    requestedBy: req.requestedBy ?? "user",
  });
}

export async function runAnalysis(deps: Deps, req: RunRequest): Promise<RunOutcome> {
  const params = { name: req.name, path: req.path, text: req.text, model: req.model, params: req.params ?? {} };
  let est: Estimate | null = null;
  try {
    est = await deps.call<Estimate>("analysis.estimate", params);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const limit = limitFor(est, deps.settings());
  let budget: number | undefined = limit;
  let approved = false;
  if (est.known && est.bytes != null && est.bytes > limit) {
    const why = est.remote
      ? `This model is read in place on the Hugging Face Hub, so ${what(req)} downloads the weights it reads.`
      : `${what(req)} reads more than your ${deps.settings().confirmGb} GB limit (Settings > Analysis).`;
    if (!(await ask(deps, req, est, why, est.bytes))) return { ok: false, cancelled: true, reason: "not approved" };
    budget = undefined;
    approved = true;
  }
  const once = (b: number | undefined) => deps.call<Report>("analysis.run", { ...params, budget: b }, RUN_TIMEOUT_MS);
  try {
    return { ok: true, report: await once(budget), estimate: est, approved };
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== READ_BUDGET) return { ok: false, error: errText(e) };
    const why = `${what(req)} did not say up front how much it reads, and it stopped before passing ${fmtBytes(limit)}. Allow it to read as much as it needs?`;
    if (!(await ask(deps, req, est, why, null))) return { ok: false, cancelled: true, reason: "not approved" };
    try {
      return { ok: true, report: await once(undefined), estimate: est, approved: true };
    } catch (e2) {
      return { ok: false, error: errText(e2) };
    }
  }
}

export interface ForkPlan { src: string; files: number; weightBytes: number; copyBytes: number; mode: string }

export async function forkModel(deps: Deps, req: ForkRequest): Promise<{ ok: true; path: string; name: string; mode: string } | { ok: false; error?: string; cancelled?: boolean }> {
  try {
    const mode = req.mode ?? "link";
    const plan = await deps.call<ForkPlan>("model.forkPlan", { src: req.src, mode });
    if (plan.copyBytes > deps.settings().confirmGb * 1e9) {
      const ok = await deps.confirm({
        action: "compute.local",
        title: `Copy ${fmtBytes(plan.copyBytes)} to fork this model`,
        why: "A copy fork duplicates every weight file. A linked fork (the default) costs no disk and is safe for edits made in the app.",
        details: [{ label: "From", value: req.src }, { label: "Name", value: req.name ?? "(next free name)" }],
        requestedBy: req.requestedBy ?? "user",
      });
      if (!ok) return { ok: false, cancelled: true };
    }
    const r = await deps.call<{ path: string; name: string; mode: string }>("model.fork", { src: req.src, name: req.name, mode, note: req.note }, RUN_TIMEOUT_MS);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** A new analysis script, ready to edit and run (Analysis: New script). */
export function scriptTemplate(name: string): string {
  return `"""${name}: describe what this analysis shows."""

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, sampled_stats


def _cost(m, sample=128):
    # bytes this will read, so the app can ask before a big read (leave cost=None if unsure:
    # the app then holds the run to your read limit and asks only if it gets there)
    return sum(cost(L.moe.experts if L.moe else [x for x in (L.mlp,) if x], sample) for L in m.layers)


@analysis("${name}", title="${name}", needs="weights", cost=_cost)
def run(r, m, sample: int = 128):
    """RMS of each layer's feed-forward weights. r.line / r.bar / r.hist / r.heatmap /
    r.scatter / r.table / r.tiles / r.text / r.figure(matplotlib) draw in the app."""
    xs, ys = [], []
    for L in m.layers:
        r.progress(f"layer {L.index}", L.index / len(m.layers))
        xs.append(L.index)
        ys.append(sampled_stats(L.moe.experts if L.moe else [x for x in (L.mlp,) if x], sample)["rms"])
    r.line("Feed-forward RMS by layer", xs, {"rms": ys}, xlabel="layer", ylabel="RMS")
    r.tiles([("Layers", len(xs)), ("Largest RMS", max(ys))])
`;
}
