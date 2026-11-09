"""Task-aware tracing and preloading (recipes/examples/task_preload.py): the predictor and plan
math on numpy, the exact rewrites on a tiny random Qwen3 and Llama, and the five job functions
run through blackhole_dev.jobctx as the VM would."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from blackhole_dev.functions_src import _taskmap as tm

ROOT = Path(__file__).resolve().parents[1]


def test_predictor_beats_the_static_ranking_when_use_depends_on_the_prompt():
    rng = np.random.default_rng(0)
    P, d, L, B = 300, 12, 3, 16
    X = rng.standard_normal((P, d))
    Wt = rng.standard_normal((d, L * B))
    Y = np.exp(X @ Wt * 0.6 + rng.standard_normal((P, L * B)) * 0.1).reshape(P, L, B)
    pr = tm.fit(X[:200], Y[:200], ridge=0.1)
    res = tm.evaluate_predictor(pr, Y[:200], {"feats": X[200:]}, Y[200:], k=4)
    assert res["r2"] > 0.8
    assert res["recall_predictor"] > res["recall_static"] > res["recall_random"] - 0.05
    assert res["recall_predictor"] > 0.9
    assert tm.recall(Y, tm.topk_mask(Y, 4), 4) == pytest.approx(1.0)


def test_allocation_keeps_the_budget():
    n = tm.allocate(4, 256, 0.5, "even", multiple=64)
    assert n.tolist() == [128] * 4
    w = np.array([1.0, 4.0, 1.0, 2.0])
    n = tm.allocate(4, 256, 0.25, "importance", w)
    assert abs(n.sum() - 256) <= 4 and n[1] > n[0] and n.max() <= 128 and n.min() >= 32


def test_block_scores_follow_the_order():
    ffn = np.arange(2 * 1 * 6, dtype=np.float16).reshape(2, 1, 6)
    order = np.array([[5, 4, 3, 2, 1, 0]])
    b = tm.block_scores(ffn, order, 4)
    assert b.shape == (2, 1, 2)
    assert b[0, 0].tolist() == [5 + 4 + 3 + 2, 1 + 0]


# --------------------------------------------------------------------------- torch

def _reaper_tests() -> Path:
    rp = pytest.importorskip("reaper_pipeline")
    return Path(rp.__file__).resolve().parents[1] / "tests"


def _tiny(fam: str, path: Path) -> Path:
    torch = pytest.importorskip("torch")
    transformers = pytest.importorskip("transformers")
    sys.path.insert(0, str(_reaper_tests()))
    from tiny_moe import tokenizer
    tok = tokenizer()
    torch.manual_seed(0)
    kw = dict(vocab_size=len(tok), hidden_size=64, num_hidden_layers=3, num_attention_heads=4,
              num_key_value_heads=2, intermediate_size=256)
    if fam == "qwen3":
        hf = transformers.Qwen3ForCausalLM(transformers.Qwen3Config(head_dim=16, **kw))
    else:
        hf = transformers.LlamaForCausalLM(transformers.LlamaConfig(**kw))
    hf.save_pretrained(path)
    tok.save_pretrained(path)
    return path


TASK = [f"def fix(bug{i}): return bug.trace() # debugging python code error stack {i}" for i in range(24)]
GENERAL = [f"The quick brown fox jumps over the lazy dog {i}. Explain, write, solve 3x + 7 = 2." for i in range(12)]


def _logits(hf, ids):
    import torch
    with torch.no_grad():
        return hf(input_ids=torch.tensor([ids])).logits[0]


@pytest.mark.parametrize("fam", ["qwen3", "llama"])
def test_trace_plan_and_exact_rewrites(tmp_path, fam):
    import torch
    path = _tiny(fam, tmp_path / fam)
    hf, tok = tm.load(path, device="cpu"), tm.tokenizer(path)
    rows = [{"prompt": t, "answer": "return bug"} for t in TASK[:8]]
    tr = tm.trace(hf, tok, rows, probe=0)
    assert tr["ffn"].shape == (8, 3, 256) and tr["heads"].shape == (8, 3, 4) and tr["feats"].shape == (8, 64)
    assert (tr["ffn"] >= 0).all() and tr["ffn"].max() > 0 and (tr["layers"] > 0).all()

    plan = tm.make_plan(tm.neuron_scores(tr), tr["heads"].mean(0), 0.5, 0.5, "even", block_size=64)
    assert plan["hot"].sum(1).tolist() == [128] * 3 and plan["hot_heads"].sum(1).tolist() == [2] * 3
    ids, start = tm.encode(tok, rows[0])
    ref = _logits(hf, ids)

    same = tm.load(path, device="cpu")                    # the hot-first permutation alone is exact
    tm.apply(same, plan, "bf16", "bf16")
    assert torch.allclose(_logits(same, ids), ref, atol=1e-4)

    cut = tm.load(path, device="cpu")                     # cold "off" with even counts cuts the FFN
    info = tm.apply(cut, plan, "bf16", "off", attn=False)
    assert cut.config.intermediate_size == 128 and cut.model.layers[0].mlp.down_proj.weight.shape == (64, 128)
    assert info["size_gb"] < info["base_gb"] and info["hot_share_ffn"] == pytest.approx(0.5)
    cut.save_pretrained(tmp_path / "cut")
    again = tm.load(tmp_path / "cut", device="cpu")
    assert torch.allclose(_logits(again, ids), _logits(cut, ids), atol=1e-5)

    # the dynamic hooks with a fixed mask equal the baked static plan (same cold weights)
    stat = tm.load(path, device="cpu")
    tm.apply(stat, plan, "bf16", "int3", permute=False, attn=False)
    dyn = tm.load(path, device="cpu")
    with tm.DynamicFFN(dyn, "int3") as d:
        d.mask = torch.as_tensor(plan["hot"])
        assert torch.allclose(_logits(dyn, ids), _logits(stat, ids), atol=1e-4)
        d.mask = torch.ones_like(d.mask)
        assert torch.allclose(_logits(dyn, ids), ref, atol=1e-4)
    assert torch.allclose(_logits(dyn, ids), ref, atol=1e-6)          # hooks gone

    st = tm.token_stats(ref, ref, ids, start)
    assert abs(st["kl"]) < 1e-6 and st["top1"] == st["n"] == len(ids) - start


def test_the_recipe_runs_as_job_functions(tmp_path):
    pytest.importorskip("blackhole_pipeline")
    from blackhole_dev.recipe.lint import lint
    r, probs = lint(ROOT / "recipes" / "examples" / "task_preload.py")
    assert not [p for p in probs if p["severity"] == "error"], probs
    assert r.runner == "pipeline"
    model = _tiny("qwen3", tmp_path / "qwen3-tiny")
    task = tmp_path / "task.txt"
    task.write_text("\n".join(TASK))
    general = tmp_path / "general.txt"
    general.write_text("\n".join(GENERAL))
    job = tmp_path / "bh" / "task"
    (job / "recipe").mkdir(parents=True)
    raw = r.to_raw()
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({
        "model": str(model), "schema": raw["id"], "target": "", "purpose": "", "steps": [],
        "inputs": {"task": str(task), "general": str(general), "n_prompts": 24, "budget": 0.5,
                   "cold_format": "int2", "block_size": 32}}))
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "BLACKHOLE_HOME": str(tmp_path / "bhhome"),
           "REAPER_HOME": str(tmp_path / "home"), "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions"),
           "CUDA_VISIBLE_DEVICES": ""}
    out = {}
    for sid in ("prompts", "trace", "predictor", "preload", "task_eval"):
        p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", sid],
                           env=env, cwd=tmp_path, capture_output=True, text=True, timeout=900)
        assert p.returncode == 0, (sid, p.stdout[-3000:] + p.stderr[-3000:])
        evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
        assert evs[-1]["status"] == "done" and evs[-1].get("gate") != "failed", (sid, evs[-1])
        out[sid] = json.loads((job / "reaper" / "work" / f"fn-{sid}.json").read_text())["result"]
    assert out["prompts"]["heldout"] == 6 and out["prompts"]["with_answers"] == 24 + 12
    assert 0 < out["trace"]["top20_share"] <= 1
    assert out["predictor"]["heldout_recall_static"] > out["predictor"]["heldout_recall_random"]
    moe_dir = Path(out["preload"]["model_dir"])
    assert moe_dir.parent == job / "reaper" / "out"
    pm = json.loads((moe_dir / "blackhole-preload.json").read_text())
    assert pm["layers"][0]["ffn_hot_rows"] == [0, 128] and pm["cold_format"] == "int2"
    ev = out["task_eval"]
    for v in ("plan", "general", "random", "cold", "dynamic", "oracle"):
        assert ev[f"heldout_{v}_kl"] >= 0 and 0 <= ev[f"heldout_{v}_top1"] <= 1
    assert ev["heldout_cold_kl"] > ev["heldout_plan_kl"]
    assert ev["heldout_oracle_kl"] <= ev["heldout_random_kl"]
    assert ev["base_decode_tok_s"] > 0 and ev["plan_size_gb"] < ev["base_size_gb"]
