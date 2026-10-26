"""Built-in function `drop-layers`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork drop-layers`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("drop-layers", per="model")
def drop_layers(m, ids: list = ()) -> dict:
    """Drop whole decoder layers (measured badly on Qwen3-8B: -4 layers cost KL 0.99)."""
    m.drop_layers(list(ids))
    return {"layers_dropped": len(ids)}
