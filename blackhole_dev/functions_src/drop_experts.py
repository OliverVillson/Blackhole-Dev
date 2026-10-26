"""Built-in function `drop-experts`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork drop-experts`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("drop-experts", per="model")
def drop_experts(m, select: str = "experts[rank<0.25]") -> dict:
    """Drop the experts a query matches (every MoE layer must end with the same count)."""
    sel = m.select(select)
    sel.drop()
    return {"experts_dropped": len(sel)}
