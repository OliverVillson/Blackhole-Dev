"""Built-in analysis `quant-error`: round-to-nearest error of storage formats on some parts."""

import numpy as np

from blackhole.anatomy import formats as fmt
from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, sample as read_rows, views_of


def _cost(m, query="layers[0].moe.experts[0]", formats="", sample=128):
    return cost(m[query], sample)


@analysis("quant-error", title="Quantization error by format", needs="weights", cost=_cost)
def run(r, m, query: str = "layers[0].moe.experts[0]", formats: str = "int4,int3,hex4,hex3,mxfp4,q4_k",
        sample: int = 128):
    """Relative error and SNR of each format on the parts a query matches (round-to-nearest:
    a probe for comparing formats and parts; GPTQ and HEX with GPTQ rounding do better)."""
    names = [f.strip() for f in formats.split(",") if f.strip()]
    for f in names:
        fmt.check(f)
    vs = views_of(m[query])
    if not vs:
        raise ValueError(f"{query!r} has no weight matrices")
    ws = [read_rows(v, sample) for v in vs]
    rows = []
    for f in names:
        err = ref = 0.0
        for w in ws:
            q = fmt.fake_quant(w, f)
            err += float(np.sum((w.astype(np.float64) - q) ** 2))
            ref += float(np.sum(w.astype(np.float64) ** 2))
        rel = err / (ref or 1e-30)
        rows.append([f, fmt.bpw(f), rel, -10 * np.log10(max(rel, 1e-30))])
    r.bar("SNR by format", [x[0] for x in rows], {"SNR (dB)": [round(x[3], 2) for x in rows]}, ylabel="dB",
          note="higher is better")
    r.scatter("Error against size", {"formats": ([x[1] for x in rows], [x[2] for x in rows])},
              xlabel="bits per weight", ylabel="relative MSE", labels={"formats": [x[0] for x in rows]})
    r.table(f"Formats on {query}", ["format", "bits/weight", "rel MSE", "SNR dB"],
            [[x[0], round(x[1], 3), x[2], round(x[3], 2)] for x in rows])
