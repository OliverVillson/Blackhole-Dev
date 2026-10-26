"""Recipes: BlackHole schemas written as Python, the format the BlackHole-Dev app edits.

    from blackhole_dev.recipe import Recipe, gate

    recipe = Recipe("you/mac-coder", "0.1.0", title="Mac coder", base="Qwen/Qwen3.6-35B-A3B")
    prune = recipe.input("prune", "float", default=0.3125, min=0.0, max=0.5)
    recipe.step("pipeline.reap", prune=prune, calib="code")     # a stage of the real pipeline
    recipe.fn("reap-prune", ratio=prune)                         # a named function (model.edit)
    recipe.step("eval.kl", gates=[gate("kl", "<=", 0.1)])        # any op in the catalog

A recipe compiles to the blackhole/v1 schema dict (`recipe.to_raw()`), so TOML schemas
convert to recipes and back without loss (`from_toml`). `lint`, `plan` and `bundle` are
what the app's helper (blackhole_dev.rpc) calls; a bundle (.bhr) is what runs on the VM
(`python -m blackhole_pipeline --job DIR --recipe X.bhr`).
"""

from blackhole_dev.recipe.core import PIPELINE_STEPS, Recipe, RecipeError, Ref, Step, gate
from blackhole_dev.recipe.loader import load

__all__ = ["Recipe", "Step", "Ref", "gate", "RecipeError", "PIPELINE_STEPS", "load", "lint", "plan", "bundle",
           "from_toml", "from_raw", "from_preset"]


def lint(path=None, text=None, publish: bool = False):
    from blackhole_dev.recipe.lint import lint as _lint
    return _lint(path, text, publish)


def plan(path=None, text=None, **kw):
    from blackhole_dev.recipe.plan import plan as _plan
    return _plan(load(path, text), **kw)


def bundle(path, **kw):
    from blackhole_dev.recipe.bundle import bundle as _bundle
    return _bundle(path, **kw)


def from_toml(path, out=None):
    from blackhole_dev.recipe.convert import from_toml as _f
    return _f(path, out)


def from_raw(raw, **kw):
    from blackhole_dev.recipe.convert import from_raw as _f
    return _f(raw, **kw)


def from_preset(preset, out=None):
    from blackhole_dev.recipe.convert import from_preset as _f
    return _f(preset, out)
