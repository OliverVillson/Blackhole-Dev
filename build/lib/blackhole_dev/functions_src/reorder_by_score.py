"""Built-in function `reorder-by-score`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reorder-by-score`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("reorder-by-score", per="model")
def reorder_by_score(m) -> dict:
    """Sort every MoE layer's experts by REAP score, highest first: hot experts get the low
    ids, one contiguous range per tier for tiered kernels and hot/cold placement."""
    n = 0
    for L in m.layers:
        if L.moe is not None:
            L.moe.reorder("score")
            n += 1
    return {"layers": n}
