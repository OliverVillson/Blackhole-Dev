"""Built-in function `reap-gpu`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork reap-gpu`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("reap-gpu", per="job")
def reap_gpu(job, ratio: float = None, measure: bool = True) -> dict:
    """REAP on the GPU (REAPer's pipeline): score every routed expert by router weight x
    expert output norm over the calibration set, drop the `ratio` lowest-scored per layer
    (pipeline default 0.25; never past 0.5), write the pruned checkpoint, and with `measure`
    compare it with the teacher (held-out KL and top-1). Runs calibrate first when it has not
    run. The anatomy functions reap-score / reap-prune do the same on the CPU of any machine."""
    from blackhole_pipeline.__main__ import rekeep

    if ratio is not None and not 0 <= ratio <= 0.5:
        raise ValueError("ratio must be between 0 and 0.5 (measured: past 50% breaks every model we tried)")
    if not job.is_done("calibrate"):
        job.call("calibrate")              # yours, if you forked calibrate
    changed = job.set(prune=ratio)
    if changed and job.is_done("score"):
        rekeep(job.rj)                       # saved REAP scores, new kept lists: no new scoring pass
        job.path(".done", "prune").unlink(missing_ok=True)
        job.path(".done", "eval").unlink(missing_ok=True)
    res = job.run_stage("reap", pct=(30, 80))
    if measure:
        res.update(job.run_stage("eval", pct=(80, 100)))
    keys = ("experts_kept", "kl", "top1_agreement", "ppl_teacher", "ppl_pruned", "bytes_after")
    return {k: res[k] for k in keys if k in res}
