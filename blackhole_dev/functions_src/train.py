"""Built-in function `train`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork train`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("train", per="model")
def train(m, select: str = "layers[*].moe.router") -> dict:
    """Mark the matched parts trainable for training stages (heal, distil)."""
    return {"parts": len(m.select(select).train())}
