# REAP/Q-HEX Mac coder, short thinking (Qwen3.6): the BlackHole preset 'qwen-mac-qhex-short' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/qwen-mac-qhex-short",
    "1.0.0",
    title="REAP/Q-HEX Mac coder, short thinking (Qwen3.6)",
    description=(
        "qwen-mac-qhex trained to think SHORTER: the compressed Qwen3.6 thought for a median 25k tokens "
        "on LiveCodeBench and 35% of its answers never finished within 64k (looping), while a 32k "
        "thinking budget lost nothing. The teacher solves 1024 code_contests problems 4x; thinking still "
        "open at 8k tokens is cut and the teacher is told to answer now (budget forcing), only answers "
        "that finished and pass their tests count, and the shortest is kept; two on-policy rounds with "
        "12k-token student rollouts teach it to climb out of its own loops (the teacher grades every "
        "token); training runs through without early stopping on the held-out KL (which cannot see answer "
        "length) and the bench judges the result. Same MLX export (HEX experts, REAQ tiers, full output "
        "vocab) and quantized heal."
    ),
    author="BlackHole-Harness",
    tags=["mac", "code", "moe", "lab", "reaq", "distill", "qwen"],
    meta={"quant": "mlx-3bit", "preset": "qwen-mac-qhex-short"},
)

recipe.fn("calibrate", calib="code")
# drop 31.25% of routed experts, calibrated on code
recipe.fn("reap-gpu", ratio=0.3125)
# budget-forced verified traces (thinking cut at 8k, then answer; shortest finished pass of 4), on-policy rounds against looping
recipe.fn("distil",
          calib="contest",
          samples=4,
          prompts=1024,
          max_tokens=12288,
          think_budget=8192,
          seq=14336,
          epochs=2.0,
          keep_weights="last",
          expert_rank=16,
          layer_weight=1.0,
          router_weight=0.5,
          minutes=90,
          opd_rounds=2,
          opd_prompts=384,
          opd_minutes=60)
# MLX: HEX experts, REAQ tiers (top 10% 16-level, rest 8-level), GPTQ attention q/o 3-bit, full output vocab
recipe.fn("mlx-export",
          hex=1,
          bits=3,
          group=128,
          hot=0.1,
          hot_bits=4,
          attn_gptq=1,
          qo_bits=3,
          head_bits=4,
          embed_bits=3,
          head_vocab=0)
# distil again around the quantized model
recipe.fn("qheal", minutes=30)
recipe.fn("bench", models="mlx")
recipe.fn("package")
