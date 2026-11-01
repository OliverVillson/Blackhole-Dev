"""Built-in function `task-eval`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork task-eval`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
task-map steps is blackhole_dev/functions_src/_taskmap.py."""

from __future__ import annotations

import gc
import json

import numpy as np

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _taskmap as tm

VARIANTS = ("plan", "general", "random", "cold", "dynamic", "oracle")


@function("task-eval", per="job")
def task_eval(job, variants: str = "plan,general,random,cold,dynamic,oracle", max_prompts: int = 0,
              max_prompt_tokens: int = 512, max_answer_tokens: int = 256, speed: bool = True,
              seed: int = 0) -> dict:
    """Step 5 of the task map: how well it works. Every variant keeps the same budget as the
    task-preload plan and is compared with the base model on the held-out task prompts and on
    the general prompts: KL(base || variant) and top-1 agreement on the answer tokens, and the
    answer NLL (with your own reference answers this is the task accuracy proxy; with the base
    model's answers it measures how faithfully the variant reproduces them).

      plan     the written task plan (the job's model)
      general  the same budget, but chosen from general prompts (is the task data what helps?)
      random   the same budget, random neurons and heads
      cold     everything at cold_format (smaller, the uniform baseline)
      dynamic  the predictor picks each prompt's hot blocks from its probe-layer feature
      oracle   each prompt's true hot blocks (the ceiling for any predictor)

    With `speed`, prefill/decode tokens per second and peak memory of the base and written
    models (speed-bench when it is installed, else a short local run), and kl-eval's KL of the
    written model on the held-out prompts when that is installed. `max_prompts` > 0 caps each
    set. Writes work/taskmap/eval.json; metrics are <set>_<variant>_<measure>."""
    import torch

    from blackhole_dev import functions

    want = [v.strip() for v in variants.split(",") if v.strip()]
    bad = [v for v in want if v not in VARIANTS]
    if bad:
        raise ValueError(f"unknown variants {bad}; have {', '.join(VARIANTS)}")
    sets = tm.load_sets(job)
    sets = {s: (rs[:max_prompts] if max_prompts > 0 else rs) for s, rs in sets.items() if s != "train"}
    w = tm.work(job)
    cfg = json.loads((w / "plan.json").read_text()) if (w / "plan.json").exists() else None
    if cfg is None:
        raise RuntimeError("run task-preload first (no plan.json)")
    plan = tm.load_plan(w / "plan.npz")
    pr = dict(np.load(w / "predictor.npz", allow_pickle=False)) if (w / "predictor.npz").exists() else None
    if pr is None and ("dynamic" in want or "oracle" in want):
        raise RuntimeError("the dynamic and oracle variants need task-predictor first")
    hot_fmt, cold_fmt, attn = cfg["hot_format"], cfg["cold_format"], cfg.get("attention", True)
    path = tm.model_path(job)
    tok = tm.tokenizer(path)
    job.emit(pct=2, msg="loading the base model")
    base = tm.load(path)
    probe = int(json.loads((w / "trace.json").read_text())["probe_layer"])
    enc = {s: [tm.encode(tok, r, max_prompt_tokens, max_answer_tokens) for r in rs] for s, rs in sets.items()}

    refs: dict = {}                                                                 # base pass: logits, features, true use
    with tm.Tracer(base, probe) as t:
        for s, items in enc.items():
            refs[s] = []
            for ids, start in items:
                r = t.run(ids, start)
                refs[s].append({"logits": r["logits"].float().cpu(), "feat": r["feat"], "ffn": r["ffn"]})

    gen_tr = tm.load_trace(job, "general")
    plans = {"plan": plan, "random": tm.random_plan(plan, seed),
             "general": tm.make_plan(tm.neuron_scores(gen_tr), gen_tr["heads"].mean(0), cfg["budget"],
                                     cfg["head_budget"], cfg["allocate"], gen_tr["layers"].mean(0)),
             "cold": {**plan, "hot": np.zeros_like(plan["hot"]), "hot_heads": np.zeros_like(plan["hot_heads"])}}
    if cfg["allocate"] == "even":                                               # the same counts as the plan
        plans["general"] = _same_counts(plans["general"], plan)
    res: dict = {}
    sizes: dict = {}
    out_dir = job.pruned_dir if cfg.get("model_dir") else None

    def score(name: str, model, masks=None):
        for s, items in enc.items():
            acc: dict = {}
            dyn = tm.DynamicFFN(model, cold_fmt) if masks is not None else None
            try:
                if dyn:
                    dyn.__enter__()
                for (ids, start), ref in zip(items, refs[s]):
                    if dyn:
                        dyn.mask = masks(ref)
                    with torch.no_grad():
                        out = model(input_ids=torch.tensor([ids], device=tm.input_device(model))).logits[0]
                    tm.add(acc, tm.token_stats(ref["logits"], out.float().cpu(), ids, start))
            finally:
                if dyn:
                    dyn.__exit__()
            for k, v in tm.finish(acc).items():
                res[f"{s}_{name}_{k}"] = v
        tm.log(f"{name}: KL task {res[f'heldout_{name}_kl']:.4f}, general {res[f'general_{name}_kl']:.4f}")

    steps = len(want) + (1 if speed else 0)
    for i, name in enumerate(want):
        job.emit(pct=10 + 80 * i / steps, msg=f"variant {name}")
        if name in plans:
            if name == "plan" and out_dir is not None and (out_dir / "config.json").exists():
                model = tm.load(out_dir)
                sizes[name] = cfg["size_gb"]
            else:
                model = tm.load(path)
                sizes[name] = tm.apply(model, plans[name], hot_fmt, cold_fmt, attn=attn)["size_gb"]
            score(name, model)
        else:
            model = tm.load(path)
            if attn:
                tm.apply(model, plan, hot_fmt, cold_fmt, ffn=False, attn=True)
            order, bs = pr["order"], int(pr["block_size"])
            k = max(1, int(round(cfg["budget"] * tm.n_blocks(order.shape[1], bs))))

            def masks(ref, name=name, order=order, bs=bs, k=k):
                if name == "dynamic":
                    sc = tm.predict(pr, ref["feat"])[0]
                else:
                    sc = tm.block_scores(ref["ffn"][None], order, bs)[0]
                return tm.blocks_to_neurons(tm.topk_mask(sc, k), order, bs)
            sizes[name] = cfg["size_gb"]
            score(name, model, masks)
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    for s in enc:
        res[f"{s}_base_nll"] = res.get(f"{s}_{want[0]}_nll_base", 0.0) if want else 0.0
    for name, gb in sizes.items():
        res[f"{name}_size_gb"] = gb
    res["base_size_gb"] = cfg["base_gb"]
    res["resident_gb"] = cfg["resident_gb"]
    for a in ("general", "random", "cold"):                                       # >1: the task plan wins on the task
        if "plan" in want and a in want:
            res[f"task_gain_vs_{a}"] = res[f"heldout_{a}_kl"] / max(res["heldout_plan_kl"], 1e-12)
    if "dynamic" in want and "plan" in want:
        res["task_gain_dynamic_vs_plan"] = res["heldout_plan_kl"] / max(res["heldout_dynamic_kl"], 1e-12)

    if speed:
        job.emit(pct=92, msg="speed and memory")
        target = str(out_dir) if out_dir is not None and (out_dir / "config.json").exists() else None
        sample = sets["heldout"][0]["prompt"]
        for label, where in (("base", str(path)), ("plan", target)):
            if where is None:
                continue
            res.update({f"{label}_{k}": v for k, v in _speed(job, functions, where, tok, sample).items()})
        if target and _has(functions, "kl-eval"):
            try:
                ke = job.call("kl-eval", model=target, base="original", calib=str(w / "heldout.jsonl"))
                res["plan_kl_eval"] = float(ke.get("kl", float("nan")))
            except Exception as e:                                                # noqa: BLE001
                tm.log(f"kl-eval skipped: {e}")
    del base
    (w / "eval.json").write_text(json.dumps(res, indent=1) + "\n")
    return {k: float(v) for k, v in res.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}


def _same_counts(other: dict, plan: dict) -> dict:
    """`other`'s ranking with exactly the plan's hot counts per layer."""
    hot = np.zeros_like(plan["hot"])
    for li, k in enumerate(plan["n_hot"]):
        hot[li, other["order"][li, :k]] = True
    return {**other, "hot": hot, "n_hot": plan["n_hot"]}


def _has(functions, name: str) -> bool:
    try:
        functions.get(name)
        return True
    except KeyError:
        return False


def _speed(job, functions, model_dir: str, tok, prompt: str) -> dict:
    """speed-bench (the benchmark built-in) when installed, else prefill/decode on this process."""
    if _has(functions, "speed-bench"):
        try:
            r = job.call("speed-bench", model=model_dir)
            return {k: float(v) for k, v in r.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
        except Exception as e:                                                    # noqa: BLE001
            tm.log(f"speed-bench failed ({e}); measuring locally")
    hf = tm.load(model_dir)
    try:
        return tm.local_speed(hf, tok, prompt)
    finally:
        del hf
