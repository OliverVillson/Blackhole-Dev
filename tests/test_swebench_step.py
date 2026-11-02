"""external-bench with preset="swebench-pro" as a recipe step after a build: which model it
benchmarks ("final"), the BlackHole-Harness script it finds, the per-job run name it passes, where
the results land, progress while it runs, and a stop that ends the script."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from blackhole_dev.functions_src import _bench

FAKE_SCRIPT = r"""#!/usr/bin/env bash
# stands in for harness/scripts/swebench-pro.sh: records its arguments, writes what the real one writes
set -e
echo "$@" > "$ARGS_FILE"
MODEL=$1; shift
while [ $# -gt 0 ]; do case "$1" in --name) NAME=$2; shift;; --tasks) TASKS=$2; shift;; esac; shift; done
RUN=${BLACKHOLE_HOME}/swebench/runs/$NAME
mkdir -p "$RUN/jobs/$NAME/t1" "$RUN/jobs/$NAME/t2"
printf 'a\nb\nc\nd\n' > "$RUN/ids.txt"
echo '{}' > "$RUN/jobs/$NAME/t1/result.json"; echo '{}' > "$RUN/jobs/$NAME/t2/result.json"
if [ -n "$SLEEP" ]; then sleep "$SLEEP" & echo $! > "$ARGS_FILE.pid"; wait; fi
echo '{"a": true, "b": false, "c": true, "d": false}' > "$RUN/results.json"
echo '{"resolved": 2, "total": 4, "errors": 1}' > "$RUN/results.summary.json"
echo "2/4 resolved (50.0%), 1 errored"
"""


class FakeJob:
    """What external-bench uses of blackhole_dev.jobctx.Job."""

    def __init__(self, root: Path, dirs: dict):
        self.root = root
        self.rj_root = root / "reaper"
        (self.rj_root / "work").mkdir(parents=True, exist_ok=True)
        (root / "out").mkdir(exist_ok=True)
        self.dirs = dirs
        self.events: list[dict] = []

    def __getattr__(self, k):
        m = {"model_dir": "original", "pruned_dir": "pruned", "healed_dir": "healed", "gptq_dir": "int4",
             "reaq_dir": "reaq", "mlx_dir": "mlx"}
        if k in m:
            return self.dirs.get(m[k], self.root / "nope" / k)
        raise AttributeError(k)

    def path(self, *parts):
        return self.rj_root.joinpath(*parts)

    def read(self, rel):
        p = self.rj_root / rel
        return json.loads(p.read_text()) if p.exists() else None

    def write(self, rel, obj):
        (self.rj_root / rel).write_text(json.dumps(obj))

    def emit(self, status="running", pct=None, msg="", **extra):
        self.events.append({"pct": pct, "msg": msg})

    def log(self, msg):
        pass


def _folder(p: Path, cfg: dict) -> Path:
    p.mkdir(parents=True)
    (p / "config.json").write_text(json.dumps(cfg))
    return p


@pytest.fixture
def built(tmp_path):
    """A job after REAP + heal + int4 + an MLX export, with model folders as the pipeline names them."""
    j = tmp_path / "jobs" / "qwen-next-reapq-1102-1030"
    dirs = {"original": _folder(tmp_path / "base", {}),
            "pruned": _folder(j / "reaper" / "out" / "m-REAP25", {}),
            "healed": _folder(j / "reaper" / "out" / "m-REAP25-healed", {}),
            "int4": _folder(j / "reaper" / "out" / "m-REAP25-GPTQ-W4A16", {"quantization_config": {"quant_method": "gptq"}}),
            "mlx": _folder(j / "reaper" / "out" / "m-MLX-9GB", {"quantization": {"group_size": 32}})}
    return FakeJob(j, dirs), tmp_path


def test_final_picks_the_last_artefact(built):
    job, tmp = built
    # a plain MLX export cannot be served by vLLM: int4 for vLLM, the MLX folder for an MLX benchmark
    assert _bench.resolve(job, "final", mlx_ok=False)[0] == "int4"
    assert _bench.resolve(job, "final")[0] == "mlx"
    assert _bench.resolve(job, "latest")[0] == "healed"
    # a HEX MLX export is fine for vLLM (swebench-pro.sh converts it)
    cfg = job.dirs["mlx"] / "config.json"
    cfg.write_text(json.dumps({"hex": {"0": {}}, "quantization": {"group_size": 32}}))
    assert _bench.resolve(job, "final", mlx_ok=False)[0] == "mlx"
    # a vLLM blackhole-hex folder (hex-vllm) linked in the job's out/ beats everything
    hexdir = _folder(job.root / "reaper" / "out" / "m-HEX-11GB", {"quantization_config": {"quant_method": "blackhole-hex"}})
    (job.root / "out" / hexdir.name).symlink_to(hexdir)
    assert _bench.resolve(job, "final", mlx_ok=False) == ("hex", hexdir.resolve())
    assert _bench.resolve(job, "hex")[1] == hexdir.resolve()
    # or named by work/hex-vllm.json
    other = _folder(tmp / "elsewhere-HEX", {"quantization_config": {"quant_method": "blackhole-hex"}})
    job.write("work/hex-vllm.json", {"out": str(other)})
    assert _bench.resolve(job, "final")[1] == other


def test_progress_counts_harbor_trials(tmp_path):
    run = tmp_path / "r1"
    assert _bench.swebench_progress(run) is None
    (run / "jobs" / "r1" / "t").mkdir(parents=True)
    (run / "jobs" / "r1-regrade" / "t").mkdir(parents=True)
    (run / "ids.txt").write_text("a\nb\n")
    (run / "jobs" / "r1" / "t" / "result.json").write_text("{}")
    assert _bench.swebench_progress(run) == (2, 1, 0)
    (run / "jobs" / "r1-regrade" / "t" / "result.json").write_text("{}")
    assert _bench.swebench_progress(run) == (2, 1, 1)


def _env(tmp, monkeypatch):
    src = tmp / "BlackHole-Harness"
    sp = src / "harness" / "scripts" / "swebench-pro.sh"
    sp.parent.mkdir(parents=True)
    sp.write_text(FAKE_SCRIPT)
    monkeypatch.setenv("BLACKHOLE_HARNESS_SRC", str(src))
    monkeypatch.setenv("BLACKHOLE_HOME", str(tmp / "bh"))
    monkeypatch.setenv("ARGS_FILE", str(tmp / "args.txt"))
    return sp


def test_swebench_step_after_a_hex_build(built, monkeypatch):
    job, tmp = built
    _env(tmp, monkeypatch)
    hexdir = _folder(job.root / "reaper" / "out" / "m-HEX-11GB", {"quantization_config": {"quant_method": "blackhole-hex"}})
    (job.root / "out" / hexdir.name).symlink_to(hexdir)
    from blackhole_dev.functions_src.external_bench import external_bench
    res = external_bench(job, preset="swebench-pro", tasks="hard", workers=4)
    args = (tmp / "args.txt").read_text().split()
    run = "qwen-next-reapq-1102-1030-swebench-pro"
    assert args[0] == str(hexdir.resolve()) and args[args.index("--tasks") + 1] == "hard"
    assert args[args.index("--name") + 1] == run and args[args.index("-n") + 1] == "4"
    assert int(args[args.index("--port") + 1]) > 0
    assert res["resolved"] == res["score"] == 0.5 and res["n_resolved"] == 2 and res["instances"] == 4 and res["errors"] == 1
    out = job.path("work", "external", "swebench-pro")
    assert json.loads((out / "results.json").read_text())["a"] is True
    assert json.loads((out / "results.summary.json").read_text())["total"] == 4
    saved = job.read("work/external-swebench-pro.json")
    assert saved["model"] == "hex" and saved["tasks"] == "hard"
    assert (tmp / "bh" / "swebench" / "runs" / run / "results.json").exists()


def test_swebench_refuses_a_plain_mlx_folder_by_name(built, monkeypatch):
    job, tmp = built
    _env(tmp, monkeypatch)
    from blackhole_dev.functions_src.external_bench import external_bench
    res = external_bench(job, preset="swebench-pro")          # final: int4, not the plain MLX export
    assert (tmp / "args.txt").read_text().split()[0] == str(job.dirs["int4"])
    assert res["score"] == 0.5


def test_missing_harness_checkout_says_how_to_install(built, monkeypatch):
    job, tmp = built
    monkeypatch.setenv("BLACKHOLE_HARNESS_SRC", str(tmp / "nowhere"))
    monkeypatch.setenv("HOME", str(tmp / "home"))
    monkeypatch.setattr(_bench, "Path", _bench.Path)
    import blackhole_pipeline  # noqa: F401  (the installed one has the script only in a real checkout)
    from blackhole_dev.functions_src.external_bench import external_bench
    try:
        _bench.harness_script()
    except RuntimeError as e:
        assert "install.sh" in str(e)
        with pytest.raises(RuntimeError, match="install.sh"):
            external_bench(job, preset="swebench-pro")
    else:
        pytest.skip("a BlackHole-Harness checkout with the script is installed here")


STOP_DRIVER = """import json, sys
sys.path.insert(0, {tests!r})
from pathlib import Path
from test_swebench_step import FakeJob
from blackhole_dev.functions_src.external_bench import external_bench
job = FakeJob(Path({root!r}), {{"original": Path({base!r})}})
print("start", flush=True)
external_bench(job, preset="swebench-pro", model="original")
"""


def test_stop_ends_the_script(built, monkeypatch, tmp_path):
    job, tmp = built
    _env(tmp, monkeypatch)
    monkeypatch.setenv("SLEEP", "317")
    drv = tmp / "drv.py"
    drv.write_text(STOP_DRIVER.format(tests=str(Path(__file__).parent), root=str(job.root), base=str(job.dirs["original"])))
    p = subprocess.Popen([sys.executable, str(drv)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=os.environ.copy())
    for _ in range(100):
        if (tmp / "args.txt.pid").exists():
            break
        time.sleep(0.1)
    time.sleep(0.5)
    p.send_signal(signal.SIGTERM)
    p.wait(timeout=90)
    assert p.returncode != 0
    pid = int((tmp / "args.txt.pid").read_text())
    time.sleep(0.5)
    alive = Path(f"/proc/{pid}").exists() and "Z" not in Path(f"/proc/{pid}/stat").read_text().split()[2]
    assert not alive, "the script's child survived the stop"


def test_bundle_says_the_recipe_needs_docker(tmp_path):
    pytest.importorskip("blackhole_pipeline")
    from blackhole_dev.recipe.bundle import bundle
    src = tmp_path / "r.py"
    src.write_text('''from blackhole_dev.recipe import Recipe
recipe = Recipe("t/sbp", "1.0.0", base="Qwen/Qwen3-30B-A3B")
preset = recipe.input("preset", "text", default="swebench-pro")
recipe.step("pipeline.reap")
recipe.fn("external-bench", preset=preset, model="final", tasks="smoke", id="swebench")
''')
    m = bundle(src, out=tmp_path / "r.bhr", with_plan=False)["manifest"]
    assert m["needs"]["docker"] is True
    m = bundle(src, out=tmp_path / "r2.bhr", with_plan=False, inputs={"preset": "generic"})["manifest"]
    assert "docker" not in m["needs"]
