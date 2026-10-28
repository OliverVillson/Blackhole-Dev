"""Built-in function `bench`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork bench`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from blackhole_dev.functions import function


@function("bench", per="job")
def bench(job, release: str = None, models: str = None, limit: int = None, max_tokens: int = None,
          budgets: str = None, file: str = None, rerun: bool = False) -> dict:
    """LiveCodeBench pass@1 (Python-only prompt, verbatim) of the models named in `models`: any
    of original, pruned, healed, int4, reaq, mlx, or a folder path. One sample per problem, up
    to `max_tokens` (reasoning models think for tens of thousands of tokens), the problems new
    in `release` (or your own `file` in LiveCodeBench's jsonl format; `limit` > 0 takes the
    first n). `budgets` also scores thinking budgets by budget forcing (vLLM only; "" = none).
    Each model runs in its own process so the GPU is free between them; a result whose model
    folder and settings did not change is reused (the original once per model and settings,
    across jobs). Writes work/bench.json; the package step puts it on the model card.

    None takes the pipeline's bench knobs (bench "lcb-v6", bench_models, bench_limit,
    bench_max_tokens, bench_budgets, bench_file), so this runs exactly what the pipeline's own
    bench stage would; bench = "none" there (and no release here) skips it."""
    from blackhole_pipeline import bench as lcb
    from blackhole_tui.jobs import home

    p = job.params
    if release is None:
        if p.get("bench", "lcb-v6") in ("", "none"):
            job.emit(pct=100, msg="bench: none")
            return {"skipped": 1}
        release = p["bench"].split("-")[-1] if str(p.get("bench", "")).startswith("lcb") else "v6"
    models = p.get("bench_models", "original,reaq") if models is None else models
    limit = p.get("bench_limit", 0) if limit is None else limit
    max_tokens = p.get("bench_max_tokens", 32768) if max_tokens is None else max_tokens
    budgets = p.get("bench_budgets", "") if budgets is None else budgets
    file = p.get("bench_file", "") if file is None else file

    dirs = {"original": job.model_dir, "pruned": job.pruned_dir, "healed": job.healed_dir, "int4": job.gptq_dir,
            "reaq": job.reaq_dir, "mlx": job.mlx_dir}
    wanted = [m.strip() for m in models.split(",") if m.strip()]
    stamp = getattr(lcb, "model_stamp", None)      # newer pipelines notice a model folder rewritten in place
    has_budgets = "--budgets" in Path(lcb.__file__).read_text()
    res = {}
    for i, label in enumerate(wanted):
        path = Path(dirs[label]) if label in dirs and dirs[label] is not None else Path(label).expanduser()
        if not (path / "config.json").exists():
            raise RuntimeError(f"no model to bench for {label!r} at {path}")
        out = job.path("work", "bench", label if label in dirs else path.name)
        if label == "original":   # the same for every job on this model
            slug = "".join(c if c.isalnum() or c in "-." else "-" for c in str(job.config["model"]))[-80:]
            out = home() / "bench" / f"{slug}-lcb-{release}-{max_tokens}-{limit}"
        old = json.loads((out / "summary.json").read_text()) if (out / "summary.json").exists() else {}
        fresh = (old.get("max_tokens") == max_tokens and (not budgets or not has_budgets or "budgets" in old)
                 and (label == "original" or (old.get("model") == str(path)
                                              and (stamp is None or old.get("model_stamp") == stamp(path)))))
        if rerun or not fresh:
            cmd = [sys.executable, "-u", "-m", "blackhole_pipeline.bench", "--model", str(path), "--out", str(out),
                   "--release", release, "--max-tokens", str(max_tokens), "--stage", job.stage,
                   "--pct", f"{100 * i / len(wanted)},{100 * (i + 1) / len(wanted)}", "--label", label]
            if budgets and has_budgets:
                cmd += ["--budgets", budgets]
            if limit:
                cmd += ["--limit", str(limit)]
            if file:
                cmd += ["--file", file]
            rc = subprocess.call(cmd)
            if rc != 0:
                raise RuntimeError(f"bench of the {label} model failed (exit {rc})")
        res[label] = s = json.loads((out / "summary.json").read_text())
        job.log(f"bench: {label} pass@1 {s['pass@1']:.1%} ({s['problems']} problems), {s.get('tok_s', 0):.0f} tok/s"
                + ("; budgets " + ", ".join(f"{b} {v['pass@1']:.1%}" for b, v in s["budgets"].items())
                   if s.get("budgets") else ""))
    first = res[wanted[0]]
    summary = {"bench": first["bench"], "problems": first["problems"], "runs": res,
               **{m: r["pass@1"] for m, r in res.items()}, "tok_s": {m: r.get("tok_s") for m, r in res.items()}}
    others = [m for m in res if m != "original"]
    if "original" in res and others and res["original"]["pass@1"]:
        summary["retained"] = round(res[others[-1]]["pass@1"] / res["original"]["pass@1"], 4)
    job.write("work/bench.json", summary)
    job.path(".done", "package").unlink(missing_ok=True)   # the model card picks the result up
    out = {f"lcb_{m}": r["pass@1"] for m, r in res.items()}
    last = res[wanted[-1]]
    out.update({f"lcb_budget_{b}": v["pass@1"] for b, v in (last.get("budgets") or {}).items()})
    if (last.get("thinking") or {}).get("median") is not None:
        out["think_median"] = last["thinking"]["median"]
    return {"problems": summary["problems"], **out, **({"retained": summary["retained"]} if "retained" in summary else {})}
