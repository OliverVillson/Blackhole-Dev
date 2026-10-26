"""Built-in analysis `expert-stats`: every expert of one layer, side by side."""

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, sampled_stats


def _cost(m, layer=0, sample=128):
    L = m.layers[layer]
    return cost(L.moe.experts, sample) if L.moe is not None else 0


@analysis("expert-stats", title="Experts of a layer", needs="weights", cost=_cost)
def run(r, m, layer: int = 0, sample: int = 128):
    """REAP score, routed share, RMS and kurtosis of each expert in `layer`, and score against
    weight size (do the experts REAP keeps have bigger weights?)."""
    L = m.layers[layer]
    if L.moe is None:
        raise ValueError(f"layer {layer} has no experts (a {L.attrs.get('kind', 'dense')} layer)")
    rows = []
    for e in L.moe.experts:
        s = sampled_stats([e], sample)
        rows.append({"id": e.attrs["id"], "score": e.attrs.get("score"), "freq": e.attrs.get("freq"),
                     "rank": e.attrs.get("rank"), "rms": s["rms"], "kurtosis": s["kurtosis"], "absmax": s["absmax"]})
    ids = [str(x["id"]) for x in rows]
    scored = all(x["score"] is not None for x in rows)
    if scored:
        r.bar(f"REAP score, layer {layer}", ids, {"score": [x["score"] for x in rows]}, xlabel="expert", ylabel="score")
        if all(x["freq"] is not None for x in rows):
            r.bar(f"Router usage, layer {layer}", ids, {"share of tokens": [x["freq"] for x in rows]},
                  xlabel="expert", ylabel="share")
        r.scatter("Score against weight RMS", {"experts": ([x["rms"] for x in rows], [x["score"] for x in rows])},
                  xlabel="weight RMS", ylabel="REAP score", labels={"experts": [f"expert {i}" for i in ids]})
    else:
        r.text("No REAP scores on this model yet: run the `reap-score` function, or open a model whose "
               "blackhole-anatomy.json carries scores, to see score and router usage here.")
    r.bar(f"Weight RMS, layer {layer}", ids, {"rms": [x["rms"] for x in rows]}, xlabel="expert", ylabel="RMS")
    r.bar(f"Kurtosis, layer {layer}", ids, {"kurtosis": [x["kurtosis"] for x in rows]}, xlabel="expert",
          ylabel="kurtosis")
    r.table(f"Experts of layer {layer}", ["expert", "score", "freq", "rank", "rms", "kurtosis", "absmax"],
            [[x["id"], x["score"], x["freq"], x["rank"], round(x["rms"], 6), round(x["kurtosis"], 3),
              round(x["absmax"], 5)] for x in rows])
