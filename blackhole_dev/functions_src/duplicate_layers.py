"""Built-in function `duplicate-layers`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork duplicate-layers`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("duplicate-layers", per="model")
def duplicate_layers(m, ids: list = ()) -> dict:
    """Depth up-scaling: insert a copy of each listed layer right after it (heal afterwards)."""
    for i in sorted((int(x) for x in ids), reverse=True):
        m.duplicate_layer(i)
    return {"layers_added": len(ids)}
