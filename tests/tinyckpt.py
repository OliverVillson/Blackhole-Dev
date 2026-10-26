"""A tiny hand-written Qwen3-MoE checkpoint (numpy only), shared by the recipe and helper tests."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from blackhole.anatomy import st


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


def tiny_moe(root: Path) -> Path:
    return write_ckpt(root, moe_tensors(np.random.default_rng(0)), MOE_CFG, shards=2)
