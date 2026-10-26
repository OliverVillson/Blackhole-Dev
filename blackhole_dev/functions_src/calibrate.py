"""Built-in function `calibrate`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork calibrate`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("calibrate", per="job")
def calibrate(job, calib: str = None, purpose: str = None, samples: int = None, max_seq: int = None,
              reuse: bool = True) -> dict:
    """Get the job ready for the GPU stages: detect the model (config + weight index), plan the
    run on this machine, download the weights, and have the teacher (the original model, in
    vLLM when it can) write the calibration set: `samples` prompts from `calib` (chat, code,
    math, mix, contest, or a file) and their answers, plus the held-out set every KL is measured
    on. With `reuse`, an earlier job on the same model and purpose donates its calibration set
    and REAP scores, so the teacher is skipped. None leaves a knob as the pipeline has it
    (calib "mix", samples 256, REAPer's max_seq)."""
    import os

    from blackhole_pipeline.__main__ import seed_from_previous, teacher_check

    job.set(calib=calib, purpose=purpose, calib_samples=samples, max_seq=max_seq)
    for i, name in enumerate(("detect", "plan", "weights")):
        job.run_stage(name, pct=(10 * i, 10 * i + 10))
    if not job.is_done("calibrate"):
        if reuse and not os.environ.get("BLACKHOLE_NO_REUSE"):
            seed_from_previous(job.bh, job.rj)
        if not job.is_done("calibrate"):
            teacher_check(job.rj)
    res = job.run_stage("calibrate", pct=(30, 100))
    return {k: v for k, v in res.items() if isinstance(v, (int, float, str))}
