"""Built-in function `reap-prune`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reap-prune`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("reap-prune", per="model")
def reap_prune(m, ratio: float = 0.25, min_keep: int = 0) -> dict:
    """REAP: drop the `ratio` lowest-scored experts of every MoE layer (the same count in
    every layer, never below top-k). Needs scores (`scores` on the stage, or load_scores)."""
    k = max(m.top_k, min_keep)
    dropped = 0
    for L in m.layers:
        if L.moe is None:
            continue
        ex = L.moe.experts
        if any(e.attrs.get("score") is None for e in ex):
            raise ValueError(f"layer {L.index}: experts have no scores; give the stage `scores` or call load_scores")
        n_keep = max(k, len(ex) - int(round(len(ex) * ratio)))
        g = m.tc.get("n_group") if isinstance(m.tc.get("n_group"), int) else 1
        if g > 1:
            n_keep = max(n_keep // g * g, g)
            size, per = len(ex) // g, n_keep // g
            keep = []
            for gi in range(g):
                grp = ex[gi * size:(gi + 1) * size]
                keep += [e.attrs["id"] for e in sorted(grp, key=lambda e: (-e.attrs["score"], e.attrs["id"]))[:per]]
        else:
            keep = [e.attrs["id"] for e in sorted(ex, key=lambda e: (-e.attrs["score"], e.attrs["id"]))[:n_keep]]
        dropped += len(ex) - len(keep)
        m.keep_experts(L.index, sorted(keep), note="reap")
    return {"experts_dropped": dropped}
