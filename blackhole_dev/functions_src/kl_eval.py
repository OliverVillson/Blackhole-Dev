"""Built-in function `kl-eval`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork kl-eval`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The shared code of the
benchmark functions is blackhole_dev/functions_src/_bench.py."""

from __future__ import annotations

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _bench, _smoe


@function("kl-eval", per="job")
def kl_eval(job, model: str = "latest", base: str = "original", calib: str = "", n_tokens: int = 32768,
            seq_len: int = 1024, batch_size: int = 4, top: int = 20, seed: int = 7) -> dict:
    """How far a compressed model drifted from its base: KL(base || model) over the base's
    top-20 tokens (both renormalised there, the pipeline's own measure), top-1 agreement and
    both perplexities, on the same `n_tokens` of held-out text. `model` and `base` are any of
    original, pruned, healed, int4, a folder path, or "latest" (healed, else pruned); not hex.

    The text: empty `calib` = the job's held-out answers when there are any, else the "mix"
    set; or chat, code, math, contest, mix, or your own .txt/.jsonl. The base runs first and
    only its top-20 log-probs are kept, so the two models never share the GPU. MLX folders
    cannot load here: score those on the Mac or use speed-bench / external-bench instead.
    Writes work/kl-eval-<model>.json."""
    label, path = _bench.resolve(job, model)
    blabel, bpath = _bench.resolve(job, base)
    for p in (path, bpath):
        if _bench.is_mlx(p):
            raise RuntimeError(f"{p} is an MLX folder; kl-eval loads models with transformers")
        if _bench.is_hex(p):
            raise RuntimeError(f"{p} is a HEX folder for vLLM, which transformers cannot load: hex-vllm already "
                               "measured its KL to the teacher (work/hexvllm.json); use speed-bench / external-bench "
                               "with serve = \"vllm\" for it")
    tok = _smoe.tokenizer(bpath)
    texts, note = _smoe.calib_texts(calib, n_tokens, seed, job.path("data", "heldout.jsonl"))
    data = list(_smoe.batches(texts, tok, n_tokens, seq_len, batch_size, seed))
    job.emit(pct=5, msg=f"{blabel}: top-{top} reference on {n_tokens} tokens of {note}")
    hf = _bench.load(bpath)
    refs = _bench.teacher_ref(hf, data, top)
    del hf
    _bench.free()
    job.emit(pct=50, msg=f"scoring {label}")
    hf = _bench.load(path)
    res = _bench.compare(hf, refs)
    del hf
    _bench.free()
    res.update({"model": label, "model_dir": str(path), "base": blabel, "top": top, "text": note})
    job.write(f"work/kl-eval-{label}.json", res)
    job.log(f"kl-eval: {label} vs {blabel}: KL {res['kl']:.4f}, top-1 {res['top1_agreement']:.3f}, "
            f"ppl {res['ppl_teacher']:.2f} -> {res['ppl_student']:.2f}")
    return {k: v for k, v in res.items() if isinstance(v, (int, float))}
