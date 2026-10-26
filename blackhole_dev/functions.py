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

A function may return a dict of metrics; it lands in the edit log, the receipt and the stage's
metrics.json. Functions come from this module (built-ins), a module or .py file named in the
schema's `functions` list (recorded with its sha256), or the `blackhole.functions` entry
point group of an installed package.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
import sys
import typing
from dataclasses import dataclass
from importlib.metadata import entry_points
from pathlib import Path
from typing import Callable

import numpy as np

PER = ("tensor", "part", "model")
_FIRST = {"w": "tensor", "weights": "tensor", "tensor": "tensor", "array": "tensor", "m": "model", "model": "model"}


@dataclass
class Fn:
    name: str
    fn: Callable
    per: str
    doc: str
    params: dict            # name -> {type, default, help}
    source: str             # module or file it came from
    sha256: str = ""

    def describe(self) -> dict:
        return {"name": self.name, "per": self.per, "doc": self.doc, "params": self.params, "source": self.source,
                "sha256": self.sha256}


_REG: dict[str, Fn] = {}
_loaded: set[str] = set()
_builtins_loaded = False


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


def function(name: str | None = None, per: str | None = None, doc: str = ""):
    """Register fn under `name` (default: the Python name with - for _)."""
    def deco(fn: Callable) -> Callable:
        first = next(iter(inspect.signature(fn).parameters), "")
        kind = per or _FIRST.get(first, "part")
        if kind not in PER:
            raise ValueError(f"per must be one of {PER}")
        n = name or fn.__name__.replace("_", "-")
        mod = getattr(fn, "__module__", "")
        prev = _REG.get(n)
        if prev is not None and prev.fn is not fn and prev.source != mod:
            raise ValueError(f"function {n!r} already registered by {prev.source}")
        _REG[n] = Fn(n, fn, kind, (doc or inspect.getdoc(fn) or "").strip(), _params(fn, True), mod)
        return fn
    return deco


def _builtins() -> None:
    global _builtins_loaded
    if not _builtins_loaded:
        _builtins_loaded = True
        importlib.import_module("blackhole_dev.builtin_functions")
        importlib.import_module("blackhole_dev.hexops")
        for ep in entry_points(group="blackhole.functions"):
            ep.load()


def load(spec: str, base: Path | None = None) -> str:
    """Import a module name or a .py file so its @function decorators register. Returns the
    file's sha256 (what a schema pins)."""
    _builtins()
    p = Path(spec).expanduser()
    if base is not None and not p.is_absolute():
        p = base / p
    if spec.endswith(".py") or p.is_file():
        if not p.is_file():
            raise FileNotFoundError(f"no function file {spec}")
        data = p.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        key = f"file:{p.resolve()}:{sha}"
        if key not in _loaded:
            mname = f"blackhole_fn_{sha[:12]}"
            s = importlib.util.spec_from_file_location(mname, p)
            mod = importlib.util.module_from_spec(s)
            sys.modules[mname] = mod
            s.loader.exec_module(mod)
            for f in _REG.values():
                if f.source == mname:
                    f.source, f.sha256 = str(p), sha
            _loaded.add(key)
        return sha
    mod = importlib.import_module(spec)
    f = getattr(mod, "__file__", None)
    sha = hashlib.sha256(Path(f).read_bytes()).hexdigest() if f else ""
    for fn in _REG.values():
        if fn.source == spec and not fn.sha256:
            fn.sha256 = sha
    return sha


def registry() -> dict[str, Fn]:
    _builtins()
    return dict(sorted(_REG.items()))


def get(name: str) -> Fn:
    _builtins()
    if name not in _REG:
        near = [n for n in _REG if name.split("-")[0] in n][:5]
        raise KeyError(f"no function {name!r}" + (f"; did you mean {', '.join(near)}?" if near else
                                                  "; `blackhole fn list` shows them"))
    return _REG[name]


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
