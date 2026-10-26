"""Built-in function `hex-pack`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork hex-pack`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np

from blackhole.anatomy import st
from blackhole_dev.functions import function
from blackhole_dev.functions_src._helpers import LAYOUT, _Const


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
