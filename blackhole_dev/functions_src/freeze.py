"""Built-in function `freeze`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork freeze`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("freeze", per="model")
def freeze(m, select: str = "layers[*]") -> dict:
    """Mark the matched parts frozen for training stages (heal, distil)."""
    return {"parts": len(m.select(select).freeze())}
