"""Built-in analysis `layer-stats`: one weight statistic per layer, a line per kind of part."""

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import GROUP_ORDER, cost, layer_groups, sampled_stats

METRICS = ("rms", "std", "absmax", "kurtosis", "crest", "zero_frac", "mean_abs")


def _cost(m, metric="rms", sample=256):
    return sum(cost(ps, sample) for L in m.layers for ps in layer_groups(L).values())


@analysis("layer-stats", title="Weight stats by layer", needs="weights", cost=_cost)
def run(r, m, metric: str = "kurtosis", sample: int = 256):
    """A weight statistic (rms, std, absmax, kurtosis, crest, zero_frac, mean_abs) for each
    layer's attention, mixer, MLP, experts, shared expert and router. `sample` rows per matrix
    (0 = every row, exact but reads the whole model). High kurtosis and crest mean heavy
    tails: those layers lose most to low-bit quantization."""
    if metric not in METRICS:
        raise ValueError(f"metric is one of {', '.join(METRICS)}")
    table, series = [], {}
    for L in m.layers:
        r.progress(f"layer {L.index}", L.index / max(len(m.layers), 1))
        for g, ps in layer_groups(L).items():
            s = sampled_stats(ps, sample)
            series.setdefault(g, {})[L.index] = s[metric]
            table.append([L.index, g, round(s["rms"], 6), round(s["absmax"], 5), round(s["kurtosis"], 3),
                          round(s["crest"], 2), round(s["zero_frac"], 5)])
    x = [L.index for L in m.layers]
    order = [g for g in GROUP_ORDER if g in series]
    r.line(f"{metric} by layer", x, {g: [series[g].get(i) for i in x] for g in order}, xlabel="layer", ylabel=metric,
           note=f"{'every row' if sample <= 0 else f'{sample} sampled rows per matrix'}")
    worst = max(table, key=lambda row: row[4]) if table else None
    if worst:
        r.tiles([("Heaviest tails", f"layer {worst[0]} {worst[1]}", f"kurtosis {worst[4]}"),
                 ("Largest weight", max(row[3] for row in table), "absmax")])
    r.table("Per layer and part", ["layer", "part", "rms", "absmax", "kurtosis", "crest", "zero_frac"], table)
