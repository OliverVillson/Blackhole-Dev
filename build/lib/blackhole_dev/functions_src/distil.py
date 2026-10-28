"""Built-in function `distil`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork distil`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from blackhole_dev.functions import function


@function("distil", per="job")
def distil(job, data: str = "", prompts: int = None, calib: str = None, max_tokens: int = None, samples: int = None,
           think_budget: int = None, epochs: float = None, accum: int = None, lr: float = None, eval_every: int = None,
           minutes: int = None, seq: int = None, expert_rank: int = None, lora_lr: float = None,
           layer_weight: float = None, router_weight: float = None, focus: float = None, opd_rounds: int = None,
           opd_prompts: int = None, opd_minutes: int = None, keep_weights: str = None) -> dict:
    """Distil the REAP-pruned student from the original model (the pipeline's heal stage).
    The teacher's answers are the training data unless `data` names a jsonl of rows
    {"ids": [...], "start": n} (prompt + answer token ids, answer from `start`), or an earlier
    step (traces, your own data function) already wrote work/heal_data.jsonl. Forward KL on the
    answer tokens; routed experts, embedding and LM head stay frozen unless expert_rank > 0
    (low-rank expert updates); layer_weight / router_weight add layer and router matching;
    opd_rounds > 0 adds on-policy rounds (the student writes, the teacher grades every token).
    Early stopping on the held-out KL keeps the best point (keep_weights "kl"), or "last"
    trains through. Writes <pruned>-healed when it beats the start.

    None leaves a knob as the pipeline has it (blackhole_pipeline.DEFAULTS: prompts 1024,
    max_tokens 1536, epochs 1.0, accum 8, lr 3e-6, eval_every 8, minutes 45, expert_rank 0,
    lora_lr 1e-4, layer_weight 0, router_weight 0, focus 0, opd_rounds 0, opd_prompts 256,
    opd_minutes 60, keep_weights "kl"), or as an earlier step set it."""
    if data:
        n = _use_rows(job, Path(data).expanduser())
        job.emit(pct=1, msg=f"training on {n} sequences from {data}")
        if (samples if samples is not None else job.params.get("heal_samples", 0)) <= 1:
            prompts = n if prompts is None else min(prompts, n)
    knobs = {"heal_prompts": prompts, "heal_calib": calib, "heal_max_tokens": max_tokens, "heal_samples": samples,
             "heal_think_budget": think_budget, "heal_epochs": epochs, "heal_accum": accum, "heal_lr": lr,
             "heal_eval_every": eval_every, "heal_minutes": minutes, "heal_seq": seq, "heal_expert_rank": expert_rank,
             "heal_lora_lr": lora_lr, "heal_layer_weight": layer_weight, "heal_router_weight": router_weight,
             "heal_focus": focus, "heal_opd_rounds": opd_rounds, "heal_opd_prompts": opd_prompts,
             "heal_opd_minutes": opd_minutes, "heal_select": keep_weights}
    res = job.run_stage("heal", fresh=bool(data), **knobs)
    return {k: res[k] for k in ("kl_before", "kl_after", "top1_before", "top1_after", "steps", "sequences", "minutes",
                                "kept") if k in res}


def _use_rows(job, src: Path) -> int:
    """Put training rows where the heal stage reads them, so it trains on them as they are."""
    rows = [json.loads(x) for x in src.read_text().splitlines() if x.strip()]
    bad = [i for i, r in enumerate(rows) if not (isinstance(r, dict) and isinstance(r.get("ids"), list)
                                                  and isinstance(r.get("start"), int))]
    if bad or not rows:
        raise ValueError(f"{src}: every line must be {{\"ids\": [token ids], \"start\": answer offset}} "
                         f"(bad lines: {bad[:5] or 'file is empty'})")
    dst = job.path("work", "heal_data.jsonl")
    if src.resolve() != dst.resolve():
        shutil.copy2(src, dst)
    job.path("work", "heal_data_meta.json").unlink(missing_ok=True)
    return len(rows)
