"""Built-in function `external-bench`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork external-bench`, or Fork
in the app's Functions view) to get your own copy in your functions folder; a function there
with the same name replaces this one everywhere, a renamed fork sits next to it. The shared
code of the benchmark functions is blackhole_dev/functions_src/_bench.py."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _bench


@function("external-bench", per="job")
def external_bench(job, command: str = "", preset: str = "generic", model: str = "final", serve: str = "",
                   serve_args: str = "", url: str = "", served_model: str = "", workers: int = 8,
                   tasks: str = "smoke", result: str = "", score_key: str = "", regex: str = "", name: str = "",
                   timeout_h: float = 48.0) -> dict:
    """Runs another benchmark harness (SWE-bench Pro, LiveCodeBench, lm-eval, Aider, your own
    script) on the model and reads its score back.

    `model`: "final" (default) is the job's last artefact: a vLLM HEX folder (hex-vllm), else the
    MLX export (for vLLM only one with HEX experts), else int4, healed, pruned, the original;
    or a name (original pruned healed int4 reaq mlx hex latest) or a folder path.
    `command` is a shell command; these placeholders are filled in (shell-quoted):
      {url}      the OpenAI-compatible base URL (".../v1") the harness should call
      {model}    the model name to send in requests      {model_dir}  the model folder
      {out}      a folder for this run's outputs (work/external/<name>/)
      {workers}  `workers`   {tasks}  `tasks`   {job}  the job folder   {name}  `name` (default: the preset)
      {run}      <job folder name>-<name>, unique per job   {port}  a free local port
      {script}   the preset's BlackHole-Harness script on this machine   {bh_home}  ~/.blackhole
    With serve = "vllm" (GPU VM) or "mlx" (Mac) the model is served for the length of the
    command, or point `url` at a server that is already up. The score: `result` (a file
    under {out}, or a path) read as JSON, by `score_key` (a.b.c) when set, else as a map of
    instance -> resolved true/false, else its resolved_rate / pass@1 / accuracy / score; with
    no result file, the last `regex` match in the command's output. `preset` fills the
    defaults: "swebench-pro" runs BlackHole-Harness's harness/scripts/swebench-pro.sh on the
    model folder (`tasks`: smoke = 20 tasks, about 1 h on a B300; hard = 51; all = 642, about
    10 to 14 h; or a number). It serves the model itself with vLLM, needs Docker (the script
    installs it when sudo needs no password) and so runs on the GPU VM; its run folder is
    ~/.blackhole/swebench/runs/<run> and rerunning the step resumes it. "generic" reads
    `pass@1: 41%`-style lines. The command's output is kept in {out}/run.log; an empty command
    skips the step. Writes work/external-<name>.json (and the per-task results.json under {out})."""
    if preset not in _bench.PRESETS:
        raise ValueError(f"preset must be one of {', '.join(_bench.PRESETS)}, not {preset!r}")
    pre = _bench.PRESETS[preset]
    command = command or pre["command"]
    if not command.strip():
        job.emit(pct=100, msg="external-bench: no command, skipped")
        return {"skipped": 1}
    result = result or pre["result"]
    regex = regex or pre["regex"]
    name = name or preset
    run_name = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{Path(job.root).name}-{name}")
    if pre["serves_itself"]:
        serve = ""          # the harness starts its own server
    label, path = _bench.resolve(job, model, mlx_ok=not pre.get("vllm") and serve != "vllm") \
        if not url else (served_model or "endpoint", None)
    script = str(_bench.harness_script(pre["script"])) if pre.get("script") and "{script}" in command else ""
    out = job.path("work", "external", name)
    out.mkdir(parents=True, exist_ok=True)
    logf = out / "run.log"
    rundir = _bench.bh_home() / "swebench" / "runs" / run_name
    job.log(f"external-bench: {name} on {label} ({path or url})")

    def watch(stop: threading.Event, started: float) -> None:
        """Progress in the job monitor while the harness runs (SWE-bench Pro: tasks done)."""
        while not stop.wait(60):
            mins = (time.time() - started) / 60
            prog = _bench.swebench_progress(rundir) if preset == "swebench-pro" else None
            if prog:
                total, done, regraded = prog
                pct = 10 + 85 * (0.85 * done + 0.15 * regraded) / max(total, 1)
                msg = f"{name}: {done}/{total} tasks run" + (f", {regraded} re-graded" if regraded else "") + f" ({mins:.0f} min)"
            else:
                pct, msg = 10, f"{name}: running on {label} ({mins:.0f} min)"
            job.emit(pct=round(pct, 1), msg=msg)

    def run(base: str, mname: str) -> str:
        cmd = _bench.fill(command, url=base, model=mname, model_dir=str(path or ""), out=str(out),
                          workers=workers, tasks=tasks, job=str(job.root), name=name, run=run_name,
                          port=_bench.free_port(), script=script, bh_home=str(_bench.bh_home()))
        job.log(f"external-bench: {cmd}")
        job.emit(pct=10, msg=f"{name}: running the harness on {label}")
        env = {**os.environ, "OPENAI_BASE_URL": base, "OPENAI_API_BASE": base,
               "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", "EMPTY")}
        stop = threading.Event()
        t = threading.Thread(target=watch, args=(stop, time.time()), daemon=True)
        old = signal.getsignal(signal.SIGTERM)
        # a stop of the job (SIGTERM) ends the harness and everything it started (vLLM, Harbor)
        def on_term(*_):
            raise SystemExit(143)
        signal.signal(signal.SIGTERM, on_term)
        with open(logf, "w") as f:
            p = subprocess.Popen(cmd, shell=True, cwd=out, env=env, stdout=f, stderr=subprocess.STDOUT,  # noqa: S602
                                 start_new_session=True)
            t.start()
            try:
                rc = p.wait(timeout=timeout_h * 3600)
            except subprocess.TimeoutExpired:
                raise RuntimeError(f"{name} ran past timeout_h={timeout_h} h and was stopped; rerun the step to resume") from None
            finally:
                stop.set()
                signal.signal(signal.SIGTERM, old)
                _bench.stop(p)
        text = logf.read_text(errors="ignore")
        if rc != 0:
            raise RuntimeError(f"{name} harness failed (exit {rc}); last output:\n{text[-2000:]}")
        return text

    if url or not serve:
        text = run(url, served_model or label)
    else:
        with _bench.serving(serve, path, label, serve_args, log_path=out / f"{serve}.log") as (base, _):
            mname = (_bench.served_models(base) or [label])[0]
            text = run(base, mname)

    score, details = None, {}
    rfile = Path(result.format(name=name, out=out, run=run_name, bh_home=_bench.bh_home())).expanduser() if result else None
    if rfile is not None and not rfile.is_absolute():
        rfile = out / rfile
    if rfile is not None and rfile.is_file():
        score, details = _bench.score_from_json(json.loads(rfile.read_text()), score_key)
        details["result"] = str(rfile)
        for f in (rfile, rfile.with_name(rfile.stem + ".summary.json")):   # keep a copy with the job
            if f.is_file() and f.parent != out:
                shutil.copy2(f, out / f.name)
        summ = rfile.with_name(rfile.stem + ".summary.json")
        if summ.is_file():
            errs = json.loads(summ.read_text()).get("errors")
            if isinstance(errs, int):
                details["errors"] = errs
    if score is None and regex:
        score = _bench.score_from_text(text, regex)
        details["from"] = "output"
    if score is None:
        raise RuntimeError(f"{name}: no score found (no readable {result or 'result file'} under {out}, "
                           f"and nothing in the output matched {regex!r}); see {logf}")
    res = {"bench": name, "preset": preset, "model": label, "model_dir": str(path or ""), "tasks": tasks,
           pre["metric"]: score, "score": score, **details}
    job.write(f"work/external-{name}.json", res)
    job.log(f"external-bench: {name} on {label}: {score:.1%}")
    return {k: v for k, v in res.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
