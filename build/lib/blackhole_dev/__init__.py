"""blackhole_dev: the BlackHole dev training harness. Open any model and work on its parts, down to single weights.

    import blackhole_dev as anatomy
    m = anatomy.open("Qwen/Qwen3-30B-A3B")         # or a folder; reads headers only
    print(m.summary())
    m.layers[12].moe.experts[5].roles["down"][0, :8]   # eight weights, read from disk on demand
    m.load_scores("job/work/saliency.json")         # REAP scores -> expert.score / .freq / .rank
    m["experts[rank<0.25]"].drop()                   # REAP 25% (equal count per layer)
    m.reaq(avg_bits=3.5)                             # REAQ: HEX 16-level for the best, 8-level for the rest
    m["layers[*].attn"].quant("int4")
    print(m.plan(device="M-series-16GB"))            # size, KV, fit, tok/s before anything is written
    m.save("out/qwen3-30b-edited")                   # byte copies + blackhole-anatomy.json receipt

Named functions (blackhole_dev.functions) package weight manipulations under a name
schemas call from a `model.edit` stage. The open format code (safetensors IO, HEX layout, format table) lives in the public
blackhole-harness package as blackhole.anatomy.{st,hex,formats}. Full guide: docs/anatomy.md.
"""

__version__ = "0.1.0"

from blackhole_dev.functions import call, describe, function, get, load, registry
from blackhole_dev.model import AnatomyError, Model, Plan, diff, open
from blackhole_dev.parts import Part, Selection, View
from blackhole_dev.query import QueryError

__all__ = ["__version__", "open", "Model", "Plan", "Part", "Selection", "View", "AnatomyError", "QueryError", "diff",
           "function", "call", "get", "load", "describe", "registry"]
