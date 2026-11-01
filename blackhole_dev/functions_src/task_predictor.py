"""Built-in function `task-predictor`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork task-predictor`, or Fork in
the app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
task-map steps is blackhole_dev/functions_src/_taskmap.py."""

from __future__ import annotations

import json

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _taskmap as tm


@function("task-predictor", per="job")
def task_predictor(job, block_size: int = 64, budget: float = 0.5, ridge: float = 1.0, seed: int = 0) -> dict:
    """Step 3 of the task map: ranks every layer's FFN neurons by their mean task contribution
    (train set), groups them into blocks of `block_size` neurons (the unit a runtime loads), and
    fits a ridge regression from a prompt's probe-layer feature to the (log) contribution of
    every block. Scored on the held-out task prompts and the general prompts by recall at
    `budget` (the share of blocks kept): the share of the true top blocks' contribution that the
    chosen blocks hold, for the predictor, the static task ranking and a random pick (1.0 =
    oracle). Writes work/taskmap/predictor.npz and predictor.json."""
    tr = {s: tm.load_trace(job, s) for s in tm.SETS}
    order = tm.block_order(tm.neuron_scores(tr["train"]))
    m = order.shape[1]
    B = tm.n_blocks(m, block_size)
    k = max(1, int(round(budget * B)))
    blocks = {s: tm.block_scores(tr[s]["ffn"], order, block_size) for s in tm.SETS}
    job.emit(pct=30, msg=f"fitting {order.shape[0]} layers x {B} blocks from {len(blocks['train'])} prompts")
    pr = tm.fit(tr["train"]["feats"], blocks["train"], ridge)
    res = {"blocks": B, "block_size": block_size, "kept_blocks": k}
    for s in ("train", "heldout", "general"):
        for key, v in tm.evaluate_predictor(pr, blocks["train"], tr[s], blocks[s], k, seed).items():
            res[f"{s}_{key}"] = v
    np.savez_compressed(tm.work(job) / "predictor.npz", order=order, block_size=np.array(block_size), **pr)
    (tm.work(job) / "predictor.json").write_text(json.dumps(res, indent=1) + "\n")
    tm.log(f"held-out recall at {budget:.0%} of blocks: predictor {res['heldout_recall_predictor']:.3f}, "
           f"static {res['heldout_recall_static']:.3f}, random {res['heldout_recall_random']:.3f}")
    return {"heldout_recall_predictor": res["heldout_recall_predictor"],
            "heldout_recall_static": res["heldout_recall_static"],
            "heldout_recall_random": res["heldout_recall_random"],
            "general_recall_predictor": res["general_recall_predictor"],
            "general_recall_static": res["general_recall_static"],
            "heldout_r2": res["heldout_r2"], "blocks": B}
