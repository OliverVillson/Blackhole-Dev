"""Built-in function `smoe-router`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork smoe-router`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
dense-to-SMoE steps is blackhole_dev/functions_src/_smoe.py."""

from __future__ import annotations

import json

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _smoe


@function("smoe-router", per="job")
def smoe_router(job, calib: str = "", n_tokens: int = 100000, topk: int = 4, ridge: float = 1e-3,
                holdout: float = 0.1, seq_len: int = 2048, batch_size: int = 8, seed: int = 1) -> dict:
    """Step 3 of dense-to-SMoE, on the dense base model: a second pass fits a closed-form ridge
    router per layer that predicts each expert's output norm from the layer input, then measures
    readiness on held-out documents (`holdout` of them, and of the tokens): router R^2 and the
    share of routed FFN energy dropped at top-`topk` with this router, an oracle (true top-k) and
    random picks. `seed` differs from smoe-profile's, so the token draw is not the partition's."""
    path = _smoe.model_path(job)
    hf = _smoe.load(path)
    tok = _smoe.tokenizer(path)
    Q = np.load(_smoe.work(job) / "partition.npz", allow_pickle=False)
    texts, note = _smoe.calib_texts(calib, n_tokens, seed, job.path("data", "calib.jsonl"), job.rj.config.calib)
    job.emit(pct=5, msg=f"router pass over {n_tokens} tokens: {note}")
    order = np.random.default_rng(seed).permutation(len(texts))
    nh = max(1, int(len(texts) * float(holdout)))
    held_t, fit_t = [texts[i] for i in order[:nh]], [texts[i] for i in order[nh:]] or texts
    n_eval = max(seq_len, int(n_tokens * float(holdout)))
    fit = _smoe.batches(fit_t, tok, max(seq_len, n_tokens - n_eval), seq_len, batch_size, seed)
    held = _smoe.batches(held_t, tok, n_eval, seq_len, batch_size, seed)
    Rz, per_layer = _smoe.fit_router(
        hf, Q, fit, held, topk, ridge, seed,
        on_batch=lambda seen, fit: job.emit(pct=5 + 90 * min(seen / n_tokens, 1),
                                            msg=f"{seen} tokens ({'fit' if fit else 'held out'})"))
    for idx, row in per_layer.items():
        _smoe.log(f"readiness {idx}: R2 {row['router_r2']:.3f}, dropped at k={int(Rz['k_readiness'])}: linear "
                  f"{row['drop_linear']:.3f} oracle {row['drop_oracle']:.3f} random {row['drop_random']:.3f}")
    _smoe._save_npz(_smoe.work(job) / "router.npz", **Rz)
    (_smoe.work(job) / "router.json").write_text(json.dumps(per_layer, indent=1) + "\n")
    rows = list(per_layer.values())
    return {"readiness_k": int(Rz["k_readiness"]),
            **{f"mean_{key}": float(np.mean([r[key] for r in rows]))
               for key in ("router_r2", "drop_linear", "drop_oracle", "drop_random")}}
