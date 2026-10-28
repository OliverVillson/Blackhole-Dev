"""Built-in function `scale`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork scale`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("scale", per="tensor")
def scale(w: np.ndarray, factor: float = 1.0, select: str = "") -> np.ndarray:
    """Multiply the matched weights by `factor`."""
    return w * np.float32(factor)
