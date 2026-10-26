# REAQ codebook (lab): the BlackHole preset 'reaq-codebook' as a recipe of named functions.
# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change
# what that step does; a fork with the same name replaces the built-in in this recipe.
# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.

from blackhole_dev.recipe import Recipe


recipe = Recipe(
    "blackhole/reaq-codebook",
    "1.0.0",
    title="REAQ codebook (lab)",
    description=(
        "Best method of 2026-10-23, experimental. REAP drops 25% of routed experts; GPTQ int4 makes the "
        "shippable model; then REAQ per-expert codebooks (top half of each layer's experts by REAP score "
        "on 16-level tables, the rest 8-level) are measured against it and saved for a future kernel. "
        "Runs on the real pipeline (blackhole_pipeline)."
    ),
    author="BlackHole-Harness",
    tags=["lab", "experimental", "moe"],
    meta={"quant": "int4", "preset": "reaq-codebook"},
)

recipe.fn("calibrate")
# drop 25% of routed experts by REAP score
recipe.fn("reap-gpu", ratio=0.25)
# GPTQ int4 g128 on the routed experts (shipped)
recipe.fn("gptq", calib=64)
# REAQ codebooks 16/8-level by REAP rank (lab, measured)
recipe.fn("reaq-codebook", top=0.5, block=32)
recipe.fn("bench")
recipe.fn("fp8-experts")
recipe.fn("package")
