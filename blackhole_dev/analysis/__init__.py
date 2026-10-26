"""Analysis: plots and stats over a model, as named scripts the app runs and draws.

    from blackhole_dev.analysis import analysis

    @analysis("kurtosis-by-layer", title="Kurtosis by layer", needs="weights")
    def run(r, m, sample: int = 128):
        "Weight kurtosis of every layer's experts (heavy tails quantize badly)."
        ks = [r.sampled(L.moe.experts if L.moe else [L.mlp], sample)["kurtosis"] for L in m.layers]
        r.line("Kurtosis by layer", x=list(range(len(ks))), series={"experts": ks}, xlabel="layer")
        r.tiles([("Worst layer", int(max(range(len(ks)), key=ks.__getitem__)))])

`r` is a Report: it collects blocks (tiles, line, bar, hist, heatmap, scatter, table, text,
figure) that the app draws as charts; `m` is the model open in the app (a blackhole_dev Model,
headers only, weights read on demand). Params are the keyword arguments after (r, m), with
defaults and type hints, so the app can draw a form for them.

needs:  "headers"  only shapes, dtypes and the config (free)
        "weights"  reads weights; `cost(m, **params)` returns the bytes it will read
        "none"     no model (job-results reads a job folder)

Where analyses come from, and which one wins (same rule as functions):
  0 builtin    blackhole_dev/analysis_src/*.py, one readable file per analysis
  1 workspace  <workspace>/analysis/*.py (the app's workspace, ~/BlackHole-Dev/analysis)
A workspace analysis with a built-in's name replaces it; `fork(name)` copies the built-in's
file there to start from. A file with no @analysis is a plain script: it runs top to bottom
with `r`, `m`, `params` and `open` (blackhole_dev.open) in scope.

Reads are metered (blackhole_dev.sources.METERS): run(..., budget=bytes) stops an analysis
with ReadBudgetExceeded BEFORE the read that would pass the budget, so the app can ask the
user once and run it again with a bigger budget.
"""

from __future__ import annotations

import base64
import inspect
import io
import math
import re
import time
import typing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from blackhole_dev import sources

NEEDS = ("headers", "weights", "none")
BUILTIN, WORKSPACE = 0, 1
BUILTIN_DIR = Path(__file__).resolve().parent.parent / "analysis_src"


class ReadBudgetExceeded(RuntimeError):
    def __init__(self, used: int, wanted: int, budget: int):
        super().__init__(f"this analysis wants to read more than the {_gb(budget)} allowed "
                         f"({_gb(used)} read so far, the next read is {_gb(wanted)})")
        self.used, self.wanted, self.budget = used, wanted, budget


class ReadMeter:
    """Counts the bytes File sources hand out while active; raises before passing `budget`."""

    def __init__(self, budget: int | None = None):
        self.budget, self.bytes = budget, 0

    def add(self, n: int) -> None:
        if self.budget is not None and self.bytes + n > self.budget:
            raise ReadBudgetExceeded(self.bytes, n, self.budget)
        self.bytes += n

    def __enter__(self) -> "ReadMeter":
        sources.METERS.append(self)
        return self

    def __exit__(self, *exc) -> None:
        sources.METERS.remove(self)


# --------------------------------------------------------------------------- the report


def _clean(v):
    """JSON-safe numbers: numpy scalars to Python, NaN / inf to None."""
    if isinstance(v, (np.generic,)):
        v = v.item()
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, np.ndarray):
        return [_clean(x) for x in v.tolist()]
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    return v


class Report:
    """What an analysis hands the app: an ordered list of blocks. Every chart block also
    carries its numbers, so the app can show it as a table too."""

    def __init__(self, model=None):
        self.model = model
        self.blocks: list[dict] = []
        self.heading: str | None = None
        self.metrics: dict = {}

    def _add(self, kind: str, **kw) -> dict:
        b = {"kind": kind, **{k: _clean(v) for k, v in kw.items() if v is not None}}
        self.blocks.append(b)
        return b

    def title(self, text: str) -> None:
        self.heading = str(text)

    def text(self, text: str) -> None:
        """A paragraph (plain text; `code` in backticks is kept)."""
        self._add("text", text=str(text))

    def tiles(self, items: Iterable, title: str | None = None) -> None:
        """Stat tiles: (label, value) or (label, value, note) or (label, value, note, tone)
        with tone ok / warn / bad. Numbers stay numbers; the app formats them."""
        rows = []
        for it in items:
            it = tuple(it)
            row = {"label": str(it[0]), "value": it[1]}
            if len(it) > 2 and it[2] is not None:
                row["note"] = str(it[2])
            if len(it) > 3 and it[3]:
                row["tone"] = str(it[3])
            rows.append(row)
            if isinstance(it[1], (int, float, np.generic)):
                self.metrics[str(it[0])] = it[1]
        self._add("tiles", title=title, items=rows)

    def line(self, title: str, x: Iterable, series: dict, xlabel: str = "", ylabel: str = "",
             logy: bool = False, note: str | None = None) -> None:
        """One or more lines over a shared x (e.g. a metric per layer, one line per part)."""
        self._add("line", title=title, x=list(x), series=[{"name": str(k), "values": list(v)} for k, v in series.items()],
                  xlabel=xlabel, ylabel=ylabel, logy=logy or None, note=note)

    def bar(self, title: str, labels: Iterable, series: dict, xlabel: str = "", ylabel: str = "",
            horizontal: bool = False, note: str | None = None) -> None:
        """Bars per label; several series are grouped side by side (never stacked)."""
        self._add("bar", title=title, labels=[str(x) for x in labels],
                  series=[{"name": str(k), "values": list(v)} for k, v in series.items()],
                  xlabel=xlabel, ylabel=ylabel, horizontal=horizontal or None, note=note)

    def hist(self, title: str, edges: Iterable, counts: Iterable, xlabel: str = "", logy: bool = True,
             note: str | None = None) -> None:
        """A histogram from numpy.histogram's (counts, edges)."""
        self._add("hist", title=title, edges=list(edges), counts=list(counts), xlabel=xlabel, logy=logy or None,
                  note=note)

    def heatmap(self, title: str, rows: Iterable, cols: Iterable, values, label: str = "",
                xlabel: str = "", ylabel: str = "", note: str | None = None) -> None:
        """A grid (e.g. layer x expert); None cells are drawn empty."""
        vals = [[_clean(float(v)) if v is not None else None for v in row] for row in values]
        self._add("heatmap", title=title, rows=[str(x) for x in rows], cols=[str(x) for x in cols], values=vals,
                  label=label, xlabel=xlabel, ylabel=ylabel, note=note)

    def scatter(self, title: str, series: dict, xlabel: str = "", ylabel: str = "", labels: dict | None = None,
                note: str | None = None) -> None:
        """Points: series = {name: (xs, ys)}; labels = {name: [point label, ...]} for tooltips."""
        out = []
        for k, (xs, ys) in series.items():
            s = {"name": str(k), "x": list(xs), "y": list(ys)}
            if labels and k in labels:
                s["labels"] = [str(t) for t in labels[k]]
            out.append(s)
        self._add("scatter", title=title, series=out, xlabel=xlabel, ylabel=ylabel, note=note)

    def table(self, title: str | None, columns: list[str], rows: Iterable[Iterable]) -> None:
        self._add("table", title=title, columns=[str(c) for c in columns], rows=[list(r) for r in rows])

    def figure(self, fig, title: str | None = None) -> None:
        """A matplotlib figure, as a PNG (for anything the built-in charts do not draw)."""
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=144, bbox_inches="tight", facecolor=fig.get_facecolor())
        self._add("image", title=title, png=base64.b64encode(buf.getvalue()).decode())

    # helpers analyses share
    def sampled(self, parts, rows: int = 256) -> dict:
        from blackhole_dev.analysis.lib import sampled_stats
        return sampled_stats(parts, rows)

    def to_dict(self) -> dict:
        return {"title": self.heading, "blocks": self.blocks, "metrics": _clean(self.metrics)}


# --------------------------------------------------------------------------- the registry


@dataclass
class Analysis:
    name: str
    fn: Callable
    title: str
    doc: str
    needs: str
    params: dict
    cost: Callable | None
    source: str
    layer: int = BUILTIN
    group: str = "model"
    meta: dict = field(default_factory=dict)

    def row(self) -> dict:
        return {"name": self.name, "title": self.title, "doc": self.doc, "needs": self.needs, "params": self.params,
                "origin": "builtin" if self.layer == BUILTIN else ("override" if _builtin_has(self.name) else "user"),
                "path": self.source, "group": self.group}


_DEFS: dict[str, dict[int, Analysis]] = {}
_layer_now: list[int] = []
_file_now: list[str] = []
_workspace: list[Path] = []
_problems: list[dict] = []
_loaded_builtins = False


def _params(fn: Callable) -> dict:
    sig = inspect.signature(fn)
    try:
        hints = typing.get_type_hints(fn)
    except Exception:  # noqa: BLE001
        hints = {}
    out = {}
    for p in list(sig.parameters.values())[2:]:
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        t = hints.get(p.name)
        tn = getattr(t, "__name__", None) or (str(t) if t is not None else None)
        if tn is None and p.default is not inspect.Parameter.empty and p.default is not None:
            tn = type(p.default).__name__
        out[p.name] = {"type": tn or "str", "default": None if p.default is inspect.Parameter.empty else p.default,
                       "required": p.default is inspect.Parameter.empty}
    return out


def analysis(name: str, title: str = "", needs: str = "weights", cost: Callable | None = None, group: str = "model"):
    """Register fn(r: Report, m: Model, **params) as an analysis named `name`."""
    if needs not in NEEDS:
        raise ValueError(f"needs must be one of {NEEDS}")

    def deco(fn: Callable) -> Callable:
        layer = _layer_now[-1] if _layer_now else WORKSPACE
        src = _file_now[-1] if _file_now else (inspect.getsourcefile(fn) or "")
        doc = inspect.getdoc(fn) or ""
        a = Analysis(name, fn, title or name, doc, needs, _params(fn), cost, src, layer, group)
        prev = _DEFS.setdefault(name, {}).get(layer)
        if prev is not None and prev.source != src:
            raise ValueError(f"analysis {name!r} is defined twice: {prev.source} and {src}")
        _DEFS[name][layer] = a
        fn.analysis = a
        return fn
    return deco


def _exec_file(path: Path, layer: int) -> list[str]:
    import importlib.util
    before = {n: dict(d) for n, d in _DEFS.items()}
    _layer_now.append(layer)
    _file_now.append(str(path))
    try:
        mod = f"blackhole_dev_analysis_{re.sub(r'[^A-Za-z0-9_]', '_', path.stem)}_{layer}"
        spec = importlib.util.spec_from_file_location(mod, path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
    finally:
        _layer_now.pop()
        _file_now.pop()
    return [n for n, d in _DEFS.items() if d != before.get(n)]


def _load_builtins() -> None:
    global _loaded_builtins
    if _loaded_builtins:
        return
    _loaded_builtins = True
    for f in sorted(BUILTIN_DIR.glob("*.py")):
        if not f.name.startswith("_"):
            _exec_file(f, BUILTIN)


def _builtin_has(name: str) -> bool:
    return BUILTIN in _DEFS.get(name, {})


def set_workspace(root: str | Path | None) -> Path | None:
    _workspace.clear()
    if root:
        _workspace.append(Path(root).expanduser())
    return analysis_dir()


def analysis_dir() -> Path | None:
    return _workspace[0] / "analysis" if _workspace else None


def refresh() -> list[dict]:
    """(Re)load the workspace analysis folder; broken files are reported, not raised."""
    _load_builtins()
    for d in _DEFS.values():
        d.pop(WORKSPACE, None)
    _problems.clear()
    d = analysis_dir()
    if d and d.is_dir():
        for f in sorted(d.glob("*.py")):
            if f.name.startswith("_"):
                continue
            try:
                _exec_file(f, WORKSPACE)
            except Exception as e:  # noqa: BLE001
                _problems.append({"file": str(f), "error": f"{type(e).__name__}: {e}"})
    return list(_problems)


def registry() -> dict[str, Analysis]:
    _load_builtins()
    return {n: d[max(d)] for n, d in sorted(_DEFS.items()) if d}


def get(name: str) -> Analysis:
    reg = registry()
    if name not in reg:
        raise KeyError(f"no analysis named {name!r}; one of {', '.join(reg)}")
    return reg[name]


def rows() -> list[dict]:
    return [a.row() for a in registry().values()]


def source(name: str) -> dict:
    a = get(name)
    return {"name": name, "path": a.source, "text": Path(a.source).read_text(), "readonly": a.layer == BUILTIN}


def fork(name: str, new_name: str | None = None, dest: str | Path | None = None, overwrite: bool = False) -> dict:
    """Copy the winning definition's file into the workspace analysis folder. Keeping the name
    makes the copy replace the built-in; new_name renames the analysis in the copy."""
    a = get(name)
    d = Path(dest).expanduser() if dest else analysis_dir()
    if d is None:
        raise ValueError("no workspace set: give dest")
    d.mkdir(parents=True, exist_ok=True)
    text = Path(a.source).read_text()
    stem = re.sub(r"[^A-Za-z0-9_]", "_", new_name or name)
    if new_name:
        text = re.sub(r'@analysis\(\s*"' + re.escape(name) + '"', f'@analysis("{new_name}"', text, count=1)
    dst = d / f"{stem}.py"
    if dst.exists() and not overwrite:
        raise FileExistsError(f"{dst} exists (overwrite=True replaces it)")
    dst.write_text(text)
    refresh()
    return {"name": new_name or name, "path": str(dst), "overrides": not new_name and a.layer == BUILTIN}


# --------------------------------------------------------------------------- running


def estimate(a: Analysis, m, params: dict) -> dict:
    """What a run will read, before it runs: bytes (None when the analysis cannot tell) and
    whether the reads are downloads (a Hub model read in place)."""
    remote = _remote(m)
    if a.needs != "weights" or m is None:
        return {"bytes": 0, "known": True, "remote": False, "seconds": 0.0}
    if a.cost is None:
        return {"bytes": None, "known": False, "remote": remote, "seconds": None}
    n = int(a.cost(m, **_with_defaults(a, params)))
    return {"bytes": n, "known": True, "remote": remote, "seconds": n / (60e6 if remote else 1.2e9)}


def _remote(m) -> bool:
    if m is None:
        return False
    for s in list(m._t.values())[:4]:
        while isinstance(s, sources.Overlay):
            s = s.base
        if isinstance(s, sources.File):
            return bool(s.entry.blob.remote)
    return False


def _with_defaults(a: Analysis, params: dict) -> dict:
    out = {}
    for k, spec in a.params.items():
        if k in params and params[k] not in (None, ""):
            out[k] = _coerce(params[k], spec["type"])
        elif not spec["required"]:
            out[k] = spec["default"]
    unknown = sorted(set(params) - set(a.params))
    if unknown:
        raise KeyError(f"{a.name} has no param {', '.join(unknown)}")
    return out


def _coerce(v, t: str):
    if t == "int":
        return int(v)
    if t == "float":
        return float(v)
    if t == "bool":
        return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
    return v


def run(name_or_fn, m=None, params: dict | None = None, budget: int | None = None) -> dict:
    """Run an analysis (a name, an Analysis, or a decorated function) on model m."""
    a = name_or_fn if isinstance(name_or_fn, Analysis) else \
        getattr(name_or_fn, "analysis", None) or get(str(name_or_fn))
    if a.needs != "none" and m is None:
        raise ValueError(f"{a.name} needs a model: open one first")
    kw = _with_defaults(a, params or {})
    r = Report(m)
    t0 = time.time()
    with ReadMeter(budget) as meter:
        a.fn(r, m, **kw)
    out = r.to_dict()
    out["title"] = out["title"] or a.title
    out.update(name=a.name, params=_clean(kw), reads=meter.bytes, seconds=round(time.time() - t0, 3),
               model=getattr(m, "id", None))
    return out


def run_file(path: str | Path, m=None, params: dict | None = None, budget: int | None = None,
             name: str | None = None, text: str | None = None) -> dict:
    """Run a script file: its @analysis (the one named `name`, else the first), or, when it
    has none, the file itself top to bottom with r, m, params and open in scope."""
    import blackhole_dev
    path = Path(path).expanduser()
    code = text if text is not None else path.read_text()
    before = {n: dict(d) for n, d in _DEFS.items()}
    r = Report(m)
    g = {"__name__": "__analysis__", "__file__": str(path), "r": r, "m": m, "params": dict(params or {}),
         "open": blackhole_dev.open, "np": np}
    _layer_now.append(WORKSPACE + 1)          # the open file wins over everything while it runs
    _file_now.append(str(path))
    t0 = time.time()
    try:
        with ReadMeter(budget) as meter:
            exec(compile(code, str(path), "exec"), g)        # noqa: S102  the user's own script
            new = [d[WORKSPACE + 1] for n, d in _DEFS.items() if WORKSPACE + 1 in d and d != before.get(n)]
            if new:
                pick = next((x for x in new if x.name == name), new[0])
                for d in _DEFS.values():
                    d.pop(WORKSPACE + 1, None)
                out = run(pick, m, params)            # this meter keeps counting (and holding the budget)
                out["reads"] = meter.bytes
                return out
    finally:
        _layer_now.pop()
        _file_now.pop()
        for d in _DEFS.values():
            d.pop(WORKSPACE + 1, None)
    out = r.to_dict()
    out.update(title=out["title"] or path.stem, name=path.stem, params=_clean(params or {}), reads=meter.bytes,
               seconds=round(time.time() - t0, 3), model=getattr(m, "id", None))
    return out


def _gb(n: int | float) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e8 else f"{n / 1e6:.1f} MB"


__all__ = ["analysis", "Report", "ReadMeter", "ReadBudgetExceeded", "run", "run_file", "estimate", "registry", "get",
           "rows", "source", "fork", "refresh", "set_workspace", "analysis_dir"]
