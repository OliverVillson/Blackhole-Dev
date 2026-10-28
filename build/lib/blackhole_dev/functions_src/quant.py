"""Built-in function `quant`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork quant`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("quant", per="model")
def quant(m, select: str = "layers[*]", format: str = "int4") -> dict:  # noqa: A002
    """Give the matched parts a storage format (bf16, fp8, intN, mlxN, nvfp4, hex3, hex4, ...)."""
    sel = m.select(select)
    sel.quant(format)
    return {"parts": len(sel)}
