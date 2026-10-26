"""Built-in function `router-temperature`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork router-temperature`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("router-temperature", per="part")
def router_temperature(router, t: float = 1.0, select: str = "layers[*].moe.router"):
    """Divide router logits by t (t > 1 spreads the load, t < 1 sharpens the routing)."""
    router.temperature(t)
