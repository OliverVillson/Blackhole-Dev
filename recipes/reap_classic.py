# REAP classic: the BlackHole preset 'reap-classic' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/reap-classic",
    "1.0.0",
    title="REAP classic",
    description=(
        "REAPer's pipeline: prune experts by router-weighted activation on purpose-built calibration "
        "data, then store experts in fp8."
    ),
    author="BlackHole-Harness",
    tags=["moe", "fast"],
    meta={"quant": "fp8", "preset": "reap-classic"},
)

recipe.fn("calibrate")
# drop 50% of routed experts per layer
recipe.fn("reap-gpu", ratio=0.5)
recipe.fn("fp8-experts")
recipe.fn("package")
