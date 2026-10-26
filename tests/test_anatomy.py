"""blackhole_dev: structure, queries, weight access, edits, formats, HEX and named functions.

The first half needs only numpy (a hand-written MoE + dense checkpoint). The second half
builds tiny real models with transformers (skipped without torch) and checks that edited
checkpoints load and compute what they should, and that the model.edit op runs in the runner."""

from __future__ import annotations

import json
import os
import pathlib
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]

import blackhole_dev as anatomy  # noqa: E402
from blackhole.anatomy import formats, hex as hx
from blackhole.anatomy import st  # noqa: E402
from blackhole_dev.functions import check, function, registry  # noqa: E402


class _Arr:
    def __init__(self, a):
        self.a = np.ascontiguousarray(a)
        self.nbytes = self.a.nbytes

    def write(self, fd):
        os.write(fd, self.a.tobytes())


def write_ckpt(root: Path, tensors: dict[str, np.ndarray], cfg: dict, shards: int = 1) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    names = sorted(tensors)
    groups = [names[i::shards] for i in range(shards)]
    wmap = {}
    for i, g in enumerate(groups):
        f = f"model-{i + 1:05d}.safetensors" if shards > 1 else "model.safetensors"
        items = []
        for n in g:
            a = tensors[n]
            dt = {np.dtype("float32"): "F32", np.dtype("uint16"): "BF16", np.dtype("int64"): "I64"}[a.dtype]
            items.append((n, dt, a.shape, _Arr(a)))
        st.write_file(root / f, items, {"format": "pt"})
        wmap.update({n: f for n in g})
    if shards > 1:
        (root / "model.safetensors.index.json").write_text(json.dumps({"metadata": {}, "weight_map": wmap}))
    (root / "config.json").write_text(json.dumps(cfg))
    (root / "tokenizer_config.json").write_text("{}")
    return root


H, I, E, V, LAYERS = 16, 8, 6, 40, 3


def moe_tensors(rng, bf16: bool = False) -> dict:
    t = {"model.embed_tokens.weight": rng.standard_normal((V, H)), "lm_head.weight": rng.standard_normal((V, H)),
         "model.norm.weight": np.ones(H)}
    for L in range(LAYERS):
        p = f"model.layers.{L}."
        t[p + "input_layernorm.weight"] = np.ones(H)
        t[p + "post_attention_layernorm.weight"] = np.ones(H)
        for r in ("q", "o"):
            t[p + f"self_attn.{r}_proj.weight"] = rng.standard_normal((H, H))
        for r in ("k", "v"):
            t[p + f"self_attn.{r}_proj.weight"] = rng.standard_normal((H // 2, H))
        t[p + "mlp.gate.weight"] = rng.standard_normal((E, H))
        for j in range(E):
            t[p + f"mlp.experts.{j}.gate_proj.weight"] = rng.standard_normal((I, H)) * (j + 1)
            t[p + f"mlp.experts.{j}.up_proj.weight"] = rng.standard_normal((I, H))
            t[p + f"mlp.experts.{j}.down_proj.weight"] = rng.standard_normal((H, I))
        t[p + "mlp.shared_expert.gate_proj.weight"] = rng.standard_normal((I, H))
        t[p + "mlp.shared_expert.up_proj.weight"] = rng.standard_normal((I, H))
        t[p + "mlp.shared_expert.down_proj.weight"] = rng.standard_normal((H, I))
    out = {}
    for k, v in t.items():
        v = v.astype(np.float32)
        out[k] = st.encode(v, "BF16") if bf16 else v
    return out


MOE_CFG = {"model_type": "qwen3_moe", "architectures": ["Qwen3MoeForCausalLM"], "hidden_size": H,
           "num_hidden_layers": LAYERS, "num_attention_heads": 4, "num_key_value_heads": 2, "head_dim": 4,
           "intermediate_size": I, "moe_intermediate_size": I, "num_experts": E, "num_experts_per_tok": 2,
           "shared_expert_intermediate_size": I, "vocab_size": V, "max_position_embeddings": 512, "torch_dtype": "bfloat16"}


@pytest.fixture
def moe(tmp_path):
    rng = np.random.default_rng(0)
    return write_ckpt(tmp_path / "moe", moe_tensors(rng), MOE_CFG, shards=2)


@pytest.fixture
def dense(tmp_path):
    rng = np.random.default_rng(1)
    t = {"model.embed_tokens.weight": rng.standard_normal((V, H)), "model.norm.weight": np.ones(H)}
    for L in range(2):
        p = f"model.layers.{L}."
        t[p + "input_layernorm.weight"] = np.ones(H)
        for r in ("q", "k", "v", "o"):
            t[p + f"self_attn.{r}_proj.weight"] = rng.standard_normal((H, H))
        t[p + "mlp.gate_proj.weight"] = rng.standard_normal((I, H))
        t[p + "mlp.up_proj.weight"] = rng.standard_normal((I, H))
        t[p + "mlp.down_proj.weight"] = rng.standard_normal((H, I))
    cfg = {"model_type": "llama", "architectures": ["LlamaForCausalLM"], "hidden_size": H, "num_hidden_layers": 2,
           "num_attention_heads": 4, "num_key_value_heads": 4, "intermediate_size": I, "vocab_size": V,
           "tie_word_embeddings": True, "max_position_embeddings": 512}
    return write_ckpt(tmp_path / "dense", {k: v.astype(np.float32) for k, v in t.items()}, cfg)


# --------------------------------------------------------------------------- numpy half


def test_dtypes_roundtrip():
    x = np.array([0.0, 1.0, -1.5, 3.14159, 0.0625, 448.0, -0.0078125], np.float32)
    b = st.decode(st.encode(x, "BF16"), "BF16")
    assert np.allclose(b, x, rtol=1e-2)
    f = st.decode(st.encode(x, "F8_E4M3"), "F8_E4M3")
    assert np.allclose(f, x, rtol=0.13) and f[0] == 0 and f[-1] == -0.0078125
    assert st.encode(np.array([np.nan], np.float32), "BF16")[0] == 0x7FC0


def test_structure_and_queries(moe):
    m = anatomy.open(moe)
    assert "moe" in m.info.kinds and len(m.layers) == LAYERS
    L = m.layers[1]
    assert L.moe is not None and L.moe.num_experts == E and L.moe.shared is not None and L.moe.shared.neurons == I
    assert L.attn is not None and len(L.attn.heads) == 4 and L.attn.heads[3].attrs["kv_group"] == 1
    assert len(m["experts"]) == E * LAYERS and len(m["layers[0:2].moe.experts[1,3]"]) == 4
    assert [e.attrs["id"] for e in m["layers[-1].experts[2:4]"]] == [2, 3]
    assert len(m["moe.router"]) == LAYERS and len(m["moe.shared"]) == LAYERS
    assert m.head is not None and m.embed is not None and m.norm is not None
    assert m.layers[0].moe.experts[2].params == 3 * I * H
    with pytest.raises(anatomy.QueryError):
        m["layers[foo]"]
    assert "layers.0" in m.summary()


def test_weight_read_write_and_stats(moe):
    m = anatomy.open(moe)
    v = m.layers[0].moe.experts[1].roles["down"]
    raw = v.numpy()
    assert v[2, 3] == pytest.approx(float(raw[2, 3]))
    assert v[0, :3].shape == (3,)
    v[2, 3] = 7.0
    v[0] = 0.0
    assert v[2, 3] == 7.0 and v[0, 5] == 0.0 and v[1, 1] == pytest.approx(float(raw[1, 1]))
    v.apply(lambda w: w * 2)
    assert v[2, 3] == 14.0
    s = v.stats()
    assert s["count"] == H * I and s["zero_frac"] == pytest.approx(I / (H * I))
    r = v.measure("int4")
    assert 0 < r["rel_mse"] < 0.05 and r["bpw"] == 4.125
    assert m.log[0]["op"] == "write"


def test_expert_edits_and_save(moe, tmp_path):
    m = anatomy.open(moe)
    before = {j: m.layers[0].moe.experts[j].roles["gate"].numpy().copy() for j in range(E)}
    router = m.layers[0].moe.router.weight.numpy().copy()
    for L in range(LAYERS):
        m.drop_experts(L, [0, 4])
    assert m.layers[0].moe.num_experts == E - 2
    assert np.array_equal(m.layers[0].moe.experts[0].roles["gate"].numpy(), before[1])
    assert np.array_equal(m.layers[0].moe.router.weight.numpy(), router[[1, 2, 3, 5]])
    m.layers[0].moe.merge([0, 1], "equal")
    for L in range(1, LAYERS):
        m.drop_experts(L, [0])
    merged = m.layers[0].moe.experts[0].roles["gate"].numpy()
    assert np.allclose(merged, (before[1] + before[2]) / 2, atol=1e-6)
    assert m.expert_attrs[0][0]["origin"] == [(m.id, 0, 1), (m.id, 0, 2)]
    out = m.save(tmp_path / "out")
    cfg = json.loads((out / "config.json").read_text())
    assert cfg["num_experts"] == E - 3
    m2 = anatomy.open(out)
    assert m2.layers[0].moe.num_experts == E - 3 and len(m2.tensor_names) < len(m.tensor_names) + 1
    assert np.allclose(m2.layers[0].moe.experts[0].roles["gate"].numpy(), merged, atol=1e-6)
    rec = json.loads((out / "blackhole-anatomy.json").read_text())
    assert rec["edits"][0]["op"] == "experts.drop" and rec["after"]["experts"]["params"] < rec["before"]["experts"]["params"]
    assert (out / "blackhole-lineage.json").exists() and (out / "tokenizer_config.json").exists()


def test_uneven_counts_refused_then_forced(moe, tmp_path):
    m = anatomy.open(moe)
    m.layers[0].moe.drop([5])
    assert m.problems() and "different expert counts" in m.problems()[0]
    with pytest.raises(anatomy.AnatomyError):
        m.save(tmp_path / "bad")
    m.save(tmp_path / "bad", force=True)


def test_layers_splice_duplicate_drop(moe, tmp_path):
    m = anatomy.open(moe)
    other = anatomy.open(moe)
    other.layers[2].attn.roles["q"].apply(lambda w: w * 0 + 3)
    m.splice_layer(0, other, 2)
    assert np.all(m.layers[0].attn.roles["q"].numpy() == 3)
    m.duplicate_layer(1)
    assert len(m.layers) == LAYERS + 1 and m.tc["num_hidden_layers"] == LAYERS + 1
    assert np.array_equal(m.layers[1].attn.roles["k"].numpy(), m.layers[2].attn.roles["k"].numpy())
    m.drop_layers([-1])
    assert len(m.layers) == LAYERS
    out = m.save(tmp_path / "spliced")
    m2 = anatomy.open(out)
    assert np.all(m2.layers[0].attn.roles["q"].numpy() == 3) and len(m2.layers) == LAYERS


def test_dense_neurons_heads_and_tied_head(dense, tmp_path):
    m = anatomy.open(dense)
    assert "dense" in m.info.kinds and m.head is not None and m.head.attrs.get("tied")
    mlp = m.layers[0].mlp
    assert mlp.neurons == I
    scores = mlp.neuron_scores()
    assert scores.shape == (I,)
    mlp.prune_neurons(ratio=0.25)
    m.layers[1].mlp.prune_neurons(keep=[0, 1, 2, 3, 4, 5])
    assert m.layers[0].mlp.neurons == 6 and m.layers[0].mlp.roles["down"].shape == (H, 6)
    assert m.synced_config()["intermediate_size"] == 6
    out = m.save(tmp_path / "d")
    assert anatomy.open(out).layers[1].mlp.roles["gate"].shape == (6, H)
    heads = m.layers[0].attn.heads
    assert len(heads) == 4 and heads[0].views[0].shape == (4, H) and heads[0].views[3].shape == (H, 4)


def test_formats_plan_and_reaq(moe):
    m = anatomy.open(moe)
    full = m.plan().total_gb
    m["experts"].quant("int3")
    assert m.plan().total_gb < full
    assert formats.bpw("hex3") == 3.25 and formats.bpw("hex4/b16") == 4.5
    with pytest.raises(ValueError):
        m["experts"].quant("int9")
    scores = {L: {"saliency": list(range(E)), "freq": [1] * E} for L in range(LAYERS)}
    m.load_scores(scores)
    assert m.layers[0].moe.experts[5].attrs["rank"] == 1.0 and m.layers[0].moe.experts[0].attrs["rank"] == 0.0
    hi = m.reaq(avg_bits=3.75)
    assert hi == {L: 3 for L in range(LAYERS)}
    assert m.formats[(f"model.layers.0.mlp.experts.5.down_proj.weight", None)] == "hex4"
    assert m.formats[(f"model.layers.0.mlp.experts.0.down_proj.weight", None)] == "hex3"
    p = m.plan(device="M-series-16GB")
    assert p.fits and p.tok_s and "hex" not in str(p.problems)
    m["experts[rank<0.5]"].drop()
    assert m.layers[0].moe.num_experts == 3
    # marks follow the surviving experts (old 3,4,5 are now 0,1,2)
    assert m.formats[(f"model.layers.0.mlp.experts.2.down_proj.weight", None)] == "hex4"
    m.trim_head([0, 1, 2, 3])
    assert m.plan().groups["head"]["gb"] < p.groups["head"]["gb"]


def test_hex_quantize_and_pack(moe, tmp_path):
    m = anatomy.open(moe)
    m.load_scores({L: {"saliency": list(range(E))} for L in range(LAYERS)})
    m.reaq(avg_bits=3.75)
    r = m.call("hex-quantize")
    assert r["rounding"] == "nearest" and 3.7 < r["bpw"] < 3.8 and r["rel_mse"] < 0.1
    W = m.layers[0].moe.experts[0].roles["down"].numpy()
    h = m.hex[(0, 0, "down")]
    assert h.L == 8 and np.array_equal(h.dequant(), W)        # the weights on disk are exactly the table values
    assert m.hex[(0, 5, "down")].L == 16
    saved = m.save(tmp_path / "hexed")
    reopened = anatomy.open(saved)
    assert np.allclose(reopened.layers[0].moe.experts[0].roles["down"].numpy(), W, atol=1e-6)
    assert (saved / "blackhole-hex.safetensors").exists() and reopened.hex[(0, 0, "down")].L == 8
    assert np.array_equal(reopened.hex[(0, 5, "down")].idx, m.hex[(0, 5, "down")].idx)
    pk = m.call("hex-pack", dst=str(tmp_path / "packed"))
    assert pk["tiers"] == {"16": 3 * LAYERS, "8": 3 * LAYERS}
    ents = {e.name: e for e in st.entries(st.Blob(str(tmp_path / "packed" / "model.safetensors")))}
    ids = ents["model.layers.0.mlp.experts.tier8.experts"]
    blob = ids.blob.array(ids.offset, ids.dtype, ids.shape)
    i = list(blob).index(0)
    parts = {}
    for k in ("idx", "block_scale", "expert_scale", "levels"):
        e = ents[f"model.layers.0.mlp.experts.tier8.down_proj.{k}"]
        parts[k] = np.asarray(e.blob.array(e.offset, e.dtype, e.shape))[i]
    assert ents["model.layers.0.mlp.experts.tier8.down_proj.idx"].dtype == "U32"
    assert parts["idx"].shape == (H, 3)                      # I=8 inputs padded to one 32-block of 3 bits = 3 words
    back = hx.unpack_expert(parts, W.shape).dequant()
    assert np.array_equal(back, W)
    g = ents["model.layers.0.mlp.experts.tier16.gate_proj.levels"]
    assert g.shape == (3, 16) and ents["model.layers.0.mlp.experts.tier16.up_proj.idx"].shape[1] == I
    cfg = json.loads((tmp_path / "packed" / "config.json").read_text())
    assert cfg["quantization_config"]["quant_method"] == "blackhole-hex"
    assert "model.layers.0.mlp.experts.0.down_proj.weight" not in ents and "lm_head.weight" in ents


def test_hex_gptq_beats_nearest():
    rng = np.random.default_rng(3)
    W = rng.standard_normal((32, 128)).astype(np.float32)
    X = rng.standard_normal((400, 128)) * (1 + 3 * (np.arange(128) < 8))   # a few hot input channels
    Hm = X.T @ X
    plain = hx.quantize(W, 8, 32)
    g = hx.quantize(W, 8, 32, energy=np.diag(Hm) / 400, H=Hm)
    err = lambda h: float((((W - h.dequant()) @ X.T) ** 2).sum())  # noqa: E731
    assert err(g) < err(plain)
    assert plain.bpw == 3.25 and np.array_equal(hx.unpack_expert(g.packed(), W.shape).idx, g.idx)
    for bits in (3, 4):
        idx = rng.integers(0, 2 ** bits, (5, 70)).astype(np.uint8)
        words = hx.pack_bits(idx, bits)
        assert words.dtype == np.uint32 and words.shape == (5, 3 * bits)
        assert np.array_equal(hx.unpack_bits(words, bits, 70), idx)


def test_named_functions(moe, tmp_path):
    reg = registry()
    for name in ("reap-prune", "reaq", "hex-quantize", "hex-pack", "clip-outliers", "merge-similar-experts"):
        assert name in reg
    assert check("reap-prune", {"ratio": 0.5}) == []
    assert check("clip-outliers", {"sigma": 3}) == []
    assert "unknown param" in check("reaq", {"bits": 3})[0]

    @function("double-it")
    def double(w: np.ndarray, times: int = 2, select: str = "layers[*].attn") -> np.ndarray:
        """Multiply."""
        return w * times

    @function("count-experts", per="model")
    def count(m) -> dict:
        return {"experts": len(m["experts"])}

    m = anatomy.open(moe)
    q = m.layers[0].attn.roles["q"].numpy().copy()
    out = m.call("double-it", times=3)
    assert out["parts"] == LAYERS and np.allclose(m.layers[0].attn.roles["q"].numpy(), q * 3)
    assert m.call("count-experts") == {"experts": E * LAYERS}
    m.load_scores({L: {"saliency": list(range(E))} for L in range(LAYERS)})
    assert m.call("reap-prune", ratio=0.5) == {"experts_dropped": 3 * LAYERS}
    assert m.call("merge-similar-experts", pairs=1)["pairs_merged"] == LAYERS
    assert m.layers[0].moe.num_experts == 2
    assert m.call("prune-neurons", ratio=0.25, select="layers[*].moe.shared")["mlps"] == LAYERS
    assert m.layers[0].moe.shared.neurons == 6
    assert "double-it" in m.receipt()["functions"]
    f = tmp_path / "myfn.py"
    f.write_text("from blackhole_dev import function\n"
                 "@function('halve')\ndef halve(w, select=''):\n    return w / 2\n")
    from blackhole_dev import functions as fns
    sha = fns.load(str(f))
    assert len(sha) == 64 and fns.get("halve").sha256 == sha
    m.call("halve", select="layers[0].attn")
    assert np.allclose(m.layers[0].attn.roles["q"].numpy(), q * 1.5)


def test_diff_and_annotate(moe):
    a, b = anatomy.open(moe), anatomy.open(moe)
    b.layers[0].attn.roles["q"].scale(1.1)
    d = {r["tensor"]: r for r in anatomy.diff(a, b)}
    assert d["model.layers.0.self_attn.q_proj.weight"]["rel_diff"] == pytest.approx(0.1, rel=1e-3)
    assert d["model.layers.1.self_attn.q_proj.weight"]["rel_diff"] == 0
    a.annotate(a["experts"], "big", lambda e: e.roles["gate"].stats()["rms"])
    assert len(a["experts[big>4.5]"]) == 2 * LAYERS    # gate_proj scaled by j+1: experts 4 and 5


# --------------------------------------------------------------------------- torch half

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")
import blackhole  # noqa: E402
_PUBLIC = pathlib.Path(blackhole.__file__).resolve().parents[1]      # the public checkout (editable install) holds reaper/tests/tiny_moe.py
sys.path.insert(0, str(_PUBLIC / "reaper" / "tests"))
tiny_moe = pytest.importorskip("tiny_moe")

TEXTS = ["def fix(bug): return bug.trace() # debugging python code error", "The quick brown fox jumps over the lazy dog."] * 3


def _logits(path, ids):
    m = transformers.AutoModelForCausalLM.from_pretrained(path).eval()
    with torch.no_grad():
        return m(ids).logits


@pytest.mark.parametrize("arch", ["qwen3_moe", "mixtral", "gpt_oss", "deepseek_v3"])
def test_real_models_permute_and_splice_are_exact(arch, tmp_path):
    src = tiny_moe.build(arch, tmp_path / arch)
    ids = torch.randint(0, 300, (1, 16), generator=torch.Generator().manual_seed(0))
    ref = _logits(src, ids)
    m = anatomy.open(src)
    for L in m.layers:
        if L.moe:
            L.moe.reorder(list(reversed(range(L.moe.num_experts))))
    out = m.save(tmp_path / "perm")
    assert torch.allclose(_logits(out, ids), ref, atol=1e-5)
    m2 = anatomy.open(src)
    m2.move_layer(0, 1)
    m2.move_layer(1, 0)
    out2 = m2.save(tmp_path / "moved")
    assert torch.allclose(_logits(out2, ids), ref, atol=1e-5)


def test_reap_reaq_hex_recipe_on_real_model(tmp_path):
    src = tiny_moe.build("qwen3_moe", tmp_path / "q")
    base = anatomy.open(src)
    m = anatomy.open(src)
    live = m.live()
    res = live.reap_scores(TEXTS)
    assert set(res) == {0, 1} and all(e.attrs.get("score") is not None for e in m["experts"])
    assert m.call("reap-prune", ratio=0.25) == {"experts_dropped": 4}
    assert m.call("reaq", avg_bits=3.5)["experts_hi"] == 4
    r = m.call("hex-quantize", calib=TEXTS)
    assert r["rounding"] == "gptq" and r["experts"] == 12
    out = m.save(tmp_path / "hexed")
    kl = anatomy.open(out).live().kl(base.live(), TEXTS)
    assert kl["tokens"] > 0 and kl["kl"] < 1.0 and 0 <= kl["top1"] <= 1
    _logits(out, torch.randint(0, 300, (1, 8)))       # loads with stock transformers
    pk = m.call("hex-pack", dst=str(tmp_path / "packed"))
    assert pk["tiers"] == {"16": 4, "8": 8}


def test_hex_torch_reference_matches_numpy():
    rng = np.random.default_rng(5)
    hs = [hx.quantize(rng.standard_normal((8, 96)).astype(np.float32), L, 32) for L in (16, 16)]
    parts = [h.packed() for h in hs]
    stack = lambda k: torch.as_tensor(np.stack([p[k] for p in parts]))  # noqa: E731
    got = hx.hex_dequant(stack("idx"), stack("block_scale"), stack("expert_scale").reshape(2), stack("levels"), 4)
    want = np.stack([h.dequant() for h in hs])
    assert torch.allclose(got, torch.as_tensor(want), atol=1e-7)


def test_live_training_masks(tmp_path):
    src = tiny_moe.build("qwen3_moe", tmp_path / "q2")
    m = anatomy.open(src)
    live = m.live()
    n = live.train_only("layers[*].moe.router")
    assert n == 2 and live.trainable_params() == 2 * 8 * 64
    live.train("layers[0].moe.experts[3]")
    ex = m.layers[0].moe.experts[3]
    pname, idx = live.param_for(ex.roles["down"])
    assert "experts.down_proj" in pname and idx == (3,)
    assert live.params[pname].requires_grad and live.trainable_params() > 2 * 8 * 64
    live.module(input_ids=torch.randint(0, 300, (1, 8))).logits.sum().backward()
    g = live.params[pname].grad
    assert g is not None and float(g[2].abs().sum()) == 0 and float(g[3].abs().sum()) > 0
    m.layers[0].attn.roles["q"].scale(2.0)
    live2 = m.live()
    assert torch.allclose(live2.params["model.layers.0.self_attn.q_proj.weight"].float(),
                          live.params["model.layers.0.self_attn.q_proj.weight"].float() * 2)


def test_model_edit_op_in_runner(tmp_path, monkeypatch):
    from blackhole.core import ops, runner
    from blackhole.core.job import Job
    monkeypatch.setenv("BLACKHOLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PYTHONPATH", str(ROOT))
    monkeypatch.setenv("BLACKHOLE_OPS", "blackhole_dev.op")   # the entry point when installed; explicit here
    ops._loaded = False
    src = tiny_moe.build("qwen3_moe", tmp_path / "q3")
    calib = tmp_path / "calib.txt"
    calib.write_text("\n\n".join(TEXTS))
    fnfile = tmp_path / "extra.py"
    fnfile.write_text("from blackhole_dev import function\n"
                      "@function('tame', per='model')\ndef tame(m):\n"
                      "    m['layers[*].moe.router'].apply(lambda w: w * 0.5)\n    return {'routers': len(m['moe.router'])}\n")
    schema = tmp_path / "s.toml"
    schema.write_text(f'''
api = "blackhole/v1"
id = "test/edit"
version = "0.1.0"
[targets]
architectures = ["moe"]
[[stage]]
id = "score"
kind = "model.edit"
fn = "reap-score"
args = {{ calib = "{calib}" }}
[[stage]]
id = "shrink"
kind = "model.edit"
functions = ["{fnfile}"]
steps = [
  {{ fn = "reap-prune", ratio = 0.25 }},
  {{ fn = "tame" }},
  {{ fn = "reaq", avg_bits = 3.5 }},
  {{ fn = "hex-quantize" }},
]
  [[stage.gates]]
  metric = "reap-prune.experts_dropped"
  op = "=="
  value = 4
[[stage]]
id = "pack"
kind = "model.edit"
fn = "quant"
args = {{ select = "moe.router", format = "bf16" }}
pack = "hex"
''')
    assert ops.validate(__import__("blackhole.core.schema", fromlist=["load"]).load(schema)) == []
    job = Job.create(schema, str(src), {}, tmp_path / "job")
    assert runner.run(job) == 0
    met = job.metrics("shrink")
    assert met["reap-prune.experts_dropped"] == 4 and met["tame.routers"] == 2 and met["hex-quantize.rounding"] == "nearest"
    out = Path(job.stage_dir("shrink")) / "out" / "model"
    rec = json.loads((out / "blackhole-anatomy.json").read_text())
    assert "tame" in rec["functions"] and len(rec["functions"]["tame"]) == 64
    assert anatomy.open(out).layers[0].moe.num_experts == 6
    packed = Path(job.stage_dir("pack")) / "out" / "model"
    assert json.loads((packed / "config.json").read_text())["quantization_config"]["quant_method"] == "blackhole-hex"
    receipt = json.loads((job.root / "receipt.json").read_text())
    assert receipt["outcome"] == "done"
