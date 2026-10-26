"""Built-in function `package`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork package`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("package", per="job")
def package(job) -> dict:
    """Model cards, receipt.json and RESULTS.md in the job folder, from what every earlier
    step measured (KL, top-1, size, bench), and links to the finished models in <job>/out."""
    res = job.run_stage("package", fresh=True)
    rec = job.bh.read("receipt.json") or {}
    return {"size_gb": rec.get("size_gb"), **{k: v for k, v in res.items() if isinstance(v, (int, float))}}
