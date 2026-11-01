"""Built-in function `task-prompts`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork task-prompts`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
task-map steps is blackhole_dev/functions_src/_taskmap.py."""

from __future__ import annotations

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _taskmap as tm


@function("task-prompts", per="job")
def task_prompts(job, task: str = "", describe: str = "", general: str = "mix", n: int = 256,
                 heldout: float = 0.25, n_general: int = 64, answer_tokens: int = 128, seed: int = 0) -> dict:
    """Step 1 of the task map: the prompt sets. `task` is your prompts (a .jsonl with
    prompt/answer, question/answer, instruction/output or messages rows, or a .txt with one per
    line) or a named set (chat, code, math, contest, mix); with `task` empty the base model
    writes `n` prompts itself from `describe`, a one-line description of the task ("SQL queries
    over a sales database"). A `heldout` share is kept out of every fitting step for the eval.
    `general` (a named set or a file) is the contrast: what the model is used for otherwise.
    Prompts without an answer get the base model's own greedy answer of up to `answer_tokens`
    tokens (0 = none), so tracing and the eval cover the tokens the task really produces.
    Writes work/taskmap/{train,heldout,general}.jsonl."""
    if not task and not describe:
        raise ValueError("give task (a prompt file or a named set) or describe (a one-line task description)")
    path = tm.model_path(job)
    hf = tok = None

    def model():
        nonlocal hf, tok
        if hf is None:
            job.emit(pct=None, msg="loading the base model")
            hf, tok = tm.load(path), tm.tokenizer(path)
        return hf, tok

    if task:
        rows, note = tm.named_rows(task, n, seed)
    else:
        job.emit(pct=5, msg=f"the base model writes {n} prompts about: {describe}")
        rows, note = tm.write_prompts(*model(), describe, n, seed), f"{n} prompts written by the base model"
    if len(rows) < 4:
        raise ValueError(f"only {len(rows)} task prompts ({note}); need at least 4")
    gen, gnote = tm.named_rows(general, n_general, seed + 1)
    if not gen:
        raise ValueError(f"no general prompts from {general!r}")
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(rows))
    k = max(1, int(round(heldout * len(rows))))
    sets = {"train": [rows[i] for i in idx[k:]], "heldout": [rows[i] for i in idx[:k]], "general": gen}
    if answer_tokens > 0:
        todo = [(s, i) for s, rs in sets.items() for i, r in enumerate(rs) if not r.get("answer")]
        if todo:
            job.emit(pct=40, msg=f"base model answers {len(todo)} prompts (up to {answer_tokens} tokens)")
            ans = tm.generate(*model(), [sets[s][i]["prompt"] for s, i in todo], answer_tokens)
            for (s, i), a in zip(todo, ans):
                sets[s][i] = {**sets[s][i], "answer": a, "answer_by": "base"}
    w = tm.work(job)
    for s, rs in sets.items():
        tm.write_jsonl(w / f"{s}.jsonl", rs)
    tm.log(f"task: {note}; general: {gnote}")
    return {"train": len(sets["train"]), "heldout": len(sets["heldout"]), "general": len(sets["general"]),
            "with_answers": sum(1 for rs in sets.values() for r in rs if r.get("answer"))}
