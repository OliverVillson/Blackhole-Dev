# Benchmark a model you already compressed, a lab recipe for the GPU VM (or a Mac with serve = "mlx").
#
# Three built-in benchmark functions, each forkable:
#   kl-eval         KL to the base model over its top-20 tokens (the pipeline's own measure),
#                   top-1 agreement and both perplexities, on held-out text
#   speed-bench     time to first token, decode tok/s, throughput and peak memory, on this
#                   machine or through vLLM / mlx_lm.server / any OpenAI-compatible endpoint
#   external-bench  runs another harness (SWE-bench Pro, lm-eval, your own script) against a
#                   served copy of the model and reads its score back
# The shared code is blackhole_dev/functions_src/_bench.py.
#
# Point "model" at the folder to test (or leave "latest" to take the job's healed / pruned
# model). For SWE-bench Pro set "preset" to swebench-pro: it runs BlackHole-Harness's
# harness/scripts/swebench-pro.sh on the model (smoke task set; Docker on the GPU VM). For any
# other harness set "harness" to its command; with neither, that step is skipped. The command gets
# {url}, {model}, {model_dir}, {out}, {workers}, {name} filled in; for example
# lm-eval:  lm_eval --model local-completions --model_args model={model},base_url={url}/completions
#           --tasks gsm8k --output_path {out}       (score_key = results.gsm8k.exact_match,strict-match)
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/benchmarks",
    "1.0.0",
    title="Benchmark a compressed model",
    description=("KL to the base model, serving speed and memory, and an external benchmark harness, "
                 "each a forkable built-in function."),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["bench", "eval", "lab"],
    base="Qwen/Qwen3-30B-A3B",
    meta={"stage": "bench"},
)

model = recipe.input("model", "text", default="latest",
                     help="original, pruned, healed, int4, reaq, mlx, a folder, or latest (healed, else pruned)")
calib = recipe.input("calib", "text", default="",
                     help="KL text: empty = the job's held-out answers; chat, code, math, contest, mix, or a .txt/.jsonl")
n_tokens = recipe.input("n_tokens", "int", default=32768, min=1024, max=1000000,
                        help="Tokens of text the KL is measured on")
max_kl = recipe.input("max_kl", "float", default=0.15, min=0.0, max=10.0,
                      help="Stop when the KL to the base is above this")
serve = recipe.input("serve", "text", default="vllm",
                     help="How speed-bench and the harness reach the model: vllm (GPU VM), mlx (Mac), or empty "
                          "for transformers on this machine")
concurrency = recipe.input("concurrency", "int", default=8, min=1, max=256,
                           help="Requests in flight during the speed test")
harness = recipe.input("harness", "text", default="",
                       help="External benchmark command ({url} {model} {model_dir} {out} {workers} {name}); empty = the "
                             "preset's own (swebench-pro) or skip")
preset = recipe.input("preset", "text", default="generic",
                      help="swebench-pro (BlackHole-Harness's SWE-bench Pro script, Docker on the VM) or generic")

recipe.fn("kl-eval", model=model, calib=calib, n_tokens=n_tokens, id="kl",
          gates=[gate("kl", "<=", max_kl)])
recipe.fn("speed-bench", model=model, serve=serve, concurrency=concurrency, id="speed")
recipe.fn("external-bench", command=harness, preset=preset, model=model, serve=serve, id="external")
