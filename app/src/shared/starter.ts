// Starter text for new files. Format: blackhole_dev.recipe (see ws2-recipe.md).
export const STARTER = {
  recipe: (name: string) => `"""${name}: describe what this recipe makes and for which machine."""
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "me/${name}", "0.1.0",
    title="${name}",
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
`,
  fn: (name: string) => `"""${name}: one line on what this function does to the model."""
from blackhole_dev import function


@function("${name}", per="model")
def ${name.replace(/-/g, "_")}(m, strength: float = 1.0):
    # m is the opened model (blackhole_dev anatomy). Query parts, read or write weights:
    #   for e in m["experts[rank<0.25]"]: ...
    #   m.layers[3].attn.q_proj[0, 17] = 0.0
    return m
`,
};
