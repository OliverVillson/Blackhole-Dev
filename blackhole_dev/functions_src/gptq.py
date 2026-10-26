"""Built-in function `gptq`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork gptq`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("gptq", per="job")
def gptq(job, calib: int = None, layer_chunk: int = None) -> dict:
    """GPTQ int4 (group 128) on the routed experts of the pruned (healed, if distil ran) model,
    sequentially in chunks of `layer_chunk` MoE layers with Hessians from `calib` calibration
    sequences (pipeline defaults 12 and 64: 64 were enough on B200), measured against the
    teacher and written as a compressed-tensors W4A16 checkpoint that vLLM serves."""
    res = job.run_stage("gptq", gptq_calib=calib, layer_chunk=layer_chunk)
    return {k: v for k, v in res.items() if isinstance(v, (int, float))}
