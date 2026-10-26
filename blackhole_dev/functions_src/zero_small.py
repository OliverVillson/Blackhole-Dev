"""Built-in function `zero-small`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork zero-small`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("zero-small", per="tensor")
def zero_small(w: np.ndarray, fraction: float = 0.1, select: str = "layers[*]") -> np.ndarray:
    """Unstructured magnitude pruning: zero the smallest `fraction` of every matrix (the file
    does not shrink; it measures what a sparse kernel could skip)."""
    if w.ndim < 2 or fraction <= 0:
        return w
    t = np.quantile(np.abs(w), fraction)
    return np.where(np.abs(w) < t, np.float32(0), w)
