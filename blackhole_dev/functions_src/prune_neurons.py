"""Built-in function `prune-neurons`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork prune-neurons`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("prune-neurons", per="model")
def prune_neurons(m, ratio: float = 0.125, select: str = "layers[*].mlp") -> dict:
    """Drop the `ratio` lowest-importance intermediate channels of every dense MLP the query
    matches (weight-norm importance; heal afterwards: the dense default prunes 12.5 to 25%)."""
    n = 0
    for p in m.select(select):
        p.prune_neurons(ratio=ratio)
        n += 1
    return {"mlps": n}
