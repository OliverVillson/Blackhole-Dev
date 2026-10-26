"""Built-in analysis `overview`: size, parts and fit, from the headers alone (reads no weights)."""

from collections import Counter

from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import gb


@analysis("overview", title="Overview", needs="headers")
def run(r, m, device: str = "M-series-16GB", context: int = 8192):
    "What the model is made of: parameters and GB per part, per layer, dtypes, and whether it fits a device."
    p = m.plan(device=device or None, context=context)
    i = m.info
    r.tiles([
        ("Parameters", p.params_b * 1e9, f"{len(m.layers)} layers"),
        ("Size", round(p.total_gb, 3), "GB as edited" + (f", was {p.before_gb:.2f}" if abs(p.before_gb - p.total_gb) > 1e-3 else "")),
        ("Active per token", round(p.active_gb, 3), "GB read per token"),
        *([("Experts", i.experts, f"top-{i.top_k} per token")] if i.experts else []),
        *([(f"Fits {device}", "yes" if p.fits else "no", f"{p.total_gb + p.kv_gb:.2f} of {p.budget_gb:.2f} GB with KV",
            "ok" if p.fits else "bad")] if p.budget_gb is not None else []),
        *([("Decode estimate", round(p.tok_s, 1), "tok/s, memory-bound")] if p.tok_s else []),
    ])
    groups = sorted(p.groups.items(), key=lambda kv: -kv[1]["gb"])
    r.bar("Size by part", [g for g, _ in groups], {"GB": [round(x["gb"], 4) for _, x in groups]}, ylabel="GB",
          horizontal=True)
    r.bar("Parameters by layer", [str(L.index) for L in m.layers], {"parameters": [L.params for L in m.layers]},
          xlabel="layer", ylabel="parameters")
    dt = Counter()
    for n, s in m._t.items():
        dt[s.dtype] += s.nbytes
    r.table("Storage dtypes", ["dtype", "tensors", "GB"],
            [[d, sum(1 for s in m._t.values() if s.dtype == d), gb(b)] for d, b in dt.most_common()])
    kinds = Counter(L.attrs.get("kind", "layer") for L in m.layers)
    r.table("Layer kinds", ["kind", "layers"], [[k, n] for k, n in kinds.most_common()])
    if p.problems:
        r.text("Problems: " + "; ".join(p.problems))
