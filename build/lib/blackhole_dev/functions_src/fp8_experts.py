"""Built-in function `fp8-experts`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork fp8-experts`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("fp8-experts", per="job")
def fp8_experts(job) -> dict:
    """REAPer's quant stage: the pruned (healed) model with its routed experts in fp8, the
    simple vLLM-servable folder REAP classic ships."""
    res = job.run_stage("quant")
    return {k: v for k, v in res.items() if isinstance(v, (int, float))}
