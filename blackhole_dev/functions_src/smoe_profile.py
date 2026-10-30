"""Built-in function `smoe-profile`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork smoe-profile`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
dense-to-SMoE steps is blackhole_dev/functions_src/_smoe.py."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _smoe


@function("smoe-profile", per="job")
def smoe_profile(job, calib: str = "", n_tokens: int = 100000, experts: int = 64, oversample: int = 4,
                 seq_len: int = 2048, batch_size: int = 8, seed: int = 0) -> dict:
    """Step 1 of dense-to-SMoE, on the dense base model: one forward pass over `n_tokens`
    calibration tokens keeping, per FFN layer, a Nystrom sketch of the magnitude co-activation
    matrix M[j, l] = E[e_j e_l] (e_j = |neuron j| x ||down_proj[:, j]||, rank `oversample` x
    `experts`) and per-neuron stats. `calib`: a .txt/.jsonl path or a named set (chat, code,
    math, contest, mix); empty uses the job's calibration set (prompts and teacher answers)."""
    path = _smoe.model_path(job)
    hf = _smoe.load(path)
    tok = _smoe.tokenizer(path)
    texts, note = _smoe.calib_texts(calib, n_tokens, seed, job.path("data", "calib.jsonl"), job.rj.config.calib)
    job.emit(pct=5, msg=f"profiling {n_tokens} tokens: {note}")
    data = _smoe.batches(texts, tok, n_tokens, seq_len, batch_size, seed)
    P = _smoe.profile(hf, data, experts, oversample, seed,
                      on_batch=lambda seen: job.emit(pct=5 + 90 * min(seen / n_tokens, 1), msg=f"{seen} tokens"))
    _smoe._save_npz(_smoe.work(job) / "profile.npz", **P)
    return {"tokens": int(P["n_tokens"]), "layers": int(len(P["layer_ids"])), "sketch_rank": int(P["q"]),
            "ffn_width": int(P["m"]), "model_type": str(P["model_type"])}
