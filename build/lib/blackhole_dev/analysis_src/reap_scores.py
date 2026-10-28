"""Built-in analysis `reap-scores`: REAP saliency and router usage for every layer x expert."""

import numpy as np

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, has_scores


def _cost(m, scores=""):
    if scores or has_scores(m):
        return 0
    return sum(cost([L.moe.router], 0) for L in m.layers if L.moe is not None)


@analysis("reap-scores", title="REAP scores and router usage", needs="weights", cost=_cost)
def run(r, m, scores: str = ""):
    """Heatmaps of REAP saliency and the share of tokens each expert gets, per layer, from the
    model's receipt or a saliency.json (`scores`). Without scores it falls back to router
    row norms, a weight-only proxy (reads the routers only)."""
    if scores:
        m.load_scores(scores)
    moe = [L for L in m.layers if L.moe is not None]
    if not moe:
        r.text("A dense model: no experts, no router.")
        return
    E = max(L.moe.num_experts for L in moe)
    cols = list(range(E))
    if has_scores(m):
        grid = [[(L.moe.experts[j].attrs.get("score") if j < L.moe.num_experts else None) for j in cols] for L in moe]
        r.heatmap("REAP saliency", [L.index for L in moe], cols, grid, label="saliency", xlabel="expert",
                  ylabel="layer")
        fr = [[(L.moe.experts[j].attrs.get("freq") if j < L.moe.num_experts else None) for j in cols] for L in moe]
        if any(v is not None for row in fr for v in row):
            r.heatmap("Router usage (share of tokens)", [L.index for L in moe], cols, fr, label="share",
                      xlabel="expert", ylabel="layer")
        means, spread = [], []
        for row in grid:
            v = np.array([x for x in row if x is not None], float)
            means.append(float(v.mean()) if v.size else None)
            spread.append(float(v.max() / max(v.mean(), 1e-30)) if v.size else None)
        r.line("Saliency per layer", [L.index for L in moe], {"mean": means}, xlabel="layer", ylabel="mean saliency")
        r.line("Peak-to-mean saliency per layer", [L.index for L in moe], {"max / mean": spread}, xlabel="layer",
               ylabel="max / mean", note="high = a few experts carry the layer; prune those layers harder")
        flat = sorted(((s, L.index, j) for L, row in zip(moe, grid) for j, s in enumerate(row) if s is not None))
        r.tiles([("Experts scored", len(flat)), ("Lowest", flat[0][0], f"layer {flat[0][1]} expert {flat[0][2]}"),
                 ("Highest", flat[-1][0], f"layer {flat[-1][1]} expert {flat[-1][2]}")])
    else:
        grid = []
        for L in moe:
            w = L.moe.router.weight.numpy()
            n = np.linalg.norm(w, axis=-1)
            grid.append([float(n[j]) if j < len(n) else None for j in cols])
        r.text("No REAP scores on this model: showing router row norms instead (a weight-only proxy for how "
               "eagerly the router picks each expert). Pass `scores` (a saliency.json) for the real thing.")
        r.heatmap("Router row norm", [L.index for L in moe], cols, grid, label="norm", xlabel="expert", ylabel="layer")
