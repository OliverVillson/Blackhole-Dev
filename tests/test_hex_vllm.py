"""REAP/Q-HEX for vLLM (recipes/examples/reapq_hex_vllm.py) on a tiny random Qwen3.8-Flash-Next
(qwen4_exp: image-text, fused experts on disk, hyper connections, sparse attention, n-gram
embedding), CPU: the recipe lints, runs as job functions (calibrate, reap-gpu, hex-vllm,
package) and leaves a blackhole-hex folder that the benchmark functions find as model "hex"."""

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
blackhole_pipeline = pytest.importorskip("blackhole_pipeline")

ROOT = Path(__file__).resolve().parents[1]
REAPER = Path(reaper_pipeline.__file__).resolve().parents[1]


def test_reapq_hex_vllm_recipe_on_a_tiny_qwen38_flash_next(tmp_path):
    from blackhole_pipeline import PROCESSES
    if not any(p[0] == "hexvllm" for p in PROCESSES):
        pytest.skip("this BlackHole-Harness has no hexvllm stage")
    sys.path.insert(0, str(REAPER / "tests"))
    from tiny_moe import ARCHS, build
    if "qwen4_exp" not in ARCHS:
        pytest.skip("this BlackHole-Harness has no tiny qwen4_exp")
    from blackhole_dev.recipe.lint import lint
    r, probs = lint(ROOT / "recipes" / "examples" / "reapq_hex_vllm.py")
    assert not [p for p in probs if p["severity"] == "error"], probs
    assert r.runner == "pipeline"
    raw = r.to_raw()
    assert [s["fn"] for s in raw["stage"]] == ["calibrate", "reap-gpu", "hex-vllm", "package"]
    model = build("qwen4_exp", tmp_path / "qwen38-tiny")
    job = tmp_path / "bh" / "hexvllm"
    (job / "recipe").mkdir(parents=True)
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({
        "model": str(model), "schema": raw["id"], "target": "", "purpose": "", "steps": [],
        "heldout": 4, "max_seq": 96, "answer_max_tokens": 12, "writer_max_tokens": 24, "teacher_backend": "hf",
        "gptq_calib": 8, "inputs": {"calib": "builtin", "samples": 32, "hot": 0.5, "max_kl": 10.0}}))
    env = {**os.environ, "REAPER_HW": "builtin", "HF_HUB_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
           "BLACKHOLE_HOME": str(tmp_path / "bhhome"), "REAPER_HOME": str(tmp_path / "home"),
           "BLACKHOLE_NO_VLLM": "1", "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions"),
           "CUDA_VISIBLE_DEVICES": ""}
    for st in raw["stage"]:
        p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", st["id"]],
                           env=env, cwd=tmp_path, capture_output=True, text=True, timeout=900)
        assert p.returncode == 0, (st["id"], p.stdout[-4000:] + p.stderr[-3000:])
        evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
        assert evs[-1]["status"] == "done" and evs[-1].get("gate") != "failed", (st["id"], evs[-1])
    res = json.loads((job / "reaper" / "work" / "fn-hex.json").read_text())["result"]
    out = Path(res["out"])
    assert out.name.endswith("-HEX-vLLM") and res["bpw"] == pytest.approx(3.75) and "kl" in res
    cfg = json.loads((out / "config.json").read_text())
    assert cfg["quantization_config"]["quant_method"] == "blackhole-hex"
    assert cfg["text_config"]["num_experts"] == 6                       # REAP 25% of 8
    receipt = json.loads((job / "receipt.json").read_text())
    assert receipt["model"] == str(out)
    assert json.loads((job / "reaper" / "work" / "hex-vllm.json").read_text())["out"] == str(out)

    from blackhole_dev.functions_src import _bench
    from blackhole_dev.jobctx import Job
    ctx = Job(job, "check")
    assert _bench.resolve(ctx, "hex") == ("hex", out) and _bench.is_hex(out)
