"""Built-in function `kd`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork kd`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

import json
import math
import random
import shutil
import time
from pathlib import Path

from blackhole_dev.functions import function


@function("kd", per="job")
def kd(job, data: str = "", prompts: int = 256, calib: str = "", max_tokens: int = 1024, epochs: float = 1.0,
       lr: float = 3e-6, accum: int = 8, heldout: int = 16, eval_every: int = 8, minutes: float = 45,
       top_k: int = 20, focus: float = 0.0, seq: int = 0) -> dict:
    """Knowledge distillation written out in one file: the training loop of `distil`, so the
    loss, what trains and how the best point is picked are yours to change. The REAP-pruned
    student learns the original model's next-token distribution on the answer tokens (forward
    KL), with the routed experts, embedding and LM head frozen.

    Data: `data` (a jsonl of rows {"ids": [...], "start": n}), else work/heal_data.jsonl from an
    earlier step (traces, distil, your own), else the teacher answers `prompts` calibration
    prompts (`calib`, the job's calibration set by default) here. The first `heldout` rows are
    held out; every `eval_every` optimizer steps the held-out KL over the teacher's top-`top_k`
    tokens (the pipeline's measure) is checked, the best point is kept, and training stops after
    three checks without a gain, after `epochs` passes or after `minutes`. `focus` > 0 weights
    the tokens the student gets most wrong. Writes <pruned>-healed when it beats the start."""
    import torch
    from reaper_pipeline.load import free, input_device, load_model
    from reaper_pipeline.stages._common import profile, read_jsonl, write_jsonl

    from blackhole_dev.functions_src._teacher import Teacher

    t_start = time.time()
    rj = job.rj
    teacher = Teacher.of(job)
    seq = seq or rj.config.max_seq

    # 1. training rows: prompt + answer token ids, the answer starting at `start`
    path = Path(data).expanduser() if data else job.path("work", "heal_data.jsonl")
    rows = read_jsonl(path) if path.exists() else []
    if not rows:
        from reaper_pipeline.calib import load_prompts
        texts, note = load_prompts(calib or rj.config.calib or "mix", prompts, seed=1234)
        job.emit(pct=2, msg=f"teacher answers for {len(texts)} {note}")
        enc = [teacher.encode_chat([{"role": "user", "content": q}]) for q in texts]
        answers = teacher.generate(enc, max_tokens, "answered", (2, 30))
        rows = [{"ids": e + list(a), "start": len(e)} for e, a in zip(enc, answers) if a]
        if not rows:
            raise RuntimeError("the teacher produced no usable training sequences")
        write_jsonl(job.path("work", "heal_data.jsonl"), rows)
    rows = [{"ids": r["ids"][:seq], "start": r["start"]} for r in rows if r["start"] < min(len(r["ids"]), seq)]
    random.Random(0).shuffle(rows)
    held, train = rows[:heldout], rows[heldout:] or rows[:heldout]
    free()

    # 2. the two models: the teacher frozen, the student with only its shared parts trainable
    t_model = teacher.model()
    dev = input_device(t_model)
    job.emit(pct=31, msg=f"loading the student {job.pruned_dir.name}")
    student = load_model(job.pruned_dir, profile(rj), rj.config.trust_remote_code)

    def trainable(name: str) -> bool:
        return not (".experts." in name or "embed_tokens" in name or name.startswith("lm_head"))

    params = [q for n, q in student.named_parameters() if trainable(n)]
    for q in student.parameters():
        q.requires_grad_(False)
    for q in params:
        q.requires_grad_(True)
    master = [q.detach().float().clone().requires_grad_(True) for q in params]   # fp32 copies the optimizer steps
    opt = torch.optim.AdamW(master, lr=lr, betas=(0.9, 0.95), weight_decay=0.0)

    def logits(model, r):
        ids = torch.tensor([r["ids"]], device=dev)
        return model(input_ids=ids, use_cache=False).logits[0, r["start"] - 1:-1].float()

    # 3. the held-out measure: KL over the teacher's top-k tokens, both sides renormalised
    with torch.no_grad():
        refs = [logits(t_model, r).log_softmax(-1).topk(top_k, -1) for r in held]

    def heldout_kl() -> float:
        student.eval()
        total = n = 0
        with torch.no_grad():
            for r, (tv, ti) in zip(held, refs):
                ls = logits(student, r).log_softmax(-1).gather(1, ti)
                ls = ls - ls.logsumexp(-1, keepdim=True)
                pt = (tv - tv.logsumexp(-1, keepdim=True)).exp()
                total += (pt * (pt.log() - ls)).sum().item()
                n += ti.shape[0]
        student.train()
        return total / max(n, 1)

    # 4. the loss: forward KL teacher -> student on every answer token
    def loss(r) -> float:
        with torch.no_grad():
            lt = logits(t_model, r).log_softmax(-1)
        ls = logits(student, r).log_softmax(-1)
        per = (lt.exp() * (lt - ls)).sum(-1)
        w = 1.0
        if focus:
            w = (per.detach() / per.detach().mean().clamp(min=1e-8)).clamp(max=4.0) ** focus
            w = w / w.mean()
        ((per * w).mean() / accum).backward()
        return per.detach().mean().item()

    # 5. the loop: accumulate, step on fp32 masters, check the held-out KL, keep the best
    start_kl = heldout_kl()
    best = {"kl": start_kl, "step": 0, "state": None}
    history, running, step, k = [], None, 0, 0
    steps = max(1, math.ceil(len(train) * epochs / accum))
    t0 = time.time()
    job.emit(pct=36, msg=f"kd: {sum(q.numel() for q in params) / 1e9:.2f}B trainable, {len(train)} sequences, "
                         f"held-out KL {start_kl:.4f}")
    student.train()
    stop = False
    while step < steps and not stop:
        for r in train:
            v = loss(r)
            running = v if running is None else 0.95 * running + 0.05 * v
            k += 1
            if k % accum:
                continue
            if all(q.grad is None or torch.isfinite(q.grad).all() for q in params):
                for q, mq in zip(params, master):
                    mq.grad = None if q.grad is None else q.grad.float()
                torch.nn.utils.clip_grad_norm_(master, 1.0)
                for g in opt.param_groups:   # short warm-up, then cosine down to zero
                    g["lr"] = lr * min(1.0, (step + 1) / max(1, steps // 20)) * 0.5 * (1 + math.cos(math.pi * step / steps))
                opt.step()
                with torch.no_grad():
                    for q, mq in zip(params, master):
                        q.copy_(mq.to(q.dtype))
            opt.zero_grad(set_to_none=True)
            for q in params:
                q.grad = None
            step += 1
            job.emit(pct=36 + 55 * step / steps, msg=f"kd step {step}/{steps} · KL {running:.4f}")
            if step % eval_every == 0 or step >= steps:
                kl = heldout_kl()
                history.append({"step": step, "kl": round(kl, 4)})
                if kl < best["kl"]:
                    best.update(kl=kl, step=step, state=[q.detach().to("cpu", copy=True) for q in params])
                job.emit(pct=36 + 55 * step / steps,
                         msg=f"kd step {step}: held-out KL {kl:.3f} (start {start_kl:.3f}, best {best['kl']:.3f})")
                if step - best["step"] >= 3 * eval_every:
                    stop = True
            if stop or step >= steps or time.time() - t0 > minutes * 60:
                stop = True
                break

    # 6. write the best point as <pruned>-healed (nothing when it never beat the start)
    kept = best["state"] is not None
    dst = job.healed_dir
    shutil.rmtree(dst, ignore_errors=True)
    if kept:
        with torch.no_grad():
            for q, saved in zip(params, best["state"]):
                q.copy_(saved.to(q.device))
        job.emit(pct=93, msg=f"writing {dst.name}")
        _save(student, teacher.tok, job.pruned_dir, dst)
    res = {"kl_before": round(start_kl, 4), "kl_after": round(best["kl"], 4), "steps": step, "sequences": len(train),
           "heldout": len(held), "kept": kept, "best_step": best["step"], "history": history,
           "minutes": round((time.time() - t_start) / 60, 1)}
    job.write("work/kd.json", res)
    del opt, master
    teacher.free()
    return res


def _save(student, tok, src: Path, dst: Path) -> None:
    """Save in the pruned checkpoint's own layout, with its tokenizer and model code."""
    if json.loads((src / "config.json").read_text()).get("model_type") != "flint":
        from blackhole_pipeline import hfmoe
        hfmoe.save_like(student, tok, src, dst)
        return
    student.save_pretrained(dst, safe_serialization=True)
    tok.save_pretrained(dst)
    for f in src.iterdir():
        if f.suffix in (".py", ".jinja") or f.name == "generation_config.json":
            shutil.copy2(f, dst / f.name)
