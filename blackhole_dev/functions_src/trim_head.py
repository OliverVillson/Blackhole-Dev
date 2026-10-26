"""Built-in function `trim-head`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork trim-head`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import json
from pathlib import Path

from blackhole_dev.functions import function


@function("trim-head", per="model")
def trim_head(m, keep: list = (), file: str = "") -> dict:
    """Output-only vocab trim: keep these token ids (or the JSON list in `file`) in the LM head."""
    ids = list(keep) or json.loads(Path(file).read_text())
    m.trim_head(ids)
    return {"head_vocab": len(m.head_vocab)}
