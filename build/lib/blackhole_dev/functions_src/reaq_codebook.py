"""Built-in function `reaq-codebook`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reaq-codebook`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("reaq-codebook", per="job")
def reaq_codebook(job, top: float = None, block: int = None) -> dict:
    """REAQ per-expert codebooks on the GPU (a BlackHole-Harness original): the `top` share of
    each layer's experts by REAP score get 16-level learned tables, the rest 8-level, blocks of
    `block` weights with fp8 scales, GPTQ rounding onto the tables (pipeline defaults 0.5 and
    32). Measured against the teacher and int4; the packed indices, tables and scales are
    saved. The anatomy functions reaq + hex-quantize do the same on the CPU."""
    res = job.run_stage("reaq", reaq_top=top, reaq_block=block)
    return {k: v for k, v in res.items() if isinstance(v, (int, float))}
