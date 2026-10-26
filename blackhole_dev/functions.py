"""Named functions: weight manipulations packaged under a name, called from Python, the CLI
or a schema's `model.edit` stage.

    from blackhole_dev import function
    import numpy as np

    @function("clip-outliers")                       # the name schemas use; any name you like
    def clip(w: np.ndarray, sigma: float = 6.0) -> np.ndarray:
        "Clip weights beyond sigma standard deviations."
        s = float(w.std())
        return np.clip(w, -sigma * s, sigma * s)

    @function("tame-hot-experts", per="part")
    def tame(expert, factor: float = 0.9):
        expert.roles["down"].scale(factor)

    @function("my-recipe", per="model")
    def recipe(m, ratio: float = 0.25) -> dict:
        m.call("reap-prune", ratio=ratio)
        m.reaq(avg_bits=3.5)
        return {"experts_left": m.layers[0].moe.num_experts}

What a function receives depends on `per` (guessed from the first parameter's name when not
given: w / weights / tensor / array -> "tensor", m / model -> "model", else "part"):

  tensor   fn(w: float32 array, **params) -> new array of the same shape; applied to every
           tensor of the parts matched by `select` (biases and norms too unless the query
           leaves them out)
  part     fn(part, **params); called for every part matched by `select`
  model    fn(model, **params); does anything, may call other functions

Every function also takes `select` (a query, see blackhole_dev.query); per="tensor" and
per="part" functions need it, per="model" ones get it only if they declare it. Params are the
function's keyword arguments with defaults and type hints, so `blackhole fn list`, the TUI and
the schema builder can describe them, and a schema's stage is checked before anything runs.

  job      fn(job: blackhole_dev.jobctx.Job, **params); a pipeline stage on the GPU VM (traces,
           distil, qheal, bench, ...). Runs as its own process from a recipe's `job.fn` step.

A function may return a dict of metrics; it lands in the edit log, the receipt and the stage's
metrics.json.

Where functions come from, and which one wins (the override rule). Every definition sits in a
layer; for a name, the definition in the highest layer is the one every caller gets:

  0 builtin    blackhole_dev/functions_src/*.py, one readable file per function
  1 package    installed packages' `blackhole.functions` entry points
  2 user       the user functions folder: $BLACKHOLE_DEV_FUNCTIONS (os.pathsep-separated), else
               ~/.blackhole-dev/functions
  3 workspace  <workspace>/functions/*.py of the project open in the app (add_workspace)
  4 recipe     the recipe file itself, files it names, a bundle's functions/, code run directly

So a user function with the same name as a built-in replaces it everywhere (recipes, model.edit,
the CLI), and `fork(name)` is how you get one: it copies the winning definition's file into your
functions folder. Two definitions of one name in the SAME layer are an error. A broken file in
the user or workspace folder does not break the registry; it shows up in problems().
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
import json
import os
import re
import sys
import time
import typing
from dataclasses import dataclass
from importlib.metadata import entry_points
from pathlib import Path
from typing import Callable

import numpy as np

PER = ("tensor", "part", "model", "job")
_FIRST = {"w": "tensor", "weights": "tensor", "tensor": "tensor", "array": "tensor", "m": "model", "model": "model",
          "job": "job"}
LAYERS = ("builtin", "package", "user", "workspace", "recipe")
BUILTIN, PACKAGE, USER, WORKSPACE, RECIPE = range(5)
FORK_MARK = "# blackhole-fork: "


@dataclass
class Fn:
    name: str
    fn: Callable
    per: str
    doc: str
    params: dict            # name -> {type, default, help}
    source: str             # module or file it came from
    sha256: str = ""
    layer: int = RECIPE
    path: str = ""          # the file that defines it ("" when there is none, e.g. a REPL)

    @property
    def builtin(self) -> bool:
        return self.layer == BUILTIN

    def describe(self) -> dict:
        return {"name": self.name, "per": self.per, "doc": self.doc, "params": self.params, "source": self.source,
                "sha256": self.sha256, "layer": LAYERS[self.layer], "path": self.path, "builtin": self.builtin}


_DEFS: dict[str, dict[int, Fn]] = {}     # name -> layer -> definition
_REG: dict[str, Fn] = {}                 # name -> the winning definition
_loaded: set[str] = set()
_builtins_loaded = False
_layer_now: list[int] = []               # the layer of the file being loaded (stack)
_workspaces: list[Path] = []
_problems: list[dict] = []
_sha_cache: dict[str, str] = {}


def _file_sha(path: str) -> str:
    if not path:
        return ""
    if path not in _sha_cache:
        try:
            _sha_cache[path] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        except OSError:
            _sha_cache[path] = ""
    return _sha_cache[path]


def _params(fn: Callable, skip_first: bool) -> dict:
    sig = inspect.signature(fn)
    try:
        hints = typing.get_type_hints(fn)
    except Exception:  # noqa: BLE001
        hints = {}
    out = {}
    items = list(sig.parameters.items())[1 if skip_first else 0:]
    for name, p in items:
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        t = hints.get(name, type(p.default) if p.default is not p.empty and p.default is not None else str)
        out[name] = {"type": getattr(t, "__name__", str(t)), "default": None if p.default is p.empty else p.default,
                     "required": p.default is p.empty}
    return out


def _resolve(name: str) -> None:
    defs = _DEFS.get(name)
    if defs:
        _REG[name] = defs[max(defs)]
    else:
        _REG.pop(name, None)


def function(name: str | None = None, per: str | None = None, doc: str = ""):
    """Register fn under `name` (default: the Python name with - for _), in the layer of the file
    being loaded (see the module docs: a higher layer overrides a lower one)."""
    def deco(fn: Callable) -> Callable:
        first = next(iter(inspect.signature(fn).parameters), "")
        kind = per or _FIRST.get(first, "part")
        if kind not in PER:
            raise ValueError(f"per must be one of {PER}")
        n = name or fn.__name__.replace("_", "-")
        mod = getattr(fn, "__module__", "")
        try:
            path = str(Path(inspect.getsourcefile(fn) or "").resolve()) if inspect.getsourcefile(fn) else ""
        except TypeError:
            path = ""
        layer = _layer_now[-1] if _layer_now else RECIPE
        prev = _DEFS.get(n, {}).get(layer)
        if prev is not None and prev.fn is not fn and (prev.path or prev.source) != (path or mod):
            raise ValueError(f"function {n!r} is defined twice in the {LAYERS[layer]} layer: "
                             f"{prev.path or prev.source} and {path or mod}")
        _DEFS.setdefault(n, {})[layer] = Fn(n, fn, kind, (doc or inspect.getdoc(fn) or "").strip(), _params(fn, True),
                                            mod, _file_sha(path), layer, path)
        _resolve(n)
        return fn
    return deco


class _in_layer:
    def __init__(self, layer: int):
        self.layer = layer

    def __enter__(self):
        _layer_now.append(self.layer)

    def __exit__(self, *exc):
        _layer_now.pop()


def load_builtins() -> None:
    """Import every built-in file (functions_src) and the installed packages' functions."""
    global _builtins_loaded
    if _builtins_loaded:
        return
    _builtins_loaded = True
    import pkgutil

    import blackhole_dev.functions_src as src
    with _in_layer(BUILTIN):
        for info in sorted(pkgutil.iter_modules(src.__path__), key=lambda i: i.name):
            if not info.name.startswith("_"):
                importlib.import_module(f"{src.__name__}.{info.name}")
    with _in_layer(PACKAGE):
        for ep in entry_points(group="blackhole.functions"):
            try:
                ep.load()
            except Exception as e:  # noqa: BLE001
                _problems.append({"path": f"entry point {ep.name}", "error": f"{type(e).__name__}: {e}"})
    refresh()


_user_dirs: list[Path] | None = None


def set_user_dirs(dirs) -> list[Path]:
    """Use these folders as the user layer (the app's setting; None goes back to the default)."""
    global _user_dirs
    _user_dirs = None if dirs is None else [Path(d).expanduser() for d in dirs]
    refresh()
    return user_dirs()


def user_dirs() -> list[Path]:
    if _user_dirs is not None:
        return list(_user_dirs)
    env = os.environ.get("BLACKHOLE_DEV_FUNCTIONS")
    if env is not None:
        return [Path(d).expanduser() for d in env.split(os.pathsep) if d]
    return [Path.home() / ".blackhole-dev" / "functions"]


def add_workspace(root: str | Path) -> Path:
    """Use <root>/functions as the workspace functions folder (the project open in the app)."""
    d = Path(root).expanduser().resolve() / "functions"
    if d not in _workspaces:
        _workspaces.append(d)
    refresh()
    return d


def fork_dir() -> Path:
    """Where fork() writes: the workspace functions folder when one is open, else the user folder."""
    return _workspaces[-1] if _workspaces else user_dirs()[0]


def _exec_file(p: Path, layer: int) -> str:
    data = p.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    _sha_cache[str(p.resolve())] = sha
    mname = f"blackhole_fn_{sha[:12]}_{layer}"
    s = importlib.util.spec_from_file_location(mname, p)
    mod = importlib.util.module_from_spec(s)
    sys.modules[mname] = mod
    with _in_layer(layer):
        s.loader.exec_module(mod)
    return sha


def refresh() -> list[dict]:
    """Re-read the user and workspace folders (after a file was saved, added or deleted).
    Returns problems(): files that failed to load."""
    _problems[:] = [x for x in _problems if x["path"].startswith("entry point")]
    for name in list(_DEFS):
        for layer in (USER, WORKSPACE):
            _DEFS[name].pop(layer, None)
        if not _DEFS[name]:
            del _DEFS[name]
        _resolve(name)
    for layer, dirs in ((USER, user_dirs()), (WORKSPACE, list(_workspaces))):
        for d in dirs:
            if not d.is_dir():
                continue
            for p in sorted(d.glob("*.py")):
                if p.name.startswith("_"):
                    continue
                _sha_cache.pop(str(p.resolve()), None)
                try:
                    _exec_file(p, layer)
                except Exception as e:  # noqa: BLE001
                    _problems.append({"path": str(p), "error": f"{type(e).__name__}: {e}"})
    return problems()


def problems() -> list[dict]:
    return [dict(x) for x in _problems]


def _builtins() -> None:
    load_builtins()


def load(spec: str, base: Path | None = None, layer: int = RECIPE) -> str:
    """Import a module name or a .py file so its @function decorators register (in the recipe
    layer unless told otherwise). Returns the file's sha256 (what a schema pins)."""
    _builtins()
    p = Path(spec).expanduser()
    if base is not None and not p.is_absolute():
        p = base / p
    if spec.endswith(".py") or p.is_file():
        if not p.is_file():
            raise FileNotFoundError(f"no function file {spec}")
        sha = hashlib.sha256(p.read_bytes()).hexdigest()
        key = f"file:{p.resolve()}:{sha}:{layer}"
        if key not in _loaded:
            _exec_file(p, layer)
            _loaded.add(key)
        return sha
    with _in_layer(layer):
        mod = importlib.import_module(spec)
    f = getattr(mod, "__file__", None)
    return hashlib.sha256(Path(f).read_bytes()).hexdigest() if f else ""


def registry() -> dict[str, Fn]:
    _builtins()
    return dict(sorted(_REG.items()))


def definitions(name: str) -> list[Fn]:
    """Every definition of `name`, lowest layer first (the last one is the one that runs)."""
    _builtins()
    return [f for _, f in sorted(_DEFS.get(name, {}).items())]


def get(name: str) -> Fn:
    _builtins()
    if name not in _REG:
        near = [n for n in _REG if name.split("-")[0] in n][:5]
        raise KeyError(f"no function {name!r}" + (f"; did you mean {', '.join(near)}?" if near else
                                                  "; `blackhole fn list` shows them"))
    return _REG[name]


resolve = get


def _fork_info(path: str) -> dict | None:
    try:
        with open(path) as fh:
            for _ in range(3):
                line = fh.readline()
                if line.startswith(FORK_MARK):
                    return json.loads(line[len(FORK_MARK):])
    except (OSError, ValueError):
        pass
    return None


def rows() -> list[dict]:
    """One row per function for the app's Functions view: what runs, where it lives, what it
    replaces, and whether a fork's original changed since it was forked."""
    out = []
    for name, f in registry().items():
        r = f.describe()
        r["overrides"] = [{"layer": LAYERS[d.layer], "path": d.path, "sha256": d.sha256} for d in definitions(name)[:-1]]
        info = _fork_info(f.path) if f.path and not f.builtin else None
        if info:
            r["forked_from"] = info
            orig = next((d for d in definitions(info.get("name", "")) if d.layer < f.layer), None)
            r["upstream_changed"] = bool(orig and info.get("sha256") and orig.sha256 != info["sha256"])
        out.append(r)
    return out


def source(name: str) -> dict:
    """The winning definition's file, for reading in the editor (built-ins are read-only: fork them)."""
    f = get(name)
    text = Path(f.path).read_text() if f.path and Path(f.path).is_file() else inspect.getsource(f.fn)
    return {"name": name, "path": f.path, "text": text, "sha256": f.sha256, "builtin": f.builtin,
            "layer": LAYERS[f.layer], "readonly": f.layer in (BUILTIN, PACKAGE), "per": f.per}


_BUILTIN_DOC = re.compile(r'\A"""Built-in function `[^`]+`\.\n\n.*?"""\n', re.S)


def fork(name: str, dest: str | Path | None = None, new_name: str | None = None, overwrite: bool = False) -> dict:
    """Copy the file that defines `name` into your functions folder (dest, else fork_dir()).
    Kept under the same name, the copy replaces the original everywhere; with new_name it is
    a separate function next to it. The copy starts with a `# blackhole-fork:` line naming what
    it came from (and that file's sha256), so the app can tell you when the original changes."""
    f = get(name)
    target = new_name or name
    d = Path(dest).expanduser() if dest else fork_dir()
    d.mkdir(parents=True, exist_ok=True)
    dst = d / (re.sub(r"[^0-9A-Za-z_]", "_", target) + ".py")
    if f.path and Path(f.path).resolve() == dst.resolve():
        raise ValueError(f"{name} already lives in {dst}: edit it there")
    if dst.exists() and not overwrite:
        raise FileExistsError(f"{dst} exists (pass overwrite=True to replace it)")
    text = source(name)["text"]
    others = [n for n, g in _REG.items() if g.path and g.path == f.path and n != name]
    if new_name:
        text = re.sub(r'(@function\(\s*)(["\'])' + re.escape(name) + r'\2', lambda m: f'{m.group(1)}"{new_name}"', text)
    text = _BUILTIN_DOC.sub(
        f'"""Fork of the {LAYERS[f.layer]} function `{name}`'
        + (f", renamed `{new_name}`: it runs next to the original." if new_name else
           f": while it keeps the name `{name}` it replaces the original everywhere.") + '"""\n', text, count=1)
    mark = FORK_MARK + json.dumps({"name": name, "layer": LAYERS[f.layer], "sha256": f.sha256, "path": f.path,
                                   "date": time.strftime("%Y-%m-%d")}) + "\n"
    if text.startswith(FORK_MARK):            # a fork of a fork: the new mark replaces the old one
        text = text.split("\n", 1)[1]
    text = mark + text
    dst.write_text(text)
    refresh()
    in_registry = d.resolve() in {x.expanduser().resolve() for x in [*user_dirs(), *_workspaces]}
    if not in_registry:
        load(str(dst))
    g = _REG.get(target)
    return {"path": str(dst), "name": target, "active": bool(g and g.path == str(dst.resolve())),
            "overrides": [LAYERS[x.layer] for x in definitions(target)[:-1]],
            "forked_from": {"name": name, "layer": LAYERS[f.layer], "sha256": f.sha256},
            "also_defined_in_file": others}


def describe(name: str) -> dict:
    return get(name).describe()


def check(name: str, params: dict) -> list[str]:
    """Problems with a call before running it: unknown function, unknown or missing params."""
    try:
        f = get(name)
    except KeyError as e:
        return [e.args[0]]
    known = set(f.params) | {"select"}
    out = [f"{name}: unknown param {k!r} (has {sorted(f.params)})" for k in params if k not in known]
    out += [f"{name}: missing param {k!r}" for k, spec in f.params.items() if spec["required"] and k not in params]
    if f.per in ("tensor", "part") and "select" not in params and "select" not in f.params:
        out.append(f"{name}: per-{f.per} functions need select = \"<query>\"")
    return out


def _coerce(val, typename: str):
    try:
        if typename == "float" and isinstance(val, (int, float, str)):
            return float(val)
        if typename == "int" and isinstance(val, (int, str)) and not isinstance(val, bool):
            return int(val)
        if typename == "bool" and isinstance(val, str):
            return val.lower() in ("1", "true", "yes", "on")
    except ValueError:
        pass
    return val


def call(model, name: str, select: str | None = None, **params):
    """Run a named function on a model. Returns what the function returned."""
    f = get(name)
    if f.per == "job":
        raise ValueError(f"{name} is a job function (a pipeline stage): run it from a recipe, or call_job(job, ...)")
    probs = check(name, {**params, **({"select": select} if select is not None else {})})
    if probs:
        raise ValueError("; ".join(probs))
    kw = {k: _coerce(v, f.params[k]["type"]) if k in f.params else v for k, v in params.items()}
    if f.per == "model":
        if "select" in f.params:
            kw["select"] = select if select is not None else f.params["select"]["default"]
        out = f.fn(model, **kw)
    else:
        q = select if select is not None else f.params.get("select", {}).get("default")
        if "select" in f.params:
            kw["select"] = q
        parts = model.select(q)
        if f.per == "part":
            res = [f.fn(p, **kw) for p in parts]
            out = {"parts": len(parts)} | (_merge_metrics(res) if any(isinstance(r, dict) for r in res) else {})
        else:
            kw.pop("select", None)
            n = 0
            for p in parts:
                for v in p.views:
                    v.apply(lambda w, _kw=kw: _check_shape(f.name, w, f.fn(w, **_kw)), f"fn {f.name}")
                    n += 1
            out = {"parts": len(parts), "tensors": n}
    model.log.append({"op": "fn", "fn": name, "select": select, "params": params,
                      **({"result": out} if isinstance(out, dict) else {})})
    model.functions[name] = f.sha256 or f.source
    return out


def call_job(job, name: str, **params):
    """Run a job-level function (per="job": a pipeline stage) on a blackhole_dev.jobctx.Job."""
    f = get(name)
    if f.per != "job":
        raise ValueError(f"{name} is a per-{f.per} function: call it on a model (m.call) or from model.edit")
    probs = check(name, params)
    if probs:
        raise ValueError("; ".join(probs))
    kw = {k: _coerce(v, f.params[k]["type"]) for k, v in params.items()}
    out = f.fn(job, **kw)
    if hasattr(job, "functions"):
        job.functions[name] = f.sha256 or f.source
    return out


def _check_shape(name: str, w: np.ndarray, out) -> np.ndarray:
    out = np.asarray(out, np.float32)
    if out.shape != w.shape:
        raise ValueError(f"function {name} returned shape {out.shape} for weights of shape {w.shape}")
    return out


def _merge_metrics(rows: list) -> dict:
    out: dict = {}
    for r in rows:
        if isinstance(r, dict):
            for k, v in r.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    out[k] = out.get(k, 0) + v
    return out
