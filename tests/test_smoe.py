"""Dense -> split-SMoE (recipes/examples/dense_to_smoe.py): the partition math on numpy, the
conversion on a tiny random Qwen3 and Qwen2 (exactly the dense model with all experts on), and
the five job functions run through blackhole_dev.jobctx as the VM would."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from blackhole_dev.functions_src import _smoe

ROOT = Path(__file__).resolve().parents[1]


def _coact(m=48, T=400, seed=0):
    rng = np.random.default_rng(seed)
    e = np.abs(rng.standard_normal((T, m))) * (rng.random((T, m)) < 0.3)
    return e.T @ e / T


def test_nystrom_is_exact_at_full_rank():
    M = _coact()
    omega = np.random.default_rng(1).standard_normal((M.shape[0], M.shape[0]))
    Z = _smoe.nystrom_embedding(M @ omega, omega)
    assert np.allclose(Z @ Z.T, M, atol=1e-8 * np.abs(M).max())


def test_balanced_kmeans_gives_equal_experts():
    X = np.random.default_rng(2).standard_normal((48, 5))
    labels = _smoe.balanced_kmeans(X, 6, 8, np.random.default_rng(0))
    assert np.bincount(labels, minlength=6).tolist() == [8] * 6
    with pytest.raises(ValueError):
        _smoe.balanced_kmeans(X, 5, 8, np.random.default_rng(0))


def test_swaps_raise_within_mass_and_stay_under_the_ky_fan_bound():
    Z = np.linalg.cholesky(_coact() + 1e-9 * np.eye(48))
    N, s = 6, 8
    rng = np.random.default_rng(3)
    start = rng.permutation(np.repeat(np.arange(N), s))
    lam = np.linalg.eigvalsh(Z.T @ Z)[::-1]
    bound = s * lam[:N].sum()
    labels = _smoe.refine_swaps(Z, start, passes=20)
    assert np.bincount(labels, minlength=N).tolist() == [s] * N
    assert _smoe.within_mass(Z, labels, N) > _smoe.within_mass(Z, start, N)
    for lab in (start, labels, rng.permutation(start)):
        assert _smoe.within_mass(Z, lab, N) <= bound * (1 + 1e-9)


def test_swap_gain_formula_matches_brute_force():
    Z = np.random.default_rng(4).standard_normal((12, 4))
    labels = np.repeat(np.arange(3), 4)
    a, b = 0, 5                                       # a in expert 0, b in expert 1
    S = np.stack([Z[labels == g].sum(0) for g in range(3)])
    W = Z @ S.T
    zz = (Z * Z).sum(1)
    half = W[a, 1] - W[a, 0] + W[b, 0] - W[b, 1] + zz[a] + zz[b] - 2 * Z[a] @ Z[b]
    swapped = labels.copy()
    swapped[a], swapped[b] = 1, 0
    assert np.isclose(2 * half, _smoe.within_mass(Z, swapped, 3) - _smoe.within_mass(Z, labels, 3))


def test_widths():
    assert _smoe.widths(12288, 64, 0.03, False) == (192, 0)
    s, s0 = _smoe.widths(18944, 64, 0.03, True)
    assert s % _smoe.ALIGN == 0 and 64 * s + s0 == 18944 and s0 > 0
    with pytest.raises(ValueError, match="use experts in"):
        _smoe.widths(12288, 60, 0.0, False, "qwen3")


# --------------------------------------------------------------------------- torch

def _tiny(fam: str, path: Path) -> Path:
    torch = pytest.importorskip("torch")
    transformers = pytest.importorskip("transformers")
    sys.path.insert(0, str(_reaper_tests()))
    from tiny_moe import tokenizer
    tok = tokenizer()
    torch.manual_seed(0)
    kw = dict(vocab_size=len(tok), hidden_size=64, num_hidden_layers=3, num_attention_heads=4,
              num_key_value_heads=2)
    if fam == "qwen3":
        hf = transformers.Qwen3ForCausalLM(transformers.Qwen3Config(intermediate_size=256, head_dim=16, **kw))
    else:
        hf = transformers.Qwen2ForCausalLM(transformers.Qwen2Config(intermediate_size=264, **kw))
    hf.save_pretrained(path)
    tok.save_pretrained(path)
    return path


def _reaper_tests() -> Path:
    rp = pytest.importorskip("reaper_pipeline")
    return Path(rp.__file__).resolve().parents[1] / "tests"


TEXTS = [f"def fix(bug{i}): return bug.trace() # debugging python code error stack {i}" for i in range(40)]


def _convert(path: Path, N=8, k=2, **build):
    hf = _smoe.load(path, device="cpu")
    tok = _smoe.tokenizer(path)
    P = _smoe.profile(hf, _smoe.batches(TEXTS, tok, 2048, 32, 4, 0), experts=N)
    Q, _ = _smoe.partition(P, experts=N, shared_frac=0.03)
    Rz, per_layer = _smoe.fit_router(hf, Q, _smoe.batches(TEXTS, tok, 1536, 32, 4, 1),
                                     _smoe.batches(TEXTS, tok, 512, 32, 4, 2), topk=k)
    moe, rep = _smoe.build(hf, Q, Rz, topk=k, **{"min_r2": -1e9, "max_drop": 1.0, "gate_eps": 1e-4, **build})
    return hf, tok, Q, per_layer, moe, rep


@pytest.mark.parametrize("fam", ["qwen3", "qwen2"])
def test_conversion_is_the_dense_model_with_all_experts_on(tmp_path, fam):
    path = _tiny(fam, tmp_path / fam)
    hf, tok, Q, per_layer, moe, rep = _convert(path)
    assert int(Q["s0"]) == (8 if fam == "qwen2" else 0)
    row = per_layer["layer_0"]
    assert row["drop_oracle"] <= row["drop_linear"] + 1e-6 and row["drop_linear"] < row["drop_random"]
    assert rep["converted_layers_frac"] == 1.0 and rep["moe_type"] == f"{fam}_moe"
    res = _smoe.verify(hf, moe, _smoe.batches(TEXTS, tok, 256, 32, 4, 3))
    assert res["equiv_rel_err"] < 1e-4 and abs(res["kl_at_all_experts"]) < 1e-6
    assert res["kl_vs_dense"] > res["kl_at_all_experts"]
    # the saved checkpoint loads with stock transformers, per-expert keys on disk (what vLLM and MLX read)
    moe.save_pretrained(tmp_path / "moe")
    from safetensors import safe_open
    with safe_open(str(tmp_path / "moe" / "model.safetensors"), "pt") as f:
        keys = set(f.keys())
    assert "model.layers.0.mlp.experts.7.down_proj.weight" in keys and "model.layers.0.mlp.gate.weight" in keys
    assert ("model.layers.0.mlp.shared_expert_gate.weight" in keys) == (fam == "qwen2")
    again = _smoe.load(tmp_path / "moe", device="cpu")
    assert _smoe.verify(hf, again, _smoe.batches(TEXTS, tok, 128, 32, 4, 4))["equiv_rel_err"] < 1e-4


def test_layers_that_fail_the_gates_stay_dense(tmp_path):
    path = _tiny("qwen3", tmp_path / "q3")
    hf, tok, _, _, moe, rep = _convert(path, min_r2=2.0)
    assert rep["dense_layers"] == [0, 1, 2] and rep["converted_layers_frac"] == 0.0
    assert list(moe.config.mlp_only_layers) == [0, 1, 2]
    res = _smoe.verify(hf, moe, _smoe.batches(TEXTS, tok, 128, 32, 4, 3))
    assert res["equiv_rel_err"] < 1e-5 and abs(res["kl_vs_dense"]) < 1e-6


def test_the_recipe_runs_as_job_functions(tmp_path):
    pytest.importorskip("blackhole_pipeline")
    from blackhole_dev.recipe.lint import lint
    r, probs = lint(ROOT / "recipes" / "examples" / "dense_to_smoe.py")
    assert not [p for p in probs if p["severity"] == "error"], probs
    assert r.runner == "pipeline"
    model = _tiny("qwen3", tmp_path / "qwen3-tiny")
    calib = tmp_path / "calib.txt"
    calib.write_text("\n\n".join(TEXTS))
    job = tmp_path / "bh" / "smoe"
    (job / "recipe").mkdir(parents=True)
    raw = r.to_raw()
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({
        "model": str(model), "schema": raw["id"], "target": "", "purpose": "", "steps": [],
        "inputs": {"experts": 8, "topk": 8, "calib": str(calib), "n_tokens": 4096, "min_r2": -1.0,
                   "max_drop": 1.0}}))
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "BLACKHOLE_HOME": str(tmp_path / "bhhome"),
           "REAPER_HOME": str(tmp_path / "home"), "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions"),
           "CUDA_VISIBLE_DEVICES": ""}
    out = {}
    for sid in ("profile", "partition", "router", "build", "verify"):
        p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", sid],
                           env=env, cwd=tmp_path, capture_output=True, text=True, timeout=600)
        assert p.returncode == 0, (sid, p.stdout[-3000:] + p.stderr[-3000:])
        evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
        assert evs[-1]["status"] == "done" and evs[-1].get("gate") != "failed", (sid, evs[-1])
        out[sid] = json.loads((job / "reaper" / "work" / f"fn-{sid}.json").read_text())["result"]
    assert out["build"]["converted_layers_frac"] == 1.0
    assert out["verify"]["equiv_rel_err"] < 0.01 and out["verify"]["topk"] == 8
    moe_dir = Path(out["build"]["model_dir"])
    assert moe_dir.parent == job / "reaper" / "out" and (moe_dir / "blackhole-smoe.json").exists()
    assert json.loads((job / "reaper" / "config.json").read_text())["out_name"] == moe_dir.name


RECIPE_FN = '''from blackhole_dev import function
from blackhole_dev.recipe import Recipe

recipe = Recipe("test/inline-fn", "0.1.0")
recipe.fn("inline-count", n=3)


@function("inline-count", per="job")
def inline_count(job, n: int = 1) -> dict:
    return {"count": n}
'''


def test_job_functions_written_in_the_recipe_file_run(tmp_path):
    pytest.importorskip("blackhole_pipeline")
    job = tmp_path / "bh" / "inline"
    (job / "recipe").mkdir(parents=True)
    (job / "recipe" / "recipe.py").write_text(RECIPE_FN)
    stage = {"id": "inline_count", "kind": "job.fn", "fn": "inline-count", "n": 3}
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": {
        "api": "blackhole/v1", "id": "test/inline-fn", "version": "0.1.0", "stage": [stage]}}))
    (job / "config.json").write_text(json.dumps({"model": str(tmp_path / "none"), "schema": "test/inline-fn",
                                                 "steps": [], "purpose": ""}))
    env = {**os.environ, "BLACKHOLE_HOME": str(tmp_path / "bhhome"), "REAPER_HOME": str(tmp_path / "home"),
           "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions")}
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", "inline_count"],
                       env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stdout[-2000:] + p.stderr[-2000:]
    assert json.loads((job / "reaper" / "work" / "fn-inline_count.json").read_text())["result"] == {"count": 3}
