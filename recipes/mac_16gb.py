# Mac 16 GB coder: the BlackHole preset 'mac-16gb' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/mac-16gb",
    "1.0.0",
    title="Mac 16 GB coder",
    description=(
        "A coding model that fits a 16 GB Apple-silicon Mac (~9.5 GB): REAP drops half the routed "
        "experts, calibrated on code; the pruned model is distilled from the teacher on coding prompts; "
        "then an MLX folder with GPTQ 3-bit experts (top 12.5% by REAP on 4-bit, REAQ), 4-bit attention "
        "and embeddings, served by mlx_lm.server."
    ),
    author="BlackHole-Harness",
    tags=["mac", "code", "moe", "lab"],
    meta={"quant": "mlx-3bit", "preset": "mac-16gb"},
)

recipe.fn("calibrate", calib="code")
# drop 50% of routed experts, calibrated on code
recipe.fn("reap-gpu", ratio=0.5)
# distil from the unpruned teacher on 1k coding prompts
recipe.fn("distil", prompts=1024)
# MLX: GPTQ 3-bit experts, REAQ 4-bit hot tier, 4-bit attention
recipe.fn("mlx-export", bits=3, group=64, hot=0.125, hot_bits=4)
# distil again around the 3-bit model so the heal repairs the quantization too
recipe.fn("qheal")
recipe.fn("bench", models="original,mlx")
recipe.fn("package")
