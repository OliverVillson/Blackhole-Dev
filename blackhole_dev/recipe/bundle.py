"""Pack a recipe into a .bhr bundle: what the app sends to the VM.

    manifest.json     format bhr/1; id, version, name, base_model, target, runner, stages, inputs,
                      needs, functions, blackhole_dev_version, files {path: sha256}, created_at
    recipe.py         the source as written
    recipe.json       {"raw": blackhole/v1 dict, "meta": {...}} the VM reads (no blackhole_dev needed)
    functions/*.py    each user or forked function file the recipe calls

Built-in functions are pinned by their module's sha256 and blackhole_dev_version instead of
being copied: the VM runs the same blackhole_dev release (the app installs it there).
"""

from __future__ import annotations

import hashlib
import importlib
import json
import time
from pathlib import Path

import blackhole_dev
from blackhole_dev.recipe import pipeline as pl
from blackhole_dev.recipe.core import Recipe, RecipeError
from blackhole_dev.recipe.lint import lint_recipe
from blackhole_dev.recipe.loader import load, module_name


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _origin(name: str, recipe_file: Path | None) -> dict:
    """Where a function comes from: {"name", "origin": recipe|user|builtin, "path"?, "sha256"}."""
    from blackhole_dev import functions as fns
    f = fns.resolve(name) if hasattr(fns, "resolve") else fns.get(name)
    src = str(getattr(f, "path", "") or f.source)
    pkg = Path(blackhole_dev.__file__).resolve().parent
    if recipe_file is not None and src in (module_name(recipe_file), str(recipe_file)):
        return {"name": name, "origin": "recipe", "path": "recipe.py", "sha256": _sha(recipe_file.read_bytes())}
    p = Path(src)
    if src.endswith(".py") and p.is_file():
        if pkg in p.resolve().parents:
            return {"name": name, "origin": "builtin", "sha256": _sha(p.read_bytes())}
        return {"name": name, "origin": "user", "file": p.resolve(), "sha256": _sha(p.read_bytes())}
    try:
        mod = importlib.import_module(src)
        data = Path(mod.__file__).read_bytes() if getattr(mod, "__file__", None) else b""
    except Exception:  # noqa: BLE001
        data = b""
    return {"name": name, "origin": "builtin", "sha256": _sha(data) if data else ""}


def bundle(path: str | Path, out: str | Path | None = None, inputs: dict | None = None, model: str | None = None,
           target: str | None = None, text: str | None = None, with_plan: bool = True) -> dict:
    """Write the bundle. Returns {bundle, sha256, functions, manifest}. Raises RecipeError
    (with problems) when the recipe has errors."""
    from blackhole.core import schema as sch
    path = Path(path).resolve()
    r: Recipe = load(path, text)
    errors = [p for p in lint_recipe(r) if p["severity"] == "error"]
    if errors:
        for p in errors:
            p.setdefault("file", str(path))
        raise RecipeError(f"{len(errors)} problem(s) to fix before bundling: {errors[0]['message']}", errors)
    source = (text if text is not None else path.read_text()).encode()
    raw = r.to_raw()
    vals = sch.input_values(sch.parse(raw), dict(inputs or {}))

    files: dict[str, bytes] = {"recipe.py": source}
    fn_rows, by_file = [], {}
    names = sorted({n for st in r.steps for n in st.functions()})
    for name in names:
        try:
            o = _origin(name, path)
        except KeyError:
            continue                                   # lint allowed it: it comes from a stage's own files
        if o["origin"] == "user":
            f = o.pop("file")
            rel = by_file.get(f)
            if rel is None:
                rel = f"functions/{f.name}"
                n = 2
                while rel in files:
                    rel, n = f"functions/{f.stem}_{n}{f.suffix}", n + 1
                files[rel] = f.read_bytes()
                by_file[f] = rel
            o["path"] = rel
        fn_rows.append(o)

    # stage `functions` lists: the user's own entries (relative to the recipe) are copied in too
    for st in raw["stage"]:
        if str(st.get("kind", "")).split("@")[0] != "model.edit":
            continue
        new = []
        for spec in st.get("functions") or []:
            p = (path.parent / spec) if not Path(spec).is_absolute() else Path(spec)
            if str(spec).endswith(".py") and p.is_file():
                rel = by_file.get(p.resolve())
                if rel is None:
                    rel = f"functions/{p.name}"
                    files[rel] = p.read_bytes()
                    by_file[p.resolve()] = rel
                new.append(rel)
            else:
                new.append(spec)                       # a module name: installed on the VM
        mine = {o["path"] for o in fn_rows if o["origin"] in ("user", "recipe")
                if any(o["name"] == n for n in _stage_fns(st))}
        new += sorted(mine - set(new))
        if new:
            st["functions"] = new

    plan_out = None
    if with_plan:
        try:
            from blackhole_dev.recipe.plan import plan
            plan_out = plan(r, device=None, model=model, inputs=vals)
        except Exception:  # noqa: BLE001  the plan is a nicety here
            plan_out = None
    meta = dict(r.meta)
    files["recipe.json"] = (json.dumps({"raw": raw, "meta": meta}, indent=2, sort_keys=True) + "\n").encode()
    runner = r.runner
    manifest = {
        "id": r.id, "version": r.version, "name": r.name,
        "base_model": model or r.fields.get("base") or "",
        "target": target or meta.get("target") or "",
        "runner": runner,
        "stages": pl.stage_list(raw) if runner == "pipeline" else [s.id for s in r.steps],
        "inputs": vals,
        "needs": (plan_out or {}).get("needs") or {"gpu_gb": None, "disk_gb": None},
        "functions": fn_rows,
        "blackhole_dev_version": blackhole_dev.__version__,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    dst = Path(out) if out else path.parent / ".bhr" / f"{path.stem}.bhr"
    dst.parent.mkdir(parents=True, exist_ok=True)
    sha = pl.write_bundle(dst, files, manifest)
    manifest = json.loads(_read_member(dst, "manifest.json"))
    return {"bundle": str(dst.resolve()), "sha256": sha, "functions": fn_rows, "manifest": manifest}


def _stage_fns(st: dict) -> list[str]:
    out = [st["fn"]] if isinstance(st.get("fn"), str) else []
    out += [s["fn"] for s in st.get("steps") or [] if isinstance(s, dict) and isinstance(s.get("fn"), str)]
    return out


def _read_member(bhr: Path, name: str) -> bytes:
    import tarfile
    with tarfile.open(bhr, "r:gz") as tf:
        return tf.extractfile(name).read()
