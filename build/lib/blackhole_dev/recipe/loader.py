"""Load a recipe file: run it and pick the Recipe it builds.

The file runs as a module named after its path, so `@function` definitions in it
register once and re-register cleanly when the editor lints the file again.
"""

from __future__ import annotations

import hashlib
import sys
import traceback
import types
from pathlib import Path

from blackhole_dev.recipe.core import Recipe, RecipeError


def module_name(path: str | Path) -> str:
    return "blackhole_recipe_" + hashlib.sha1(str(Path(path).resolve()).encode()).hexdigest()[:12]


def load(path: str | Path | None = None, text: str | None = None) -> Recipe:
    """The Recipe a file builds. `text` is the file's content when it is not saved yet.
    Raises RecipeError with line-numbered problems for syntax errors, exceptions and files
    that build no recipe or more than one."""
    if path is None and text is None:
        raise RecipeError("give a path or the text of a recipe")
    fname = str(Path(path).resolve()) if path is not None else "<recipe>"
    if text is None:
        text = Path(path).read_text()
    try:
        code = compile(text, fname, "exec")
    except SyntaxError as e:
        raise RecipeError(f"syntax error: {e.msg}", [{
            "severity": "error", "message": f"syntax error: {e.msg}", "line": e.lineno or 1,
            "col": e.offset, "code": "syntax", "file": fname}]) from None
    mname = module_name(fname) if path is not None else "blackhole_recipe_unsaved"
    mod = types.ModuleType(mname)
    mod.__file__ = fname
    sys.modules[mname] = mod
    try:
        exec(code, mod.__dict__)  # noqa: S102  the user's own recipe, in their own helper process
    except RecipeError as e:
        for p in e.problems:
            p.setdefault("file", fname)
        if not e.problems:
            e.problems.append(_where(e, fname))
        raise
    except Exception as e:  # noqa: BLE001
        raise RecipeError(f"{type(e).__name__}: {e}", [_where(e, fname)]) from None
    return pick(mod.__dict__, fname)


def pick(ns: dict, fname: str = "<recipe>") -> Recipe:
    if isinstance(ns.get("recipe"), Recipe):
        return ns["recipe"]
    found = [v for v in ns.values() if isinstance(v, Recipe)]
    if len(found) == 1:
        return found[0]
    if not found:
        msg = "this file builds no Recipe (recipe = Recipe(\"you/name\", \"0.1.0\", ...))"
        raise RecipeError(msg, [{"severity": "error", "message": msg, "line": 1, "code": "recipe.none", "file": fname}])
    msg = f"this file builds {len(found)} Recipes; name the one to run `recipe`"
    raise RecipeError(msg, [{"severity": "error", "message": msg, "line": found[1].line or 1,
                             "code": "recipe.multiple", "file": fname}])


def _where(e: BaseException, fname: str) -> dict:
    line = 1
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == fname:
            line = fr.lineno or line
    return {"severity": "error", "message": f"{type(e).__name__}: {e}", "line": line, "code": "recipe.error",
            "file": fname}
