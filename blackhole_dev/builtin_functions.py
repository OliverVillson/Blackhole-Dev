"""The built-in named functions. Each is a few lines on top of the anatomy API, so they double
as examples for writing your own (see blackhole_dev.functions)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from blackhole_dev.functions import function

# --------------------------------------------------------------------------- structure


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


@function("drop-experts", per="model")
def drop_experts(m, select: str = "experts[rank<0.25]") -> dict:
    """Drop the experts a query matches (every MoE layer must end with the same count)."""
    sel = m.select(select)
    sel.drop()
    return {"experts_dropped": len(sel)}


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


@function("reorder-by-score", per="model")
def reorder_by_score(m) -> dict:
    """Sort every MoE layer's experts by REAP score, highest first: hot experts get the low
    ids, one contiguous range per tier for tiered kernels and hot/cold placement."""
    n = 0
    for L in m.layers:
        if L.moe is not None:
            L.moe.reorder("score")
            n += 1
    return {"layers": n}


@function("drop-layers", per="model")
def drop_layers(m, ids: list = ()) -> dict:
    """Drop whole decoder layers (measured badly on Qwen3-8B: -4 layers cost KL 0.99)."""
    m.drop_layers(list(ids))
    return {"layers_dropped": len(ids)}


@function("duplicate-layers", per="model")
def duplicate_layers(m, ids: list = ()) -> dict:
    """Depth up-scaling: insert a copy of each listed layer right after it (heal afterwards)."""
    for i in sorted((int(x) for x in ids), reverse=True):
        m.duplicate_layer(i)
    return {"layers_added": len(ids)}


@function("prune-neurons", per="model")
def prune_neurons(m, ratio: float = 0.125, select: str = "layers[*].mlp") -> dict:
    """Drop the `ratio` lowest-importance intermediate channels of every dense MLP the query
    matches (weight-norm importance; heal afterwards: the dense default prunes 12.5 to 25%)."""
    n = 0
    for p in m.select(select):
        p.prune_neurons(ratio=ratio)
        n += 1
    return {"mlps": n}


@function("trim-head", per="model")
def trim_head(m, keep: list = (), file: str = "") -> dict:
    """Output-only vocab trim: keep these token ids (or the JSON list in `file`) in the LM head."""
    ids = list(keep) or json.loads(Path(file).read_text())
    m.trim_head(ids)
    return {"head_vocab": len(m.head_vocab)}


# --------------------------------------------------------------------------- formats and training


@function("quant", per="model")
def quant(m, select: str = "layers[*]", format: str = "int4") -> dict:  # noqa: A002
    """Give the matched parts a storage format (bf16, fp8, intN, mlxN, nvfp4, hex3, hex4, ...)."""
    sel = m.select(select)
    sel.quant(format)
    return {"parts": len(sel)}


@function("reaq", per="model")
def reaq(m, avg_bits: float = 3.5, hi: str = "hex4", lo: str = "hex3") -> dict:
    """REAQ: REAP scores pick each expert's format so the average lands at avg_bits."""
    out = m.reaq(avg_bits=avg_bits, hi=hi, lo=lo)
    return {"layers": len(out), "experts_hi": sum(out.values())}


@function("freeze", per="model")
def freeze(m, select: str = "layers[*]") -> dict:
    """Mark the matched parts frozen for training stages (heal, distil)."""
    return {"parts": len(m.select(select).freeze())}


@function("train", per="model")
def train(m, select: str = "layers[*].moe.router") -> dict:
    """Mark the matched parts trainable for training stages (heal, distil)."""
    return {"parts": len(m.select(select).train())}


@function("router-temperature", per="part")
def router_temperature(router, t: float = 1.0, select: str = "layers[*].moe.router"):
    """Divide router logits by t (t > 1 spreads the load, t < 1 sharpens the routing)."""
    router.temperature(t)


# --------------------------------------------------------------------------- weight-level


@function("clip-outliers", per="tensor")
def clip_outliers(w: np.ndarray, sigma: float = 6.0, select: str = "layers[*].attn") -> np.ndarray:
    """Clip every weight beyond sigma standard deviations of its tensor."""
    if w.ndim < 2:
        return w
    s = float(w.std()) or 1.0
    mu = float(w.mean())
    return np.clip(w, mu - sigma * s, mu + sigma * s)


@function("zero-small", per="tensor")
def zero_small(w: np.ndarray, fraction: float = 0.1, select: str = "layers[*]") -> np.ndarray:
    """Unstructured magnitude pruning: zero the smallest `fraction` of every matrix (the file
    does not shrink; it measures what a sparse kernel could skip)."""
    if w.ndim < 2 or fraction <= 0:
        return w
    t = np.quantile(np.abs(w), fraction)
    return np.where(np.abs(w) < t, np.float32(0), w)


@function("scale", per="tensor")
def scale(w: np.ndarray, factor: float = 1.0, select: str = "") -> np.ndarray:
    """Multiply the matched weights by `factor`."""
    return w * np.float32(factor)


@function("add-noise", per="tensor")
def add_noise(w: np.ndarray, std: float = 0.01, seed: int = 0, select: str = "") -> np.ndarray:
    """Gaussian noise relative to each tensor's std (robustness probes, symmetry breaking for
    duplicated experts)."""
    rng = np.random.default_rng(seed + w.size)
    return w + rng.standard_normal(w.shape, dtype=np.float32) * np.float32(std * (float(w.std()) or 1.0))


@function("fake-quant", per="tensor")
def fake_quant(w: np.ndarray, format: str = "int4", select: str = "") -> np.ndarray:  # noqa: A002
    """Replace weights with their round-to-nearest value in `format` (to measure a format's
    effect end to end on a model that stays 16-bit)."""
    from blackhole.anatomy.formats import fake_quant as fq
    return w if w.ndim < 2 else fq(w, format)
