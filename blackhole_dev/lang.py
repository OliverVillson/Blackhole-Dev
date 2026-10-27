"""Language support for recipe files: what the app's editor completes, explains and checks.

    catalog()                       everything a recipe can name, as JSON: the recipe API with
                                    signatures and docs, pipeline stages and their params
                                    (blackhole_pipeline.DEFAULTS with the comments next to them),
                                    every function with its args, catalog ops, gate ops, input
                                    types, query syntax, devices, architectures and model ids
    complete(text, line, col)       Python completions from Jedi (generic Python, numpy, ...)
    signatures(text, line, col)     the call around the cursor
    hover(text, line, col)          the docs of the name under the cursor

The editor answers recipe-specific questions from the catalog on its own (no round trip per
keystroke) and asks Jedi for everything else. Jedi is optional: without it the last three
return nothing and the editor falls back to the catalog and the words in open files.
Everything here runs offline. Lines are 1-based, columns 0-based (Jedi's convention).
"""

from __future__ import annotations

import inspect
import io
import re
import threading
import tokenize
from pathlib import Path

from blackhole_dev.recipe import core

FIELDS = {
    "title": "Display name of the recipe.",
    "description": "What the recipe does, for people browsing recipes.",
    "author": "Who made it (credit BlackHole-Harness for built-ins).",
    "license": "SPDX licence id, e.g. Apache-2.0.",
    "tags": "List of short tags: mac, code, moe, ...",
    "parent": "id@version of the recipe this one was forked from.",
    "base_compat": "Which base models it was tested on.",
    "task": "What the result is for (code, chat, ...).",
    "base": "The Hugging Face id of the base model, e.g. Qwen/Qwen3.6-35B-A3B.",
    "data": "Calibration / training data table.",
    "purpose": "Free-text purpose that steers calibration data.",
    "outputs": "What the run produces (formats, files).",
    "targets": 'Models it runs on: {"architectures": ["moe", "hybrid"]}.',
    "footprint": "Expected size and memory of the result.",
    "data_policy": "Where data may come from and what may leave the machine.",
    "meta": 'App/pipeline metadata kept out of the schema: {"target": "mac16", "quant": "mlx-3bit"}.',
}
INPUT_SPEC = {
    "default": "Value used when the user sets nothing.",
    "required": "The user must set it (simple mode asks only required, non-advanced inputs).",
    "help": "One line shown next to the knob.",
    "min": "Smallest allowed number.",
    "max": "Largest allowed number.",
    "choices": "Allowed values of an enum input.",
    "advanced": "Hide the knob in simple mode.",
}
STEP_OPTS = {
    "needs": "Explicit inputs: {\"model\": other.model}.",
    "gates": "Stop (or warn) unless metrics hold: [gate(\"kl\", \"<=\", 0.1)].",
    "when": "Run only when this holds (a bool or a ${...} reference).",
    "always": "Run even after an earlier stage failed a gate.",
    "id": "The stage id other steps use to refer to it (default: from the kind or function name).",
}
QUERY = {
    "top": ["layers", "embed", "head", "norm", "mtp", "experts"],
    "children": {
        "layers": ["attn", "mixer", "mlp", "moe", "norms"],
        "moe": ["router", "experts", "shared"],
        "attn": ["heads"],
    },
    "filters": {"index": "position in its list", "id": "the part's id", "layer": "layer index",
                "kind": "attention, mixer, moe, mlp, ...", "score": "REAP saliency",
                "freq": "routing frequency", "rank": "rank by score, 0..1 (0 = lowest)",
                "params": "parameter count"},
    "kinds": ["attention", "mixer", "moe", "mlp"],
    "examples": {
        "layers[0:4].attn": "attention of the first four layers",
        "layers[-1]": "the last layer",
        "layers[kind==mixer]": "every linear-attention / Mamba layer",
        "layers[*].moe.experts[rank<0.25]": "the bottom quarter of every layer's experts by REAP score",
        "experts[score<0.01 & layer>=10]": "low-score experts from layer 10 on",
        "layers[3].attn.heads[0,5,7]": "three heads of layer 3",
        "moe.router": "every router",
        "moe.shared": "every shared expert",
    },
}
ARCHITECTURES = ["moe", "dense", "hybrid"]
GATE_METRICS = ["kl", "ppl", "lcb", "agreement", "size_gb", "experts_left", "tok_s"]


def _sig(fn, drop_self: bool = True) -> dict:
    s = inspect.signature(fn)
    params = []
    for p in s.parameters.values():
        if drop_self and p.name == "self":
            continue
        if p.kind == p.VAR_KEYWORD:
            params.append({"name": "**" + p.name, "label": "**" + p.name})
            continue
        d = None if p.default is p.empty else p.default
        ann = p.annotation if isinstance(p.annotation, str) else getattr(p.annotation, "__name__", "")
        label = p.name + (f": {ann}" if ann and ann != "_empty" else "") + ("" if p.default is p.empty else f"={d!r}")
        params.append({"name": p.name, "label": label, "default": _json(d), "required": p.default is p.empty,
                       "kwOnly": p.kind == p.KEYWORD_ONLY})
    return {"params": params, "doc": inspect.getdoc(fn) or ""}


def _json(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_json(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _json(x) for k, x in v.items()}
    return repr(v)


def _comments(path: str | None, name: str) -> dict[str, str]:
    """The `# ...` comment after each key of the dict literal `name = {...}` in a module."""
    if not path or not Path(path).is_file():
        return {}
    out: dict[str, str] = {}
    src = Path(path).read_text()
    m = re.search(rf"^{name}\s*=\s*\{{", src, re.M)
    if not m:
        return out
    depth, key, line_key = 0, None, {}
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src[m.end() - 1:]).readline))
    except (tokenize.TokenError, IndentationError):
        return out
    for t in toks:
        if t.type == tokenize.OP and t.string in "{[(":
            depth += 1
        elif t.type == tokenize.OP and t.string in "}])":
            depth -= 1
            if depth == 0:
                break
        elif depth == 1 and t.type == tokenize.STRING and key is None:
            key = t.string.strip("'\"")
            line_key[t.start[0]] = key
        elif depth == 1 and t.type == tokenize.OP and t.string == ",":
            key = None
        elif t.type == tokenize.COMMENT and t.start[0] in line_key:
            out[line_key[t.start[0]]] = t.string.lstrip("# ").strip()
    return out


def _pipeline() -> dict:
    from blackhole_dev.recipe import pipeline as pl
    params: dict[str, dict] = {}
    if pl.DEFAULTS is not None:
        import blackhole_pipeline
        docs = _comments(getattr(blackhole_pipeline, "__file__", None), "DEFAULTS")
        for k, v in pl.DEFAULTS.items():
            params[k] = {"default": _json(v), "doc": docs.get(k, "")}
        params.setdefault("purpose", {"default": "", "doc": "Free-text purpose that steers calibration data."})
        try:
            from dataclasses import MISSING, fields

            from reaper_pipeline.job import Config
            for f in fields(Config):
                if f.name not in params:
                    d = f.default if f.default is not MISSING else None
                    params[f.name] = {"default": _json(d), "doc": "REAP (REAPer) setting", "stage": "reap"}
        except ImportError:
            for k in ("calib", "max_seq", "teacher_backend", "answer_max_tokens"):
                params.setdefault(k, {"default": None, "doc": "REAP (REAPer) setting", "stage": "reap"})
    for k, p in params.items():
        if "stage" not in p:
            head = k.split("_")[0]
            p["stage"] = {"prune": "reap", "calib": "reap", "layer": "gptq"}.get(head, head)
    stages = {
        "reap": "Score experts on calibration text (REAP) and drop the lowest `prune` share.",
        "heal": "Distil the pruned model back toward the original (shortest verified traces, on-policy rounds).",
        "gptq": "GPTQ int4 of the routed experts (Hessians from calibration text).",
        "reaq": "REAQ: per-expert bit widths from REAP rank at a fixed average.",
        "mlx": "Export to MLX for Apple silicon (HEX experts, attention GPTQ, head/embed bits).",
        "qheal": "Heal again around the quantized model.",
        "bench": "LiveCodeBench v6 (and others) on the original and the result.",
        "quant": "Quantize for another runtime.",
        "package": "Pack the result for download.",
    }
    return {"steps": [{"name": s, "doc": stages.get(s, "")} for s in pl.PIPELINE_STEPS], "params": params,
            "checked": pl.DEFAULTS is not None}


def _functions() -> list[dict]:
    try:
        from blackhole_dev import functions as fns
        if hasattr(fns, "refresh"):
            fns.refresh()
        rows = fns.rows()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in rows:
        params = {k: {"type": v.get("type", ""), "default": _json(v.get("default")), "required": bool(v.get("required"))}
                  for k, v in (r.get("params") or {}).items()}
        out.append({"name": r["name"], "per": r.get("per", ""), "doc": r.get("doc", ""), "params": params,
                    "origin": "builtin" if r.get("builtin") else ("override" if r.get("overrides") else "user")})
    return out


def _ops() -> list[dict]:
    try:
        from blackhole.core import ops
        out = []
        for cls in ops.catalog():
            d = ops.describe(cls)
            out.append({"name": cls.name, "major": cls.major, "doc": d["doc"],
                        "params": {k: {"type": v["type"], "default": _json(v["default"]), "help": v["help"]}
                                   for k, v in d["params"].items()}})
        return out
    except Exception:  # noqa: BLE001
        return []


def _models(dirs: list[str] | None = None) -> list[dict]:
    out, seen = [], set()
    try:
        from blackhole.market.models import CATALOG
        for m in CATALOG:
            out.append({"id": m.hf_id, "detail": f"{m.arch} · {m.total_b:g}B total, {m.active_b:g}B active"})
            seen.add(m.hf_id)
    except Exception:  # noqa: BLE001
        pass
    for extra in ("Qwen/Qwen3.6-35B-A3B", "Qwen/Qwen3-Coder-30B-A3B-Instruct", "Qwen/Qwen3-Next-80B-A3B-Instruct"):
        if extra not in seen:
            out.append({"id": extra, "detail": "moe"})
            seen.add(extra)
    try:
        from blackhole_dev.fork import models
        for m in models(dirs or []):
            mid = m.get("path")
            if mid and mid not in seen:
                out.append({"id": mid, "detail": f"local model · {m.get('name') or Path(mid).name}"})
                seen.add(mid)
    except Exception:  # noqa: BLE001
        pass
    return out


def _devices() -> list[dict]:
    try:
        from blackhole_dev.recipe.plan import devices
        return devices()
    except Exception:  # noqa: BLE001
        return []


def catalog(models_dirs: list[str] | None = None) -> dict:
    from blackhole.core import schema as sch
    R = core.Recipe
    ctor = _sig(R.__init__)
    ctor["doc"] = inspect.getdoc(R) or ""
    methods = {n: _sig(getattr(R, n)) for n in ("input", "step", "fn", "edit", "eval", "to_raw", "schema", "step_at")}
    return {
        "recipe": {"ctor": ctor, "methods": methods, "fields": FIELDS,
                   "attrs": {"inputs": "References to inputs: recipe.inputs.prune",
                             "base": "The base model: recipe.base.model (its directory), recipe.base.id",
                             "hw": "Detected hardware: recipe.hw.gpu_mem_gb, recipe.hw.gpu_count, ...",
                             "steps": "The steps added so far", "meta": "App/pipeline metadata"}},
        "gate": _sig(core.gate, drop_self=False),
        "stepOpts": STEP_OPTS,
        "inputSpec": INPUT_SPEC,
        "inputTypes": list(sch.INPUT_TYPES),
        "gateOps": sorted(sch.GATE_OPS),
        "gateMetrics": GATE_METRICS,
        "pipeline": _pipeline(),
        "functions": _functions(),
        "ops": _ops(),
        "query": QUERY,
        "architectures": ARCHITECTURES,
        "devices": _devices(),
        "models": _models(models_dirs),
        "jedi": _jedi() is not None,
    }


# --------------------------------------------------------------------- Jedi
_JEDI_LOCK = threading.Lock()


def _jedi():
    try:
        import jedi
        return jedi
    except ImportError:
        return None


def _script(text: str, path: str | None):
    jedi = _jedi()
    if jedi is None:
        return None
    return jedi.Script(text, path=path or None)


_KIND = {"module": "module", "class": "class", "instance": "variable", "function": "function", "param": "variable",
         "path": "file", "keyword": "keyword", "property": "property", "statement": "variable"}


def complete(text: str, line: int, col: int, path: str | None = None, limit: int = 150) -> dict:
    with _JEDI_LOCK:
        s = _script(text, path)
        if s is None:
            return {"items": [], "jedi": False}
        try:
            comps = s.complete(line, col)
        except Exception:  # noqa: BLE001
            return {"items": [], "jedi": True}
        items = []
        for c in comps[:limit]:
            if c.name.startswith("__") and not c.name.endswith("__"):
                continue
            items.append({"label": c.name, "kind": _KIND.get(c.type, "text"), "detail": c.description or c.type})
        return {"items": items, "jedi": True}


def signatures(text: str, line: int, col: int, path: str | None = None) -> dict:
    with _JEDI_LOCK:
        s = _script(text, path)
        if s is None:
            return {"signatures": []}
        try:
            sigs = s.get_signatures(line, col)
        except Exception:  # noqa: BLE001
            return {"signatures": []}
        return {"signatures": [{"label": sg.to_string(), "doc": _short_doc(sg.docstring(raw=True)),
                                "params": [p.to_string() for p in sg.params], "active": sg.index}
                               for sg in sigs[:3]]}


def hover(text: str, line: int, col: int, path: str | None = None) -> dict:
    with _JEDI_LOCK:
        s = _script(text, path)
        if s is None:
            return {"contents": []}
        try:
            names = s.help(line, col) or s.infer(line, col)
        except Exception:  # noqa: BLE001
            return {"contents": []}
        out = []
        for n in names[:2]:
            sig = ""
            try:
                sigs = n.get_signatures()
                sig = sigs[0].to_string() if sigs else ""
            except Exception:  # noqa: BLE001
                pass
            doc = _short_doc(n.docstring(raw=True))
            head = sig or f"{n.type} {n.full_name or n.name}"
            if head or doc:
                out.append({"signature": head, "doc": doc})
        return {"contents": out}


def _short_doc(doc: str, limit: int = 1500) -> str:
    doc = (doc or "").strip()
    return doc if len(doc) <= limit else doc[:limit].rsplit("\n", 1)[0] + "\n…"


def warm() -> None:
    """Load Jedi and the recipe API once so the first completion is quick."""
    try:
        complete("from blackhole_dev.recipe import Recipe\nRecipe('a/b').", 2, 15)
    except Exception:  # noqa: BLE001
        pass
