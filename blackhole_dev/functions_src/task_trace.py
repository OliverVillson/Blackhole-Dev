"""Built-in function `task-trace`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork task-trace`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
task-map steps is blackhole_dev/functions_src/_taskmap.py."""

from __future__ import annotations

import json

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _taskmap as tm


@function("task-trace", per="job")
def task_trace(job, probe_layer: int = -1, max_prompt_tokens: int = 512, max_answer_tokens: int = 256) -> dict:
    """Step 2 of the task map: one forward pass of the base model per prompt (train, held-out
    and general sets) with hooks recording, per layer, each FFN neuron's mean contribution
    (|act(gate) x up| x the norm of its down_proj column), each attention head's output norm,
    how much the layer changes the residual stream, and the prompt's mean hidden state after
    `probe_layer` (-1 = a quarter of the way in), the feature the predictor reads.
    Writes work/taskmap/trace_{set}.npz and trace.json (top20_share = share of the FFN's work
    done by its busiest 20% of neurons on the task; top20_overlap_general = how many of those are
    also the busiest on general text)."""
    sets = tm.load_sets(job)
    path = tm.model_path(job)
    job.emit(pct=2, msg="loading the base model")
    hf, tok = tm.load(path), tm.tokenizer(path)
    probe = tm.default_probe(len(hf.model.layers), probe_layer)
    total = sum(len(v) for v in sets.values())
    done = 0
    out = {}
    for name, rows in sets.items():
        def tick(k, P, base=done):
            if k % 8 == 0 or k == P:
                job.emit(pct=5 + 90 * (base + k) / total, msg=f"{name}: {k}/{P} prompts")
        out[name] = tm.trace(hf, tok, rows, probe, max_prompt_tokens, max_answer_tokens, on_item=tick)
        done += len(rows)
        np.savez_compressed(tm.work(job) / f"trace_{name}.npz", **out[name])
    s = tm.summary(out["train"], out["general"])
    H, KV, hd = tm.heads(hf)
    info = {**s, "probe_layer": probe, "layers": len(hf.model.layers), "ffn_width": int(out["train"]["ffn"].shape[2]),
            "heads": H, "kv_heads": KV, "tokens": int(sum(int(v["tokens"].sum()) for v in out.values()))}
    (tm.work(job) / "trace.json").write_text(json.dumps(info, indent=1) + "\n")
    tm.log(f"busiest 20% of FFN neurons do {s['top20_share']:.0%} of the task's FFN work; "
           f"{s['top20_overlap_general']:.0%} of them are also the busiest on general text")
    return info
