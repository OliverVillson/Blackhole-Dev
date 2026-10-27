"""Job functions on a tiny random Flint (CPU): a recipe made only of named functions runs the
whole pipeline as `job.fn` stages (calibrate, REAP, distil, MLX export, qheal, bench,
package), and a fork in the bundle replaces a built-in stage."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("transformers")
reaper_pipeline = pytest.importorskip("reaper_pipeline")
pytest.importorskip("blackhole_pipeline")

REAPER = Path(reaper_pipeline.__file__).resolve().parents[1]

LCB = [{"question_title": "Sum", "question_content": "Read two integers and print their sum.", "platform": "atcoder",
        "question_id": "abc1", "contest_date": "2025-02-01", "starter_code": "", "difficulty": "easy",
        "public_test_cases": json.dumps([{"input": "1 2\n", "output": "3\n", "testtype": "stdin"}]),
        "private_test_cases": "[]", "metadata": "{}"}]

FORKED_PACKAGE = '''from blackhole_dev import function


@function("package", per="job")
def package(job) -> dict:
    """A fork of package that also counts the finished models."""
    res = job.run_stage("package", fresh=True)
    return {"forked": 1, "models": len(list((job.root / "out").iterdir())), **res}
'''


def test_a_recipe_of_job_functions_runs_the_pipeline(tmp_path):
    sys.path.insert(0, str(REAPER / "tests"))
    from tiny_moe import build
    model = build("flint", tmp_path / "flint-tiny")
    probs = tmp_path / "lcb.jsonl"
    probs.write_text("".join(json.dumps(r) + "\n" for r in LCB))
    job = tmp_path / "bh" / "flint-tiny-recipe"
    (job / "recipe" / "functions").mkdir(parents=True)
    (job / "config.json").write_text(json.dumps({
        "model": str(model), "schema": "test/job-fns", "target": "mac", "purpose": "", "steps": [],
        "calib_samples": 8, "calib": "mix", "heldout": 4, "max_seq": 96, "answer_max_tokens": 12,
        "writer_max_tokens": 24, "teacher_backend": "hf", "inputs": {"prune": 0.5}}))
    stages = [
        {"id": "calibrate", "kind": "job.fn", "fn": "calibrate"},
        {"id": "reap", "kind": "job.fn", "fn": "reap-gpu", "ratio": "${inputs.prune}",
         "gates": [{"metric": "kl", "op": ">=", "value": 0.0}]},
        {"id": "distil", "kind": "job.fn", "fn": "distil", "prompts": 6, "max_tokens": 10, "accum": 2, "lr": 1e-3,
         "expert_rank": 2, "layer_weight": 1.0},
        {"id": "kd", "kind": "job.fn", "fn": "kd", "accum": 2, "eval_every": 1, "heldout": 2, "minutes": 2, "lr": 1e-2},
        {"id": "mlx-export", "kind": "job.fn", "fn": "mlx-export", "group": 32, "hot": 0.5},
        {"id": "qheal-fn", "kind": "job.fn", "fn": "qheal", "minutes": 5},
        {"id": "bench-fn", "kind": "job.fn", "fn": "bench", "models": "mlx", "file": str(probs), "max_tokens": 16,
         "budgets": ""},
        {"id": "package-fn", "kind": "job.fn", "fn": "package", "gates": [{"metric": "forked", "op": "==", "value": 1}]},
    ]
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": {
        "api": "blackhole/v1", "id": "test/job-fns", "version": "0.1.0", "stage": stages,
        "inputs": {"prune": {"type": "float", "default": 0.25}}}}))
    (job / "recipe" / "functions" / "package.py").write_text(FORKED_PACKAGE)
    env = {**os.environ, "REAPER_HW": "builtin", "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
           "REAPER_HOME": str(tmp_path / "home"), "BLACKHOLE_HOME": str(tmp_path / "bhhome"),
           "BLACKHOLE_NO_VLLM": "1", "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions")}
    events = []
    for st in stages:
        p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", st["id"]],
                           env=env, cwd=tmp_path, capture_output=True, text=True, timeout=900)
        assert p.returncode == 0, (st["id"], p.stdout[-4000:] + p.stderr[-3000:])
        evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
        assert evs and all(e["stage"] == st["id"] for e in evs), st["id"]   # inner stages relayed as this stage
        assert evs[-1]["status"] == "done"
        assert (job / "reaper" / ".done" / st["id"]).exists()
        events += evs
    work = job / "reaper" / "work"
    assert json.loads((work / "reap.json").read_text())["experts_kept"] == 4           # ${inputs.prune} = 0.5 of 8
    heal = json.loads((work / "heal.json").read_text())
    assert heal["steps"] >= 1 and heal["sequences"] == 6
    kd = json.loads((work / "kd.json").read_text())                                    # the written-out loop
    assert kd["sequences"] == 4 and kd["heldout"] == 2 and kd["steps"] >= 1 and kd["history"] and kd["kl_before"] >= 0
    assert json.loads((job / "config.json").read_text())["heal_prompts"] == 6           # knobs land in the job config
    assert json.loads((work / "qheal.json").read_text())["steps"] >= 1
    assert json.loads((work / "bench.json").read_text())["problems"] == 1
    fn = json.loads((work / "fn-package-fn.json").read_text())
    assert fn["result"]["forked"] == 1 and fn["sha256"]                                # the bundle's fork ran
    assert (job / "receipt.json").exists() and (job / "RESULTS.md").exists()

    # a failing gate stops with exit 3 and does not mark the stage done
    raw = json.loads((job / "recipe" / "recipe.json").read_text())
    raw["raw"]["stage"].append({"id": "strict", "kind": "job.fn", "fn": "package",
                                "gates": [{"metric": "forked", "op": "==", "value": 2}]})
    (job / "recipe" / "recipe.json").write_text(json.dumps(raw))
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", "strict"],
                       env=env, cwd=tmp_path, capture_output=True, text=True, timeout=600)
    assert p.returncode == 3 and '"gate": "failed"' in p.stdout
    assert not (job / "reaper" / ".done" / "strict").exists()
