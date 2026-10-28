"""Built-in analysis `weight-histogram`: the distribution of the weights of any parts."""

import numpy as np

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, sampled_values


def _cost(m, query="experts", bins=80, sample=256):
    return cost(m[query], sample)


@analysis("weight-histogram", title="Weight distribution", needs="weights", cost=_cost)
def run(r, m, query: str = "experts", bins: int = 80, sample: int = 256):
    """Histogram of the weights of the parts a query matches (e.g. `experts`, `layers[3].attn`,
    `experts[rank<0.25]`), log scale, with the stats a quantizer cares about."""
    sel = m[query]
    if not sel:
        raise ValueError(f"{query!r} matches nothing")
    a = sampled_values(sel, sample)
    if not a.size:
        raise ValueError(f"{query!r} has no weight matrices")
    mean, std = float(a.mean()), float(a.std())
    absmax = float(np.abs(a).max())
    kurt = float(((a - mean) ** 4).mean() / max(std ** 4, 1e-30))
    lim = float(np.quantile(np.abs(a), 0.9999)) * 1.05 or absmax
    counts, edges = np.histogram(np.clip(a, -lim, lim), bins=bins, range=(-lim, lim))
    r.tiles([("Parts", len(sel), query), ("Weights sampled", int(a.size)), ("Std", std), ("Absmax", absmax),
             ("Kurtosis", round(kurt, 3), "3 = Gaussian"), ("Beyond 6 std", float((np.abs(a - mean) > 6 * std).mean()),
                                                           "share of weights")])
    r.hist(f"Weights of {query}", edges.tolist(), counts.tolist(), xlabel="weight", logy=True,
           note=f"clipped at ±{lim:.4g} (the 99.99th percentile)")
