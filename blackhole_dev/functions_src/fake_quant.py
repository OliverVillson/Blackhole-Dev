"""Built-in function `fake-quant`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork fake-quant`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("fake-quant", per="tensor")
def fake_quant(w: np.ndarray, format: str = "int4", select: str = "") -> np.ndarray:  # noqa: A002
    """Replace weights with their round-to-nearest value in `format` (to measure a format's
    effect end to end on a model that stays 16-bit)."""
    from blackhole.anatomy.formats import fake_quant as fq
    return w if w.ndim < 2 else fq(w, format)
