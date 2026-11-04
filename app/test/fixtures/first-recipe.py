"""first-recipe: describe what this recipe makes and for which machine."""
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "me/first-recipe", "0.1.0",
    title="first-recipe",
    base="Qwen/Qwen3-30B-A3B",
    targets={"architectures": ["moe"]},
    meta={"target": "mac16"},
)

prune = recipe.input("prune", "float", default=0.25, min=0.0, max=0.5, help="Share of routed experts dropped")

recipe.fn("reap-score", calib="code")
recipe.fn("reap-prune", ratio=prune, id="prune")
recipe.edit([{"fn": "reaq", "avg_bits": 3.5}, {"fn": "hex-quantize"}], id="hex",
            gates=[gate("hex-quantize.rel_mse", "<=", 0.2)], pack="hex")
recipe.eval()
