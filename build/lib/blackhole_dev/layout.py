"""Find a model's parts from its tensor names and shapes, for any architecture.

Nothing is written per model family. A decoder layer is `<prefix>.layers.<i>.`; inside it:

  attention   self_attn. / attn. / attention. / self_attention.   (q k v o, fused qkv, MLA)
  mixer       linear_attn. / mamba. / mixer. / ssm.               (DeltaNet, Mamba: fixed-size state)
  ffn         mlp. / block_sparse_moe. / feed_forward. / moe. / ffn.
                MoE when it holds experts: per-expert keys `experts.<j>.<proj>` or fused
                `experts.<proj>` [E, ...]; the router is the `gate` / `router` child with a
                [E, hidden] weight (bias and DeepSeek's e_score_correction_bias go with it);
                `shared_expert(s)` and `shared_expert_gate` are the shared expert.
  norms       anything else with "norm" in its name

The text decoder is the `layers` prefix with the most tensors, so a vision tower's own layers
stay in `other`. Layers numbered past num_hidden_layers are multi-token-prediction heads.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

LAYER = re.compile(r"^(?P<pre>(?:[^.]+\.)*?)layers\.(?P<i>\d+)\.(?P<rest>.+)$")
ATTN = ("self_attn", "attn", "attention", "self_attention")
MIXER = ("linear_attn", "mamba", "mixer", "ssm", "time_mix")
FFN = ("mlp", "block_sparse_moe", "feed_forward", "moe", "ffn")
ROUTERS = ("gate", "router", "gating", "gate_layer", "moe_gate")
SHARED = ("shared_expert", "shared_experts", "shared_mlp")
ROLE = {"gate_proj": "gate", "w1": "gate", "up_proj": "up", "w3": "up", "down_proj": "down", "w2": "down",
        "gate_up_proj": "gate_up", "fc1": "up", "fc2": "down", "c_fc": "up", "c_proj": "down",
        "q_proj": "q", "k_proj": "k", "v_proj": "v", "o_proj": "o", "out_proj": "o", "dense": "o",
        "qkv_proj": "qkv", "c_attn": "qkv", "query_key_value": "qkv", "Wqkv": "qkv", "in_proj_qkv": "qkv"}
EMBED = ("embed_tokens", "wte", "tok_embeddings", "word_embeddings", "embeddings")
HEAD = ("lm_head", "output", "embed_out")


def role(seg: str) -> str:
    return ROLE.get(seg, seg)


@dataclass
class FfnLayout:
    prefix: str
    moe: bool
    proj: dict = field(default_factory=dict)          # dense: role -> [names] (weight first, then bias)
    router: list = field(default_factory=list)        # router tensors, all [E, ...]
    experts: dict = field(default_factory=dict)       # per-expert: j -> {role: [names]}
    fused: dict = field(default_factory=dict)         # fused: role -> [names] with dim 0 = E
    shared: dict = field(default_factory=dict)        # role -> [names]
    shared_prefix: str = ""
    num_experts: int = 0
    other: list = field(default_factory=list)


@dataclass
class LayerLayout:
    index: int
    prefix: str                                       # e.g. model.layers.3
    names: list = field(default_factory=list)
    attn_kind: str = ""                               # attention | mixer | ""
    attn_prefix: str = ""
    attn: dict = field(default_factory=dict)          # role -> [names]
    ffn: FfnLayout | None = None
    norms: list = field(default_factory=list)
    other: list = field(default_factory=list)


@dataclass
class Layout:
    prefix: str                                       # decoder prefix, e.g. "model." or "model.language_model."
    layers: list = field(default_factory=list)        # LayerLayout
    mtp: list = field(default_factory=list)           # LayerLayout past num_hidden_layers
    embed: list = field(default_factory=list)
    head: list = field(default_factory=list)
    norm: list = field(default_factory=list)
    other: list = field(default_factory=list)


def _add(d: dict, key, name: str) -> None:
    lst = d.setdefault(key, [])
    lst.append(name)
    lst.sort(key=lambda n: (not n.endswith("weight") and not n.split(".")[-1].endswith("proj"), n))


def _ffn(prefix: str, names: list[str], shapes: dict) -> FfnLayout:
    rel = {n: n[len(prefix) + 1:] for n in names}
    moe = any(r.startswith("experts.") for r in rel.values())
    f = FfnLayout(prefix, moe)
    for n, r in rel.items():
        segs = r.split(".")
        if not moe:
            _add(f.proj, role(segs[0]), n)
            continue
        if segs[0] == "experts":
            if segs[1].isdigit():
                f.experts.setdefault(int(segs[1]), {})
                _add(f.experts[int(segs[1])], role(segs[2]), n)
            else:
                _add(f.fused, role(segs[1].removesuffix("_bias") if segs[1].endswith("_bias") else segs[1]), n)
        elif segs[0] in ROUTERS or r == "e_score_correction_bias":
            f.router.append(n)
        elif segs[0] in SHARED:
            f.shared_prefix = f"{prefix}.{segs[0]}"
            _add(f.shared, role(segs[1]), n)
        elif segs[0] == "shared_expert_gate":
            _add(f.shared, "shared_gate", n)
        else:
            f.other.append(n)
    if moe:
        w = next((n for n in f.router if n.endswith("weight") and len(shapes[n]) == 2), None)
        if w:
            f.num_experts = shapes[w][0]
        elif f.experts:
            f.num_experts = max(f.experts) + 1
        else:
            f.num_experts = next(iter(shapes[n][0] for ns in f.fused.values() for n in ns))
        f.router.sort(key=lambda n: (not n.endswith(".weight"), n))
    return f


def parse(shapes: dict[str, tuple], num_layers: int) -> Layout:
    """shapes: tensor name -> shape."""
    groups: dict[str, dict[int, list[str]]] = {}
    for n in shapes:
        m = LAYER.match(n)
        if m:
            groups.setdefault(m["pre"], {}).setdefault(int(m["i"]), []).append(n)
    pre = max(groups, key=lambda p: sum(len(v) for v in groups[p].values())) if groups else ""
    lay = Layout(pre)
    decoder = groups.get(pre, {})
    seen = set()
    for i in sorted(decoder):
        names = sorted(decoder[i])
        seen.update(names)
        L = LayerLayout(i, f"{pre}layers.{i}", names)
        by_head: dict[str, list[str]] = {}
        for n in names:
            by_head.setdefault(n[len(L.prefix) + 1:].split(".")[0], []).append(n)
        for head, ns in by_head.items():
            if head in ATTN or head in MIXER:
                L.attn_kind = "attention" if head in ATTN else "mixer"
                L.attn_prefix = f"{L.prefix}.{head}"
                for n in ns:
                    _add(L.attn, role(n[len(L.attn_prefix) + 1:].split(".")[0]), n)
            elif head in FFN:
                L.ffn = _ffn(f"{L.prefix}.{head}", ns, shapes)
            elif "norm" in head:
                L.norms += ns
            else:
                L.other += ns
        (lay.layers if i < num_layers else lay.mtp).append(L)
    for n in shapes:
        if n in seen:
            continue
        segs = n.split(".")
        if any(s in EMBED for s in segs[:-1]) and n.startswith(pre) and not segs[0].startswith("vis"):
            lay.embed.append(n)
        elif segs[0] in HEAD:
            lay.head.append(n)
        elif len(segs) >= 2 and "norm" in segs[-2] and n == f"{pre}{segs[-2]}.{segs[-1]}":
            lay.norm.append(n)
        else:
            lay.other.append(n)
    return lay


RECURRENT_HINT = re.compile(r"linear|delta|mamba|ssm|recurrent|rwkv", re.I)
