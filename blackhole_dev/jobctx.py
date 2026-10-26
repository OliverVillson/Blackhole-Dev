"""Job functions: pipeline stages as named, forkable functions.

A job function (per="job") is a GPU stage of the BlackHole pipeline (traces, distil, qheal,
bench, ...) written as an ordinary Python function on a Job:

    from blackhole_dev import function

    @function("my-distil", per="job")
    def my_distil(job, minutes: int = 60) -> dict:
        job.emit(pct=0, msg="starting")
        return job.run_stage("heal", heal_minutes=minutes)

A recipe step `recipe.fn("my-distil", minutes=90)` compiles to a `job.fn` stage; the pipeline
(blackhole_pipeline, the free product) runs it as its own process through the `blackhole.jobfn`
entry point, which is this module:

    python -m blackhole_dev.jobctx --job <job> --stage <stage id>

The process reads the stage from <job>/recipe/recipe.json, loads the bundle's functions/ (they
win over the user folder and the built-ins, see blackhole_dev.functions), calls the function,
relays its JSON events as the stage, evaluates the stage's gates and marks the stage done in
<job>/reaper/.done/<id>. Exit codes: 0 done, 1 error, 3 a gate failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

RESERVED = {"id", "kind", "fn", "needs", "gates", "when", "always"}


class Job:
    """A pipeline job directory on the VM, as job functions see it.

    job.params      the pipeline's run knobs (blackhole_pipeline.DEFAULTS after the job config)
    job.config      <job>/config.json
    job.rj          REAPer's job inside it (data/, work/, out/, .done/)
    job.model_dir   the original model;  job.pruned_dir, job.healed_dir, job.gptq_dir, job.reaq_dir
    job.mlx_dir     the MLX folder the mlx / qheal stages wrote (work/mlx.json), or None
    job.emit(...)   a progress event for this stage;  job.log(msg) a log line
    job.set(**k)    change run knobs (kept in config.json, like a schema step's params)
    job.run_stage(name, **knobs)   run one of the pipeline's own stage processes
    job.call(name, **params)       run another job function (a fork of it wins, as everywhere)
    """

    def __init__(self, root: str | Path, stage: str = "job"):
        from blackhole_pipeline.job import BHJob
        self.root = Path(root).resolve()
        self.stage = stage
        self.functions: dict[str, str] = {}
        self._pct = (0.0, 100.0)
        self._load(BHJob)

    def _load(self, BHJob=None) -> None:
        if BHJob is None:
            from blackhole_pipeline.job import BHJob
        self.bh = BHJob(self.root)
        self.rj = self.bh.reaper()

    # ------------------------------------------------------------------ what is there
    @property
    def params(self) -> dict:
        return self.bh.params

    @property
    def config(self) -> dict:
        return self.bh.config

    @property
    def model_dir(self) -> Path:
        return self.rj.model_dir

    @property
    def pruned_dir(self) -> Path:
        return self.rj.out_dir

    @property
    def healed_dir(self) -> Path:
        return self.bh.healed_dir(self.rj)

    @property
    def gptq_dir(self) -> Path:
        return self.bh.gptq_dir(self.rj)

    @property
    def reaq_dir(self) -> Path:
        return self.bh.reaq_dir(self.rj)

    @property
    def mlx_dir(self) -> Path | None:
        out = (self.rj.read("work/mlx.json") or {}).get("out")
        return Path(out) if out else None

    def path(self, *parts) -> Path:
        return self.rj.path(*parts)

    def read(self, rel: str):
        return self.rj.read(rel)

    def write(self, rel: str, obj) -> None:
        self.rj.write(rel, obj)

    def is_done(self, stage: str) -> bool:
        return self.rj.is_done(stage)

    # ------------------------------------------------------------------ events
    def emit(self, status: str = "running", pct: float | None = None, msg: str = "", **extra) -> None:
        from blackhole_pipeline.common import emit
        emit(self.stage, status, pct, msg, **extra)

    def log(self, msg: str) -> None:
        print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)

    # ------------------------------------------------------------------ knobs and stages
    def call(self, name: str, **params):
        """Run another job function by name (whichever definition wins: a fork of it if you have one)."""
        from blackhole_dev.functions import call_job
        return call_job(self, name, **params)

    def set(self, **knobs) -> list[str]:
        """Write run knobs into the job config (they hold for the later stages too, the same as a
        schema step's params). A knob the installed pipeline does not know is refused unless it
        is None (None = leave it alone). Returns the knobs that changed."""
        from blackhole_pipeline import DEFAULTS
        knobs = {k: v for k, v in knobs.items() if v is not None}
        unknown = [k for k in knobs if k not in DEFAULTS and not _reaper_field(k)]
        if unknown:
            raise ValueError(f"the installed blackhole_pipeline has no knob {', '.join(sorted(unknown))}: "
                             "update BlackHole-Harness on the VM, or leave them out")
        cfg_p = self.root / "config.json"
        raw = json.loads(cfg_p.read_text())
        changed = [k for k, v in knobs.items() if raw.get(k, self.params.get(k)) != v]
        if changed:
            raw.update({k: knobs[k] for k in changed})
            tmp = cfg_p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(raw, indent=2) + "\n")
            os.replace(tmp, cfg_p)
            rcfg = self.rj.root / "config.json"
            reaper = [k for k in changed if _reaper_field(k)]
            if reaper and rcfg.exists():   # REAPer's own settings (calib, max_seq, ...) live in its config
                r = json.loads(rcfg.read_text())
                r.update({k: knobs[k] for k in reaper})
                rcfg.write_text(json.dumps(r, indent=2) + "\n")
            self._load()
        return changed

    def run_stage(self, name: str, fresh: bool = False, pct: tuple[float, float] = (0.0, 100.0), **knobs) -> dict:
        """Run one of the pipeline's stage processes (detect, calibrate, reap, eval, heal, gptq,
        reaq, mlx, qheal, bench, quant, package) with these knobs, in its own process so the GPU
        is free afterwards. Its events are relayed as this stage's progress, scaled into `pct`.
        The stage runs again when the knobs changed, `fresh` is set, or it never finished.
        Returns what it wrote to work/<stage>.json (or its done mark)."""
        from blackhole_pipeline import PROCESSES
        proc = next((p for p in PROCESSES if p[0] == name or name in p[1]), None)
        if proc is None:
            raise ValueError(f"no pipeline stage {name!r} (have {', '.join(p[0] for p in PROCESSES)})")
        pname, stages, who = proc
        changed = self.set(**knobs)
        if fresh or changed:
            for s in stages:
                self.rj.path(".done", s).unlink(missing_ok=True)
        if not all(self.rj.is_done(s) for s in stages):
            self._relay(pname, who, pct)
            missing = [s for s in stages if not self.rj.is_done(s)]
            if missing:
                raise RuntimeError(f"pipeline stage {pname} ended without finishing {', '.join(missing)}")
        out = dict(self.rj.read(f"work/{pname}.json") or {})
        for s in stages:
            out.update(self.rj.read(f"work/{s}.json") or _done_info(self.rj, s))
        return out

    def _relay(self, pname: str, who: str, pct: tuple[float, float]) -> None:
        if who == "reaper":
            py = os.environ.get("REAPER_VLLM_PY") if pname == "calibrate" else None
            cmd = [py or sys.executable, "-u", "-m", f"reaper_pipeline.stages.{pname}", "--job", str(self.rj.root)]
        else:
            cmd = [sys.executable, "-u", "-m", f"blackhole_pipeline.stages.{pname}", "--job", str(self.root)]
        env = {k: str(v) for k, v in ((self.rj.read("plan.json") or {}).get("env") or {}).items()}
        a, b = pct
        tail: list[str] = []
        with open(self.rj.path("logs", f"{pname}.log"), "a") as logf:
            logf.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(cmd)} (job fn {self.stage})\n")
            child = subprocess.Popen(cmd, env={**os.environ, **env, "PYTHONUNBUFFERED": "1"}, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace")
            assert child.stdout
            for line in child.stdout:
                logf.write(line)
                logf.flush()
                ev = _event(line)
                if ev is None:
                    sys.stdout.write(line)
                    tail = (tail + [line.rstrip()])[-30:]
                    continue
                inner = ev.pop("stage", pname)
                status = ev.pop("status", "running")
                p = ev.pop("pct", None)
                msg = ev.pop("msg", "")
                ev.pop("ts", None)
                if status == "error":
                    self.emit("running", None, f"{inner}: {msg}", **ev)
                    continue
                self.emit("running", None if p is None else a + (b - a) * p / 100, f"{inner}: {msg}" if msg else inner,
                          **ev)
            rc = child.wait()
        if rc != 0:
            last = next((t for t in reversed(tail) if "Error" in t or "Exception" in t), tail[-1] if tail else "")
            raise RuntimeError(f"pipeline stage {pname} failed (exit {rc}): {last[:300]}")


def _event(line: str) -> dict | None:
    line = line.strip()
    if not (line.startswith("{") and line.endswith("}")):
        return None
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    return ev if isinstance(ev, dict) and "stage" in ev and "status" in ev else None


def _done_info(rj, stage: str) -> dict:
    p = rj.path(".done", stage)
    try:
        return json.loads(p.read_text() or "{}")
    except (OSError, ValueError):
        return {}


def _reaper_field(name: str) -> bool:
    try:
        from dataclasses import fields

        from reaper_pipeline.job import Config
    except ImportError:
        return False
    return name in {f.name for f in fields(Config)}


# ---------------------------------------------------------------------- the job.fn stage process

_REF = re.compile(r"\$\{inputs\.([A-Za-z0-9_]+)\}")


def _stage_spec(root: Path, stage: str) -> tuple[dict, dict]:
    """(the stage table, input values) from the job's compiled recipe."""
    rec = root / "recipe" / "recipe.json"
    if not rec.exists():
        raise FileNotFoundError(f"{rec} missing: a job.fn stage runs from a recipe bundle (--recipe)")
    compiled = json.loads(rec.read_text())
    raw = compiled.get("raw", compiled)
    st = next((s for s in raw.get("stage", []) if s.get("id") == stage), None)
    if st is None:
        raise KeyError(f"recipe has no stage {stage!r}")
    inputs = {k: v.get("default") for k, v in (raw.get("inputs") or {}).items() if isinstance(v, dict)}
    cfg = json.loads((root / "config.json").read_text()) if (root / "config.json").exists() else {}
    inputs.update(cfg.get("inputs") or {})
    return st, inputs


def _subst(v, inputs: dict):
    if isinstance(v, str):
        m = _REF.fullmatch(v)
        if m:
            return inputs[m.group(1)]
        return _REF.sub(lambda x: str(inputs[x.group(1)]), v)
    if isinstance(v, list):
        return [_subst(x, inputs) for x in v]
    if isinstance(v, dict):
        return {k: _subst(x, inputs) for k, x in v.items()}
    return v


def gates_failed(gates: list, metrics: dict) -> list[str]:
    ops = {"<=": lambda a, b: a <= b, "<": lambda a, b: a < b, ">=": lambda a, b: a >= b, ">": lambda a, b: a > b,
           "==": lambda a, b: a == b, "!=": lambda a, b: a != b}
    bad = []
    for g in gates or []:
        m, op, val = g.get("metric"), g.get("op", "<="), g.get("value")
        got = metrics.get(m)
        if got is None or op not in ops or not ops[op](got, val):
            bad.append(f"{m} {op} {val} (got {got})")
    return bad


def run(root: str | Path, stage: str) -> int:
    from blackhole_dev import functions as fns
    root = Path(root).resolve()
    spec, inputs = _stage_spec(root, stage)
    name = spec["fn"]
    params = _subst({k: v for k, v in spec.items() if k not in RESERVED}, inputs)
    params.update(params.pop("args", {}) if isinstance(params.get("args"), dict) else {})
    fdir = root / "recipe" / "functions"
    for p in sorted(fdir.glob("*.py")) if fdir.is_dir() else []:
        fns.load(str(p))
    job = Job(root, stage)
    f = fns.get(name)
    job.emit("running", 0, f"{name} ({fns.LAYERS[f.layer]}{', ' + Path(f.path).name if f.path else ''})")
    out = fns.call_job(job, name, **params)
    metrics = {k: v for k, v in (out or {}).items() if isinstance(v, (int, float, str, bool))} \
        if isinstance(out, dict) else {}
    bad = gates_failed(spec.get("gates"), metrics)
    job.write(f"work/fn-{stage}.json", {"fn": name, "sha256": f.sha256, "params": params,
                                      "result": out if isinstance(out, dict) else None})
    if bad:
        job.emit("done", 100, "gate failed: " + "; ".join(bad), gate="failed", **metrics)
        return 3
    job.rj.mark_done(stage, {"fn": name, **metrics})
    job.emit("done", 100, ", ".join(f"{k} {v}" for k, v in list(metrics.items())[:4]) or name, **metrics)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--job", required=True)
    ap.add_argument("--stage", required=True, help="the recipe stage id")
    a = ap.parse_args(argv)
    try:
        return run(a.job, a.stage)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(json.dumps({"stage": a.stage, "status": "error", "msg": f"{type(e).__name__}: {e}"[:400],
                          "ts": round(time.time(), 3)}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
