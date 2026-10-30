"""Built-in function `smoe-partition`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork smoe-partition`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
dense-to-SMoE steps is blackhole_dev/functions_src/_smoe.py."""

from __future__ import annotations

import json

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _smoe


@function("smoe-partition", per="job")
def smoe_partition(job, experts: int = 64, shared_frac: float = 0.03, refine_passes: int = 10, seed: int = 0) -> dict:
    """Step 2 of dense-to-SMoE, CPU only: per layer the most ubiquitous neurons become the
    always-on shared expert (`shared_frac` of the FFN, Qwen2-MoE targets only), the rest split
    into `experts` equal groups by balanced spectral clustering of the co-activation sketch,
    then greedy swaps raise the co-activation kept inside experts. Reports the cut share (mass
    split across experts) and within/bound (the Ky Fan upper bound; 1 = the best any partition
    could do on the sketch)."""
    P = np.load(_smoe.work(job) / "profile.npz", allow_pickle=False)

    def on_layer(idx, row):
        _smoe.log(f"partition layer {idx}: cut share {row['cut_share']:.3f}, within/bound {row['within_over_bound']:.3f}")
        job.emit(pct=100 * (list(P["layer_ids"]).index(idx) + 1) / len(P["layer_ids"]), msg=f"layer {idx}")

    Q, per_layer = _smoe.partition(P, experts, shared_frac, refine_passes, seed, on_layer)
    _smoe._save_npz(_smoe.work(job) / "partition.npz", **Q)
    (_smoe.work(job) / "partition.json").write_text(json.dumps(per_layer, indent=1) + "\n")
    rows = list(per_layer.values())
    return {"experts": int(Q["N"]), "expert_width": int(Q["s"]), "shared_width": int(Q["s0"]),
            "mean_cut_share": float(np.mean([r["cut_share"] for r in rows])),
            "mean_within_over_bound": float(np.mean([r["within_over_bound"] for r in rows]))}
