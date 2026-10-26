"""Built-in function `qheal`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork qheal`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("qheal", per="job")
def qheal(job, minutes: int = None) -> dict:
    """Heal AFTER quantization (a BlackHole-Harness original): the student is loaded as exactly
    the MLX folder the mlx step wrote (dequantized); routed experts, embedding and LM head stay
    frozen at their low-bit values, attention, shared experts and dense MLPs train behind a
    straight-through rounding on the folder's own grid, so the gains survive re-quantization.
    Trains on the same data as distil (work/heal_data.jsonl) with distil's knobs; `minutes`
    caps the training (pipeline default 45). Writes <mlx folder>-healed and points the bench at
    it only if it beats the quantized start; otherwise the unhealed folder stands."""
    if job.mlx_dir is None:
        raise RuntimeError("qheal needs an MLX model: run mlx-export first")
    res = job.run_stage("qheal", qheal_minutes=minutes)
    return {k: res[k] for k in ("kl_before", "kl_after", "top1_before", "top1_after", "steps", "minutes", "kept")
            if k in res}
