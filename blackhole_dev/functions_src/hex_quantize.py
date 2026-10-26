"""Built-in function `hex-quantize`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork hex-quantize`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole.anatomy import hex as hx
from blackhole_dev.functions import function
from blackhole_dev.functions_src._helpers import _block_for, _levels_for, _texts


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
