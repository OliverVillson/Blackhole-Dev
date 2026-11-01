"""Built-in function `speed-bench`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork speed-bench`, or Fork in
the app's Functions view) to get your own copy in your functions folder; a function there with
the same name replaces this one everywhere, a renamed fork sits next to it. The shared code of
the benchmark functions is blackhole_dev/functions_src/_bench.py."""

from __future__ import annotations

import threading

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _bench, _smoe


@function("speed-bench", per="job")
def speed_bench(job, model: str = "latest", url: str = "", served_model: str = "", serve: str = "",
                serve_args: str = "", prompts: int = 8, prompt_tokens: int = 512, max_tokens: int = 256,
                concurrency: int = 1, api_key: str = "") -> dict:
    """Speed of a model: time to the first token, decode tok/s, aggregate throughput and peak
    memory, on `prompts` prompts of `prompt_tokens` tokens each answered with exactly
    `max_tokens` tokens (greedy, end-of-text ignored).

    Three ways to run it:
      url = ""  serve = ""       transformers on this machine, one prompt at a time (a quick
                                 check; real serving speed needs vLLM or MLX)
      serve = "vllm" or "mlx"    starts `vllm serve` (GPU VM) or mlx_lm.server (Mac) on the
                                 model, benchmarks it at `concurrency`, stops it; peak memory
                                 is the server's (GPU memory with vLLM, RSS with MLX)
      url = "http://host:port/v1"  any OpenAI-compatible endpoint already running; set
                                 served_model when it serves several
    `model` is any of original, pruned, healed, int4, reaq, mlx, a folder, or "latest".
    Writes work/speed-<model>.json."""
    label, path = _bench.resolve(job, model) if not url else (served_model or "endpoint", None)
    if not url and not serve:
        if _bench.is_mlx(path):
            raise RuntimeError(f"{path} is an MLX folder: use serve = \"mlx\" (on the Mac)")
        tok = _smoe.tokenizer(path)
        job.emit(pct=5, msg=f"loading {label}")
        hf = _bench.load(path)
        job.emit(pct=20, msg=f"{prompts} prompts x {prompt_tokens} tokens, {max_tokens} new each")
        res = _bench.local_speed(hf, tok, _bench.prompt_ids(tok, prompts, prompt_tokens), max_tokens)
        del hf
        _bench.free()
        res["backend"] = "transformers"
    else:
        tok = _smoe.tokenizer(path) if path is not None else None
        texts = [tok.decode(ids) for ids in _bench.prompt_ids(tok, prompts, prompt_tokens)] if tok else \
            [f"Task {i}. Write a Python function that parses a log file and groups errors. " * (prompt_tokens // 16)
             for i in range(prompts)]
        if url:
            name = served_model or (_bench.served_models(url, api_key) or ["default"])[0]
            res = _bench.endpoint_speed(url, name, texts, max_tokens, concurrency, api_key)
            res["backend"] = url
        else:
            name = label
            logf = job.path("work", "speed", f"{label}-{serve}.log")
            logf.parent.mkdir(parents=True, exist_ok=True)
            job.emit(pct=5, msg=f"starting {serve} on {label}")
            with _bench.serving(serve, path, name, serve_args, log_path=logf) as (base, proc):
                if serve == "mlx":
                    name = (_bench.served_models(base) or [str(path)])[0]
                peak = {"gb": 0.0}
                done = threading.Event()

                def watch():
                    while not done.wait(0.5):
                        g = _bench.gpu_used_gb() if serve == "vllm" else _bench.tree_rss_gb(proc.pid)
                        if g:
                            peak["gb"] = max(peak["gb"], g)
                t = threading.Thread(target=watch, daemon=True)
                t.start()
                job.emit(pct=40, msg=f"{prompts} prompts at concurrency {concurrency}")
                try:
                    res = _bench.endpoint_speed(base, name, texts, max_tokens, concurrency)
                finally:
                    done.set()
                    t.join(timeout=5)
            res["backend"] = serve
            res["peak_mem_gb"] = peak["gb"] or None
    res.update({"model": label, **({"model_dir": str(path)} if path is not None else {}),
                "max_tokens": max_tokens})
    job.write(f"work/speed-{label}.json", res)
    job.log(f"speed-bench: {label} ({res['backend']}): {res['decode_tok_s'] or 0:.1f} tok/s decode, "
            f"TTFT {res['ttft_ms_median'] or 0:.0f} ms"
            + (f", peak {res['peak_mem_gb']:.2f} GB" if res.get("peak_mem_gb") else ""))
    return {k: v for k, v in res.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
