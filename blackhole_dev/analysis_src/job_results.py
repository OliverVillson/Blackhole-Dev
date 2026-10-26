"""Built-in analysis `job-results`: KL, stage results and bench scores from a job folder."""

from pathlib import Path

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import find_job, read_events


@analysis("job-results", title="Job results", needs="none", group="jobs")
def run(r, m, folder: str = ""):
    """Reads a job folder (on this machine: a pulled job, or ~/.blackhole/jobs/<job> copied
    back) or a model folder the app pulled: events.log (held-out KL per step, what each stage
    reported), bench summary.json files (LiveCodeBench pass@1 by difficulty) and the anatomy
    receipt. Leave `folder` empty to use the open model's folder."""
    folder = folder or (str(m.root) if m is not None and getattr(m, "root", None) else "")
    if not folder:
        raise ValueError("give a job folder (or open a model folder first)")
    j = find_job(folder)
    tiles = []
    if j["events"]:
        ev = read_events(j["events"])
        if ev["kl"]:
            stages = []
            for p in ev["kl"]:
                if p["stage"] not in stages:
                    stages.append(p["stage"])
            steps = sorted({p["step"] for p in ev["kl"]})
            r.line("Held-out KL", steps,
                   {s: [next((p["kl"] for p in ev["kl"] if p["stage"] == s and p["step"] == st), None) for st in steps]
                    for s in stages}, xlabel="step", ylabel="KL")
            best = min(ev["kl"], key=lambda p: p["kl"])
            tiles.append(("Best held-out KL", best["kl"], f"{best['stage']} step {best['step']}"))
        for k in ("kl", "top1", "size_gb", "tok_s"):
            if k in ev["metrics"]:
                tiles.append((k, ev["metrics"][k]))
        r.table("Stages", ["stage", "status", "result"],
                [[s["stage"], s["status"], ", ".join(f"{k} {v}" for k, v in s["result"].items())] for s in ev["stages"]])
    else:
        r.text(f"No events.log in {folder}.")
    for b in j["bench"]:
        tiles.append((f"{b.get('bench', 'bench')} pass@1", b["pass@1"], f"{b.get('problems', '?')} problems, {b['name']}"))
        by = b.get("by_difficulty") or {}
        if by:
            r.bar(f"pass@1 by difficulty, {b['name']}", list(by), {"pass@1": [v["pass@1"] for v in by.values()]},
                  ylabel="pass@1")
    if len(j["bench"]) > 1:
        r.bar("pass@1 by bench run", [b["name"] for b in j["bench"]], {"pass@1": [b["pass@1"] for b in j["bench"]]},
              ylabel="pass@1")
    rec = j["receipt"]
    if rec:
        tiles.append(("Edits in receipt", len(rec.get("edits") or []), f"base {rec.get('base')}"))
        before, after = rec.get("before") or {}, rec.get("after") or {}
        if before and after:
            gs = sorted(set(before) | set(after))
            r.bar("Size before and after (GB)", gs, {"before": [before.get(g, {}).get("gb", 0) for g in gs],
                                                     "after": [after.get(g, {}).get("gb", 0) for g in gs]}, ylabel="GB")
    if tiles:
        r.tiles(tiles)
    r.title(f"Job results · {Path(folder).name}")
