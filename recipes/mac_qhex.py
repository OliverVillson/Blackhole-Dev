# REAP/Q-HEX Mac coder: the BlackHole preset 'mac-qhex' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/mac-qhex",
    "1.0.0",
    title="REAP/Q-HEX Mac coder",
    description=(
        "The full REAP/Q-HEX recipe for a 16 GB Apple-silicon Mac (~10.5 GB, 50-60 tok/s target): REAP "
        "drops 37.5% of routed experts on code; distillation from the teacher on its SHORTEST VERIFIED "
        "reasoning (code_contests problems solved 3x, answers run against the tests, the shortest pass "
        "kept), experts learning through low-rank updates, every layer and router matched to the teacher; "
        "then on-policy rounds where the student writes and the teacher grades; MLX export with HEX "
        "experts (each expert's own learned value table in its header; REAQ tiers: top 10% of experts by "
        "REAP 16-level, rest 8-level, GPTQ-rounded to the tables, own Metal kernel), GPTQ attention (q/o "
        "3-bit), an output-only vocab trim to the 64k tokens the teacher writes; finally a heal around "
        "the quantized model."
    ),
    author="BlackHole-Harness",
    tags=["mac", "code", "moe", "lab", "reaq", "distill"],
    meta={"quant": "mlx-3bit", "preset": "mac-qhex"},
)

recipe.fn("calibrate", calib="code")
# drop 37.5% of routed experts, calibrated on code
recipe.fn("reap-gpu", ratio=0.375)
# shortest verified traces + on-policy distillation, layer and router matching
recipe.fn("distil",
          calib="contest",
          samples=3,
          prompts=768,
          max_tokens=16384,
          seq=18432,
          expert_rank=16,
          layer_weight=1.0,
          router_weight=0.5,
          minutes=150,
          opd_rounds=2,
          opd_prompts=256,
          opd_minutes=90)
# MLX: HEX experts, REAQ tiers (top 10% 16-level, rest 8-level), GPTQ attention q/o 3-bit, 64k output vocab
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
          head_vocab=65536)
# distil again around the quantized model
recipe.fn("qheal", minutes=45)
recipe.fn("bench", models="original,mlx")
recipe.fn("package")
