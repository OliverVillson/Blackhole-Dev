"""Built-in function `merge-similar-experts`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork merge-similar-experts`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function


@function("merge-similar-experts", per="model")
def merge_similar(m, pairs: int = 1, among: float = 0.5, sketch: int = 4096) -> dict:
    """In every MoE layer, merge the `pairs` most similar pairs of experts among the `among`
    lowest-scored share (all experts when there are no scores). Similarity is the cosine of the
    same `sketch` randomly chosen weights of every expert, so it reads a few KB per expert.
    Each merge leaves one expert fewer, so give every layer the same `pairs`."""
    merged = 0
    for L in m.layers:
        if L.moe is None:
            continue
        for _ in range(pairs):
            ex = m.layers[L.index].moe.experts
            pool = ex
            if all(e.attrs.get("score") is not None for e in ex):
                pool = sorted(ex, key=lambda e: e.attrs["score"])[:max(2, int(len(ex) * among))]
            if len(pool) < 2:
                break
            rng = np.random.default_rng(L.index)
            picks = {}
            for v in pool[0].views:
                if len(v.shape) >= 2:
                    n = int(np.prod(v.shape))
                    picks[v.label] = np.unravel_index(rng.integers(0, n, min(sketch, n)), v.shape)
            X = np.stack([np.concatenate([np.ravel(v[picks[v.label]]) for v in e.views if v.label in picks])
                          for e in pool])
            X = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-12)
            S = X @ X.T
            np.fill_diagonal(S, -2)
            a, b = np.unravel_index(int(np.argmax(S)), S.shape)
            m.merge_experts(L.index, [pool[a].attrs["id"], pool[b].attrs["id"]])
            merged += 1
    return {"pairs_merged": merged}
