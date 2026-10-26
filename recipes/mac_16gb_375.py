# Mac 16 GB coder, lighter prune: the BlackHole preset 'mac-16gb-375' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/mac-16gb-375",
    "1.0.0",
    title="Mac 16 GB coder, lighter prune",
    description=(
        "Like Mac 16 GB coder but REAP drops 37.5% of routed experts and the MLX groups are 128 wide (~11 "
        "GB): better quality, needs the Mac's GPU memory limit raised (sudo sysctl "
        "iogpu.wired_limit_mb=12288) and few other apps open."
    ),
    author="BlackHole-Harness",
    tags=["mac", "code", "moe", "lab"],
    meta={"quant": "mlx-3bit", "preset": "mac-16gb-375"},
)

recipe.fn("calibrate", calib="code")
# drop 37.5% of routed experts, calibrated on code
recipe.fn("reap-gpu", ratio=0.375)
# distil from the unpruned teacher on 1k coding prompts
recipe.fn("distil", prompts=1024)
# MLX: GPTQ 3-bit g128 experts, 4-bit attention
recipe.fn("mlx-export", bits=3, group=128, hot=0.0)
# distil again around the 3-bit model so the heal repairs the quantization too
recipe.fn("qheal")
recipe.fn("bench", models="original,mlx")
recipe.fn("package")
