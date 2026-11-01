"""Built-in function `task-preload`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork task-preload`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
task-map steps is blackhole_dev/functions_src/_taskmap.py."""

from __future__ import annotations

import json
from pathlib import Path

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _taskmap as tm


@function("task-preload", per="job")
def task_preload(job, budget: float = 0.5, head_budget: float = -1.0, hot_format: str = "bf16",
                 cold_format: str = "int3", allocate: str = "even", contrast: float = 0.0, block_size: int = 64,
                 attention: bool = False, write: bool = True, name: str = "") -> dict:
    """Step 4 of the task map: the static plan. In every layer the `budget` share of FFN
    neurons that do the most work on the task stays at `hot_format`; the rest goes to
    `cold_format` (int2..int8 with an optional _gG group size, fp8, hex3, hex4, ..., or "off" to
    leave it out). `allocate` "importance" gives layers that change the residual stream more a
    bigger share (0.5x to 2x). `contrast` > 0 ranks down neurons that are just as busy on general
    text. With `attention` the heads get a plan too (the `head_budget` share, -1 = budget, ranked
    by output norm; q_proj rows and o_proj columns, k/v stay hot). It is off by default: output
    norm is a weaker guide to a head's importance than contribution is for a neuron, so attention
    stays at the base precision unless you opt in. Neurons are reordered hot-first (exact), so
    each layer's hot part is one row range; with cold_format "off" and even allocation the FFN
    is cut to that width, a real smaller and faster model. With `write` it is saved as the job's
    model with blackhole-preload.json (the preload map) next to it. Writes work/taskmap/plan.npz
    and plan.json."""
    tr = {s: tm.load_trace(job, s) for s in ("train", "general")}
    hb = budget if head_budget < 0 else head_budget
    scores = tm.neuron_scores(tr["train"], tr["general"], contrast)
    plan = tm.make_plan(scores, tr["train"]["heads"].mean(0), budget, hb, allocate,
                        tr["train"]["layers"].mean(0), block_size)
    tm.save_plan(tm.work(job) / "plan.npz", plan)
    path = tm.model_path(job)
    job.emit(pct=10, msg="loading the base model")
    hf = tm.load(path, device="cpu")
    job.emit(pct=30, msg=f"{budget:.0%} of FFN neurons at {hot_format}, the rest at {cold_format}")
    info = tm.apply(hf, plan, hot_format, cold_format, attn=attention)
    info.update({"budget": budget, "head_budget": hb, "hot_format": hot_format, "cold_format": cold_format,
                 "allocate": allocate, "contrast": contrast, "attention": attention,
                 "ffn_width_written": int(hf.config.intermediate_size)})
    if write:
        name = name or f"{Path(str(job.rj.config.model)).name}-task-{int(round(budget * 100))}-{hot_format}-{cold_format}"
        job.set(out_name=name)
        out = job.pruned_dir
        job.emit(pct=60, msg=f"writing {out}")
        hf.save_pretrained(out)
        tm.tokenizer(path).save_pretrained(out)
        pm = tm.preload_map(plan, hot_format, cold_format, block_size)
        if info["ffn_width_written"] < plan["hot"].shape[1]:
            pm["ffn_cut_to"] = info["ffn_width_written"]
        (out / "blackhole-preload.json").write_text(json.dumps({**pm, "size": info}, indent=1) + "\n")
        info["model_dir"] = str(out)
    (tm.work(job) / "plan.json").write_text(json.dumps(info, indent=1) + "\n")
    tm.log(f"size {info['size_gb']:.3f} GB (16-bit {info['base_gb']:.3f}, all {cold_format} "
           f"{info['cold_everywhere_gb']:.3f}); resident if cold parts load on demand {info['resident_gb']:.3f} GB")
    out = {k: v for k, v in info.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
    if write:
        out["model_dir"] = info["model_dir"]
    return out
