"""Built-in function `clip-outliers`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork clip-outliers`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("clip-outliers", per="tensor")
def clip_outliers(w: np.ndarray, sigma: float = 6.0, select: str = "layers[*].attn") -> np.ndarray:
    """Clip every weight beyond sigma standard deviations of its tensor."""
    if w.ndim < 2:
        return w
    s = float(w.std()) or 1.0
    mu = float(w.mean())
    return np.clip(w, mu - sigma * s, mu + sigma * s)
