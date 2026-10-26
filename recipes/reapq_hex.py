# REAP/Q-HEX built from named anatomy functions: the same recipe as the pipeline's reap, reaq
# and HEX stages, written as `model.edit` stages that call functions by name. Swap a function
# for your own (a .py file listed in `functions`) to change the recipe without touching the
# harness. BlackHole-Harness originals: REAQ picks each expert's table size from its REAP
# score; HEX stores each expert with its own learned 8/16-level table (3.25 / 4.25 bpw).
#
# Everything here runs on the CPU of the machine that holds the weights except reap-score and
# the GPTQ Hessians of hex-quantize, which run the model on `device` over `calib` texts.
#
# The Python form of schemas/reapq-hex.toml (blackhole/v1 TOML).

from blackhole_dev.recipe import Recipe, gate


recipe = Recipe(
    "anatomy/reapq-hex",
    "0.1.0",
    title="REAP/Q-HEX from named functions",
    description=(
        "REAP-prune, REAQ-rank and HEX-quantize a MoE with the anatomy API's named functions; packed HEX "
        "layout out."
    ),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["moe", "reap", "reaq", "hex", "anatomy", "functions", "blackhole-original"],
    targets={"architectures": ["moe", "hybrid"]},
)

prune = recipe.input(
    "prune",
    "float",
    default=0.25,
    min=0.0,
    max=0.5,
    help="Share of experts REAP removes in every MoE layer",
)
avg_bits = recipe.input(
    "avg_bits",
    "float",
    default=3.5,
    min=3.25,
    max=4.25,
    help=(
        "Average expert bits: REAQ gives the hottest experts hex4 (4.25 bpw) and the rest hex3 (3.25) to "
        "land here"
    ),
)
calib = recipe.input(
    "calib",
    "path",
    default="calib.jsonl",
    help=(
        "Calibration texts (.jsonl with a text field, or .txt paragraphs) for REAP scores and GPTQ"
    ),
)

recipe.fn("reap-score", "score", calib=calib)
recipe.fn("reap-prune", "prune", ratio=prune)
recipe.edit(
    [
        {"fn": "reap-score", "calib": calib},        # re-score the survivors
        {"fn": "reaq", "avg_bits": avg_bits},
        {"fn": "hex-quantize", "calib": calib},
    ],
    "hex",
    gates=[gate("hex-quantize.rel_mse", "<=", 0.2)],
)
# a no-op mark; this stage only writes the packed HEX layout
recipe.fn("quant", "pack", select="layers[*].moe.router", format="bf16", pack="hex")

recipe.eval(gates=[gate("hex.hex-quantize.rel_mse", "<=", 0.2)])

