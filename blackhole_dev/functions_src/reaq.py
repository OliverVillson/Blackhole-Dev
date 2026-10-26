"""Built-in function `reaq`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reaq`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("reaq", per="model")
def reaq(m, avg_bits: float = 3.5, hi: str = "hex4", lo: str = "hex3") -> dict:
    """REAQ: REAP scores pick each expert's format so the average lands at avg_bits."""
    out = m.reaq(avg_bits=avg_bits, hi=hi, lo=lo)
    return {"layers": len(out), "experts_hi": sum(out.values())}
