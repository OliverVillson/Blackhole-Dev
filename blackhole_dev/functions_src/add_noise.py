"""Built-in function `add-noise`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork add-noise`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("add-noise", per="tensor")
def add_noise(w: np.ndarray, std: float = 0.01, seed: int = 0, select: str = "") -> np.ndarray:
    """Gaussian noise relative to each tensor's std (robustness probes, symmetry breaking for
    duplicated experts)."""
    rng = np.random.default_rng(seed + w.size)
    return w + rng.standard_normal(w.shape, dtype=np.float32) * np.float32(std * (float(w.std()) or 1.0))
