"""Built-in function `external-bench`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork external-bench`, or Fork
in the app's Functions view) to get your own copy in your functions folder; a function there
with the same name replaces this one everywhere, a renamed fork sits next to it. The shared
code of the benchmark functions is blackhole_dev/functions_src/_bench.py."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _bench


@function("external-bench", per="job")
def external_bench(job, command: str = "", preset: str = "generic", model: str = "latest", serve: str = "",
                   serve_args: str = "", url: str = "", served_model: str = "", workers: int = 8,
                   result: str = "", score_key: str = "", regex: str = "", name: str = "",
                   timeout_h: float = 48.0) -> dict:
    """Runs another benchmark harness (SWE-bench Pro, LiveCodeBench, lm-eval, Aider, your own
    script) on the model and reads its score back.

    `command` is a shell command; these placeholders are filled in (shell-quoted):
      {url}      the OpenAI-compatible base URL (".../v1") the harness should call
      {model}    the model name to send in requests      {model_dir}  the model folder
      {out}      a folder for this run's outputs (work/external/<name>/)
      {workers}  `workers`        {job}  the job folder        {name}  `name` (default: the preset)
    With serve = "vllm" (GPU VM) or "mlx" (Mac) the model is served for the length of the
    command, or point `url` at a server that is already up. The score: `result` (a file
    under {out}, or a path) read as JSON, by `score_key` (a.b.c) when set, else as a map of
    instance -> resolved true/false, else its resolved_rate / pass@1 / accuracy / score; with
    no result file, the last `regex` match in the command's output. `preset` fills the
    defaults: "swebench-pro" runs BlackHole-Harness's harness/scripts/swebench-pro.sh on the
    model folder (the smoke task set unless you give your own command; it serves the model
    itself and needs Docker, so the GPU VM) and reads the share resolved from its
    runs/<name>/results.json; "generic" reads `pass@1: 41%`-style lines. The
    command's output is kept in {out}/run.log; an empty command skips the step. Writes work/external-<name>.json."""
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
    if pre["serves_itself"]:
        serve = ""          # the harness starts its own server
    label, path = _bench.resolve(job, model) if not url else (served_model or "endpoint", None)
    out = job.path("work", "external", name)
    out.mkdir(parents=True, exist_ok=True)
    logf = out / "run.log"

    def run(base: str, mname: str) -> str:
        cmd = _bench.fill(command, url=base, model=mname, model_dir=str(path or ""), out=str(out),
                          workers=workers, job=str(job.root), name=name)
        job.log(f"external-bench: {cmd}")
        job.emit(pct=10, msg=f"{name}: running the harness on {label}")
        env = {**os.environ, "OPENAI_BASE_URL": base, "OPENAI_API_BASE": base,
               "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", "EMPTY")}
        with open(logf, "w") as f:
            p = subprocess.run(cmd, shell=True, cwd=out, env=env, stdout=f, stderr=subprocess.STDOUT,  # noqa: S602
                               timeout=timeout_h * 3600)
        text = logf.read_text(errors="ignore")
        if p.returncode != 0:
            raise RuntimeError(f"{name} harness failed (exit {p.returncode}); last output:\n{text[-2000:]}")
        return text

    if url or not serve:
        text = run(url, served_model or label)
    else:
        with _bench.serving(serve, path, label, serve_args, log_path=out / f"{serve}.log") as (base, _):
            mname = (_bench.served_models(base) or [label])[0]
            text = run(base, mname)

    score, details = None, {}
    rfile = Path(result.format(name=name, out=out)).expanduser() if result else None
    if rfile is not None and not rfile.is_absolute():
        rfile = out / rfile
    if rfile is not None and rfile.is_file():
        score, details = _bench.score_from_json(json.loads(rfile.read_text()), score_key)
        details["result"] = str(rfile)
    if score is None and regex:
        score = _bench.score_from_text(text, regex)
        details["from"] = "output"
    if score is None:
        raise RuntimeError(f"{name}: no score found (no readable {result or 'result file'} under {out}, "
                           f"and nothing in the output matched {regex!r}); see {logf}")
    res = {"bench": name, "preset": preset, "model": label, pre["metric"]: score, "score": score, **details}
    job.write(f"work/external-{name}.json", res)
    job.log(f"external-bench: {name} on {label}: {score:.1%}")
    return {k: v for k, v in res.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
