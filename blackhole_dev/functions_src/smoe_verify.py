"""Built-in function `smoe-verify`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork smoe-verify`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
dense-to-SMoE steps is blackhole_dev/functions_src/_smoe.py."""

from __future__ import annotations

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _smoe


@function("smoe-verify", per="job")
def smoe_verify(job, calib: str = "", n_tokens: int = 8192, seq_len: int = 1024, batch_size: int = 4,
                seed: int = 3) -> dict:
    """Step 5 of dense-to-SMoE: reloads the written checkpoint and checks it against the dense
    model: with all experts on it must give the same logits (equiv_rel_err = max logit error
    over the largest logit; kl_at_all_experts), and at the checkpoint's k it reports the logit
    KL to the dense model (kl_vs_dense, the pipeline's measure) and top-1 agreement."""
    path = _smoe.model_path(job)
    dense = _smoe.load(path)
    moe = _smoe.load(job.pruned_dir)
    tok = _smoe.tokenizer(path)
    texts, note = _smoe.calib_texts(calib, n_tokens, seed, job.path("data", "heldout.jsonl"), job.rj.config.calib)
    job.emit(pct=10, msg=f"comparing on {n_tokens} tokens: {note}")
    res = _smoe.verify(dense, moe, _smoe.batches(texts, tok, n_tokens, seq_len, batch_size, seed))
    _smoe.log(f"verify: all experts on, relative error {res['equiv_rel_err']:.2e}; "
              f"KL at k={res['topk']}: {res['kl_vs_dense']:.4f}, top-1 {res['top1_agreement']:.3f}")
    return res
