"""Built-in function `smoe-build`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork smoe-build`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
dense-to-SMoE steps is blackhole_dev/functions_src/_smoe.py."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _smoe


@function("smoe-build", per="job")
def smoe_build(job, topk: int = 4, min_r2: float = 0.6, max_drop: float = 0.15, gate_eps: float = 1e-3,
               name: str = "") -> dict:
    """Step 4 of dense-to-SMoE: writes a standard Hugging Face MoE checkpoint (Qwen3 dense ->
    Qwen3-MoE, Qwen2/2.5 dense -> Qwen2-MoE with the shared expert) with `topk` experts per
    token, as the job's model, so the stages after it (kd, distil, package) work on it. Layers
    whose router R^2 is below `min_r2` or that drop more than `max_drop` of the routed energy
    stay dense (mlp_only_layers). The router is flattened (every weight 1/N within `gate_eps`)
    and the x N folded into down_proj, so at k = N the checkpoint is the dense model."""
    path = _smoe.model_path(job)
    hf = _smoe.load(path, device="cpu")
    Q = np.load(_smoe.work(job) / "partition.npz", allow_pickle=False)
    Rz = np.load(_smoe.work(job) / "router.npz", allow_pickle=False)
    job.emit(pct=10, msg="building the MoE")
    moe, rep = _smoe.build(hf, Q, Rz, topk, min_r2, max_drop, gate_eps)
    name = name or f"{Path(job.rj.config.model).name}-SMoE-{rep['experts']}e-top{rep['topk']}"
    job.set(out_name=name)
    out = job.pruned_dir
    job.emit(pct=60, msg=f"writing {out}")
    moe.save_pretrained(out)
    _smoe.tokenizer(path).save_pretrained(out)
    rep["model_dir"] = str(out)
    (out / "blackhole-smoe.json").write_text(json.dumps(rep, indent=1) + "\n")
    (_smoe.work(job) / "build.json").write_text(json.dumps(rep, indent=1) + "\n")
    return {"model_dir": str(out), "converted_layers_frac": rep["converted_layers_frac"],
            "dense_layers": len(rep["dense_layers"]), "params_total": rep["params_total"],
            "params_active": rep["params_active_per_token"], "experts": rep["experts"], "topk": rep["topk"]}
