"""Built-in function `reap-score`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reap-score`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function
from blackhole_dev.functions_src._helpers import _texts


@function("reap-score", per="model")
def reap_score(m, calib: list = (), max_seq: int = 2048, device: str = "cpu") -> dict:
    """REAP saliency of every expert over the calibration texts (router weight x expert output
    norm, averaged over the tokens routed to it), written onto the experts as score / freq /
    rank. `calib` is a list of texts or token-id lists, or a path to a .jsonl / .txt file."""
    live = m.live(device=device)
    res = live.reap_scores(_texts(calib), max_seq)
    return {"layers": len(res), "experts": sum(len(r["saliency"]) for r in res.values())}
