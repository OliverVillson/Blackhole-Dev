"""The REAP / REAQ / HEX recipe as named functions on the anatomy API.

    m = anatomy.open(path)
    live = m.live()
    live.reap_scores(texts)                   # REAP saliency onto m's experts   (fn: reap-score)
    m.call("reap-prune", ratio=0.25)          # REAP: drop the lowest 25% per layer
    m.call("reaq", avg_bits=3.5)              # REAQ: hex4 for the hot experts, hex3 for the rest
    m.call("hex-quantize", calib=texts)       # HEX tables + GPTQ rounding, weights written back
    m.save(out)                               # a bf16 checkpoint any loader reads (weights on-table)
    m.call("hex-pack", dst=out_packed)        # the packed codebook layout for the HEX kernels

hex-quantize keeps the model loadable everywhere: every expert's weights are replaced by their
HEX dequantized values (exactly what the packed form decodes to), and the headers (tables,
scales, indices) are kept on the model so hex-pack can write the packed layout without
quantizing again. The packed layout is the pipeline's (harness/blackhole_pipeline/stages/reaq.py
LAYOUT, flint_mlx.py HEX kernel): per MoE layer and tier, gate_up [n, 2I, H] and down [n, H, I]
as idx / block_scale / expert_scale / levels.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np

from blackhole.anatomy import hex as hx
from blackhole.anatomy import st
from blackhole_dev.functions import function

LAYOUT = """HEX experts (Header-Encoded eXperts, BlackHole-Harness layout v1; blackhole.anatomy.hex is the source of truth)

Per MoE layer and tier (tier16 = 16-level tables = 4 bits, tier8 = 8-level = 3 bits), for each
projection p in {gate_proj, up_proj, down_proj} (or the checkpoint's own role names for other
layouts), stacked over the n experts of the tier, inputs padded to a multiple of 32:
  <experts>.tier<L>.experts          int32   [n]                    expert ids in this tier
  <experts>.tier<L>.<p>.idx          uint32  [n, out, in/32*bits]   indices, `bits` per weight, one
                                                                    little-endian bit stream per block
                                                                    of 32 inputs (= bits words)
  <experts>.tier<L>.<p>.block_scale  uint8   [n, out, in/32]        fp8 e4m3 scale per block
  <experts>.tier<L>.<p>.expert_scale float32 [n]
  <experts>.tier<L>.<p>.levels       float32 [n, L]                 sorted level table in [-1, 1]
weight[e, o, i] = levels[e, idx[e, o, i]] * fp8(block_scale[e, o, i // 32]) * expert_scale[e]
Everything else (attention, routers, shared experts, embeddings, LM head) is stored as in the
source model. blackhole.anatomy.hex.hex_dequant() (torch) and unpack_expert() (numpy) rebuild
the weights; the MLX export and the Metal / Triton kernels read the same parts.
"""


def _levels_for(m, expert, default: int) -> int:
    for v in expert.views:
        f = m.formats.get((v.name, v.row))
        if f and f.startswith("hex"):
            return 16 if f.startswith("hex4") else 8
    return default


def _block_for(m, expert, default: int) -> int:
    for v in expert.views:
        f = m.formats.get((v.name, v.row))
        if f and f.startswith("hex") and "/b" in f:
            return int(f.split("/b")[1])
    return default


@function("reap-score", per="model")
def reap_score(m, calib: list = (), max_seq: int = 2048, device: str = "cpu") -> dict:
    """REAP saliency of every expert over the calibration texts (router weight x expert output
    norm, averaged over the tokens routed to it), written onto the experts as score / freq /
    rank. `calib` is a list of texts or token-id lists, or a path to a .jsonl / .txt file."""
    live = m.live(device=device)
    res = live.reap_scores(_texts(calib), max_seq)
    return {"layers": len(res), "experts": sum(len(r["saliency"]) for r in res.values())}


@function("hex-quantize", per="model")
def hex_quantize(m, levels: int = 8, block: int = 32, calib: list = (), gptq: bool = True, max_seq: int = 2048,
                 device: str = "cpu", select: str = "experts") -> dict:
    """HEX: per-expert learned level tables (REAQ marks from `reaq` decide 8 or 16 levels per
    expert, else `levels`), fp8 block scales, GPTQ rounding onto the tables when `calib` texts
    are given (nearest-level otherwise). Writes the dequantized weights back into the experts
    (the saved model loads anywhere) and keeps the headers for hex-pack."""
    experts = [e for e in m.select(select) if e.kind == "expert"]
    if not experts:
        raise ValueError(f"{select!r} matches no experts")
    stats = None
    texts = _texts(calib)
    if texts:
        live = m.live(device=device)
        stats = live.expert_hessians(texts, max_seq, layers=sorted({e.attrs["layer"] for e in experts}))
    err = ref = 0.0
    bits = 0.0
    n_params = 0
    for e in experts:
        L = _levels_for(m, e, levels)
        blk = _block_for(m, e, block)
        key = (e.attrs["layer"], e.attrs["id"])
        for role, views in hx.expert_matrices(e).items():
            W = np.concatenate([v.numpy() for v in views], axis=0) if len(views) > 1 else views[0].numpy()
            if W.ndim != 2:
                continue
            H = energy = None
            if stats is not None and key in stats and role in stats[key]:
                H = stats[key][role]
                energy = np.diag(H) / max(stats[key].get("tokens", 1), 1)
            h = hx.quantize(W, L, blk, energy, H if gptq else None)
            Q = h.dequant()
            err += float(((W.astype(np.float64) - Q) ** 2).sum())
            ref += float((W.astype(np.float64) ** 2).sum())
            bits += h.bpw * W.size
            n_params += W.size
            m.hex[(e.attrs["layer"], e.attrs["id"], role)] = h
            off = 0
            for v in views:
                rows = v.shape[0]
                v.set(Q[off:off + rows])
                off += rows
            for v in views:
                m.formats[(v.name, v.row)] = f"hex{4 if L == 16 else 3}" + (f"/b{blk}" if blk != 32 else "")
    rel = err / (ref or 1e-30)
    return {"experts": len(experts), "bpw": round(bits / max(n_params, 1), 4), "rel_mse": rel,
            "rounding": "gptq" if stats is not None and gptq else "nearest"}


@function("hex-pack", per="model")
def hex_pack(m, dst: str = "") -> dict:
    """Write the HEX-quantized model in the packed codebook layout (indices, fp8 block scales,
    expert scales, tables per tier) that the pipeline's HEX kernels and loaders read. Needs
    hex-quantize first. Non-expert tensors are copied as they are."""
    if not m.hex:
        raise ValueError("no HEX headers on this model: run hex-quantize first")
    if not dst:
        raise ValueError("hex-pack needs dst=<folder>")
    out = Path(dst).expanduser()
    tmp = out.with_name(out.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    done_names: set[str] = set()
    tensors: list = []
    tiers: dict = {}
    for L in m.layers:
        if L.moe is None:
            continue
        li = L.index
        by_tier: dict[int, list] = {}
        for e in L.moe.experts:
            key = (li, e.attrs["id"], "down")
            if key not in m.hex:
                continue
            by_tier.setdefault(m.hex[key].L, []).append(e)
        if not by_tier:
            continue
        prefix = m.layout.layers[li].ffn.prefix + ".experts"
        for lv, es in sorted(by_tier.items(), reverse=True):
            t = f"{prefix}.tier{lv}"
            tensors.append((f"{t}.experts", "I32", (len(es),), _Const(np.array([e.attrs["id"] for e in es], np.int32))))
            roles = sorted({r for e in es for (a, b, r) in m.hex if (a, b) == (li, e.attrs["id"])})
            for role in roles:
                hs = [m.hex[(li, e.attrs["id"], role)] for e in es]
                parts = [h.packed() for h in hs]
                if role == "gate_up":
                    I = hs[0].shape[0] // 2
                    splits = {"gate_proj": slice(0, I), "up_proj": slice(I, 2 * I)}
                elif role == "down":
                    splits = {"down_proj": slice(None)}
                else:
                    splits = {role: slice(None)}
                for proj, sl in splits.items():
                    for name, dt in (("idx", "U32"), ("block_scale", "U8"), ("expert_scale", "F32"), ("levels", "F32")):
                        arr = np.stack([p[name][sl] if p[name].ndim == 2 else p[name] for p in parts])
                        if name == "expert_scale":
                            arr = arr.reshape(len(es))
                        tensors.append((f"{t}.{proj}.{name}", dt, arr.shape, _Const(arr)))
            for e in es:
                done_names.update(v.name for v in e.views)
            tiers.setdefault(str(lv), 0)
            tiers[str(lv)] += len(es)
        bits = sum(m.hex[(li, e.attrs["id"], "down")].bpw for e in L.moe.experts if (li, e.attrs["id"], "down") in m.hex)
    for n in m.tensor_names:
        if n in done_names:
            continue
        s = m._t[n]
        tensors.append((n, s.dtype, s.shape, s))
    total = st.write_file(tmp / "model.safetensors", tensors, {"format": "pt"})
    cfg = m.synced_config()
    cfg["quantization_config"] = {"quant_method": "blackhole-hex", "version": 1,
                                  "block": next(iter(m.hex.values())).block, "tiers": tiers, "rank": "REAP saliency",
                                  "bits": {"16": 4, "8": 3}, "layout": "see HEX_LAYOUT.txt"}
    (tmp / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
    (tmp / "HEX_LAYOUT.txt").write_text(LAYOUT)
    for p in m.extra_files:
        if p.is_file():
            shutil.copy2(p, tmp / p.name)
    rec = m.receipt()
    rec["output_bytes"] = total
    rec["packed"] = "hex"
    (tmp / "blackhole-anatomy.json").write_text(json.dumps(rec, indent=2, default=str) + "\n")
    shutil.rmtree(out, ignore_errors=True)
    tmp.rename(out)
    return {"bytes": total, "gb": round(total / 1e9, 4), "tiers": tiers}


class _Const:
    def __init__(self, a: np.ndarray):
        self.a = np.ascontiguousarray(a)

    @property
    def nbytes(self) -> int:
        return self.a.nbytes

    def write(self, fd: int) -> None:
        import os
        os.write(fd, self.a.tobytes())


def _texts(calib) -> list:
    if isinstance(calib, (str, Path)):
        p = Path(calib)
        if p.suffix == ".jsonl":
            rows = [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
            return [r["text"] if isinstance(r, dict) and "text" in r else r for r in rows]
        return [x for x in p.read_text().split("\n\n") if x.strip()]
    return list(calib or [])
