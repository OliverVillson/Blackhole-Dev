"""Write a recipe file from a blackhole/v1 schema (TOML or JSON) or from a TUI catalog preset.

TOML -> Python is lossless: loading the generated file and calling `to_raw()` gives the
dict the TOML parsed to (`from_raw` checks this before returning). A catalog preset
(blackhole_tui.catalog.SCHEMAS: qwen-mac-qhex, mac-qhex, reaq-codebook, ...) becomes
pipeline.* steps that give the pipeline the same job config and stage list.
"""

from __future__ import annotations

import json
import keyword
import re
from pathlib import Path
from typing import Any

from blackhole_dev.recipe.core import RecipeError

REF = re.compile(r"^\$\{([A-Za-z_][\w.-]*)\}$")
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
TOP_ORDER = ("title", "description", "author", "license", "tags", "parent", "base_compat", "task", "base", "data",
             "purpose", "outputs", "targets", "footprint", "data_policy")
STEP_KW = ("needs", "gates", "when", "always")
TAKEN = {"recipe", "Recipe", "gate", "step"}


def _q(s: str) -> str:
    """A double-quoted Python string literal (JSON's escapes are a subset of Python's)."""
    return json.dumps(s, ensure_ascii=False)


def _ident_ok(name: str, used: set[str]) -> bool:
    return bool(IDENT.match(name)) and not keyword.iskeyword(name) and name not in used and name not in TAKEN


class _Writer:
    def __init__(self):
        self.vars: dict[str, str] = {}          # ref head ("inputs.prune" or a stage id) -> variable name
        self.used: set[str] = set()

    def var_for(self, key: str, name: str) -> str | None:
        name = re.sub(r"[^A-Za-z0-9_]", "_", name)
        if name and name[0].isdigit():
            name = "_" + name
        if not _ident_ok(name, self.used):
            for n in range(2, 99):
                if _ident_ok(f"{name}_{n}", self.used):
                    name = f"{name}_{n}"
                    break
            else:
                return None
        self.used.add(name)
        self.vars[key] = name
        return name

    def value(self, v: Any, indent: int = 4) -> str:
        if isinstance(v, str):
            m = REF.match(v)
            if m:
                parts = m.group(1).split(".")
                if parts[0] == "inputs" and len(parts) == 2 and f"inputs.{parts[1]}" in self.vars:
                    return self.vars[f"inputs.{parts[1]}"]
                if parts[0] in self.vars and len(parts) >= 2 and all(IDENT.match(p) and not keyword.iskeyword(p)
                                                                     for p in parts[1:]):
                    return ".".join([self.vars[parts[0]], *parts[1:]])
                if parts[0] in ("base", "hw") and len(parts) >= 2 and all(IDENT.match(p) for p in parts[1:]):
                    return "recipe." + ".".join(parts)
            q = _q(v)
            if len(q) + indent + 20 > 110 and " " in v:      # long prose: implicit concatenation, one chunk per line
                width = max(40, 100 - indent)
                chunks, cur = [], ""
                for word in re.split(r"(?<= )", v):
                    if cur and len(cur) + len(word) > width:
                        chunks.append(cur)
                        cur = ""
                    cur += word
                chunks.append(cur)
                pad = " " * (indent + 4)
                return "(\n" + "".join(f"{pad}{_q(c)}\n" for c in chunks) + " " * indent + ")"
            return q
        if isinstance(v, bool) or v is None or isinstance(v, (int, float)):
            return repr(v)
        if isinstance(v, list):
            items = [self.value(x, indent + 4) for x in v]
            one = "[" + ", ".join(items) + "]"
            if len(one) + indent <= 110 and "\n" not in one:
                return one
            pad = " " * (indent + 4)
            return "[\n" + "".join(f"{pad}{x},\n" for x in items) + " " * indent + "]"
        if isinstance(v, dict):
            items = [f"{_q(str(k))}: {self.value(x, indent + 4)}" for k, x in v.items()]
            one = "{" + ", ".join(items) + "}"
            if len(one) + indent <= 110 and "\n" not in one:
                return one
            pad = " " * (indent + 4)
            return "{\n" + "".join(f"{pad}{x},\n" for x in items) + " " * indent + "}"
        return repr(v)  # datetime and friends: repr is valid Python for the common ones

    def kwargs(self, d: dict, indent: int) -> list[str]:
        out, odd = [], {}
        for k, v in d.items():
            if IDENT.match(k) and not keyword.iskeyword(k) and k not in ("kind", "id") + STEP_KW:
                out.append(f"{k}={self.value(v, indent)}")
            else:
                odd[k] = v
        if odd:
            out.append(f"**{self.value(odd, indent)}")
        return out

    def gates(self, gs: list, indent: int) -> str:
        items = []
        for g in gs:
            if isinstance(g, dict) and set(g) <= {"metric", "op", "value", "on_fail"} and \
                    {"metric", "op", "value"} <= set(g):
                s = f"gate({_q(g['metric'])}, {_q(g['op'])}, {self.value(g['value'], indent)}"
                s += f", on_fail={_q(g['on_fail'])})" if "on_fail" in g else ")"
                items.append(s)
            else:
                items.append(self.value(g, indent))
        one = "[" + ", ".join(items) + "]"
        if len(one) + indent <= 110:
            return one
        pad = " " * (indent + 4)
        return "[\n" + "".join(f"{pad}{x},\n" for x in items) + " " * indent + "]"


def _call(head: str, args: list[str], indent: int = 0) -> str:
    one = f"{head}(" + ", ".join(args) + ")"
    if len(one) + indent <= 110 and "\n" not in one:
        return one
    pad = " " * (indent + 4)
    return f"{head}(\n" + "".join(f"{pad}{a},\n" for a in args) + " " * indent + ")"


def _referenced(raw: dict) -> set[str]:
    import json
    return {m.split(".")[0] for m in re.findall(r"\$\{([A-Za-z_][\w.-]*)\}", json.dumps(raw))}


def from_raw(raw: dict, meta: dict | None = None, header: str = "", comments: dict[int, str] | None = None,
             check: bool = True) -> str:
    """Python recipe source for a blackhole/v1 dict. With check, the source is loaded back and
    must give `raw` exactly (RecipeError otherwise)."""
    if raw.get("api") != "blackhole/v1":
        raise RecipeError(f"not a blackhole/v1 schema (api = {raw.get('api')!r})")
    w = _Writer()
    lines = []
    if header:
        lines += [f"# {h}" if h else "#" for h in header.splitlines()] + [""]
    gates_used = any(st.get("gates") for st in raw.get("stage") or []) or bool((raw.get("eval") or {}).get("gates"))
    lines.append("from blackhole_dev.recipe import Recipe" + (", gate" if gates_used else ""))
    lines += ["", ""]
    known = {"api", "id", "version", "inputs", "stage", "eval"}
    top = {k: raw[k] for k in TOP_ORDER if k in raw}
    top.update({k: v for k, v in raw.items() if k not in known and k not in top})
    args = [_q(raw.get("id", "")), _q(str(raw.get("version", "")))] + w.kwargs(top, 4)
    if meta:
        args.append(f"meta={w.value(meta, 4)}")
    lines.append(_call("recipe = Recipe", args))
    refd = _referenced(raw)
    inputs = raw.get("inputs") or {}
    if inputs:
        lines.append("")
    for name, spec in inputs.items():
        spec = dict(spec)
        t = spec.pop("type", "text")
        a = [_q(name), _q(t)] + w.kwargs(spec, 4)
        var = w.var_for(f"inputs.{name}", name)
        lines.append(_call(f"{var} = recipe.input" if var else "recipe.input", a))
    lines.append("")
    for i, st in enumerate(raw.get("stage") or []):
        st = dict(st)
        if comments and i in comments:
            lines += [f"# {c}" for c in comments[i].splitlines()]
        kind = st.pop("kind", "")
        sid = st.pop("id", None)
        a = [_q(kind)] + ([_q(sid)] if sid is not None and not kind.startswith("pipeline.") else [])
        kw = {k: st.pop(k) for k in STEP_KW if k in st}
        a += w.kwargs(st, 4)
        if "needs" in kw:
            a.append(f"needs={w.value(kw['needs'], 4)}")
        if "gates" in kw:
            a.append(f"gates={w.gates(kw['gates'], 4)}")
        if "when" in kw:
            a.append(f"when={w.value(kw['when'], 4)}")
        if "always" in kw:
            a.append(f"always={kw['always']!r}")
        # the id this stage will have, for references from later stages
        real = sid or (kind.split(".", 1)[1].split("@")[0] if kind.startswith("pipeline.") else None)
        if real is None:
            from blackhole.core import schema as sch
            try:
                real = sch.parse({**raw, "stage": raw["stage"][:i + 1], "eval": {}}).stages[-1].id
            except Exception:  # noqa: BLE001
                real = None
        var = w.var_for(real, real) if real and real in refd else None
        lines.append(_call(f"{var} = recipe.step" if var else "recipe.step", a))
    ev = raw.get("eval")
    if ev is not None:
        ev = dict(ev)
        a = []
        if "gates" in ev:
            a.append(f"gates={w.gates(ev.pop('gates'), 4)}")
        a += w.kwargs(ev, 4)
        lines += ["", _call("recipe.eval", a)]
    src = "\n".join(lines).rstrip() + "\n"
    if check:
        from blackhole_dev.recipe.loader import load
        back = load(text=src).to_raw()
        if back != {**raw, "version": str(raw.get("version", ""))}:
            raise RecipeError("conversion is not lossless for this schema (report it): "
                              f"{_first_diff(raw, back)}")
    return src


def _first_diff(a: Any, b: Any, path: str = "") -> str:
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(a) + [k for k in b if k not in a]:
            if a.get(k) != b.get(k):
                return _first_diff(a.get(k), b.get(k), f"{path}.{k}")
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            if x != y:
                return _first_diff(x, y, f"{path}[{i}]")
    return f"{path or '/'}: {a!r} vs {b!r}"


def from_toml(path: str | Path, out: str | Path | None = None) -> str:
    """Convert a TOML (or JSON) schema file; writes `out` when given. Returns the source."""
    p = Path(path)
    text = p.read_text()
    if p.suffix == ".json":
        import json
        raw = json.loads(text)
    else:
        import tomllib
        raw = tomllib.loads(text)
    lead = []
    for line in text.splitlines():           # keep the file's leading comment block
        if line.startswith("#"):
            lead.append(line[1:].removeprefix(" "))
        else:
            break
    header = "\n".join(lead + ([""] if lead else []) + [f"Converted from {p.name} (blackhole/v1 TOML)."])
    src = from_raw(raw, header=header)
    if out:
        Path(out).write_text(src)
    return src


# --------------------------------------------------------------------------- TUI catalog presets


def preset_raw(schema) -> tuple[dict, dict, dict[int, str]]:
    """(raw, meta, step comments) for a blackhole_tui.catalog.Schema."""
    from blackhole_dev.recipe.pipeline import ALWAYS_FIRST, PIPELINE_STEPS
    by_kind = {}
    for s in schema.steps:
        by_kind.setdefault(s.kind, s)
    order = list(schema.stage_list) if schema.stage_list else schema.stages()
    stages, comments, done = [], {}, set()
    for name in order:
        if name in ALWAYS_FIRST or name in ("eval",):
            continue
        kind = "reap" if name in ("score", "prune") else name
        if kind in done:
            continue
        done.add(kind)
        st = by_kind.get(kind)
        if kind not in PIPELINE_STEPS and st is None:
            comments[len(stages)] = f"{name}: not a stage of the real pipeline yet"
            continue
        stages.append({"id": kind, "kind": f"pipeline.{kind}", **(dict(st.params) if st else {})})
        if st is not None and st.what:
            comments[len(stages) - 1] = st.what
    for s in schema.steps:                       # steps the stage list does not name (non-pipeline presets)
        if s.kind not in done:
            done.add(s.kind)
            comments[len(stages)] = s.what + " (not a stage of the real pipeline yet)"
            stages.append({"id": s.kind, "kind": f"pipeline.{s.kind}", **dict(s.params)})
    author = re.sub(r"[^a-z0-9_-]", "-", schema.author.lower()) or "blackhole"
    raw = {"api": "blackhole/v1", "id": f"{author}/{schema.id}", "version": "1.0.0", "title": schema.name,
           "description": schema.summary, "author": schema.author, "tags": list(schema.tags), "stage": stages}
    meta = {"quant": schema.quant}
    if schema.proven:
        meta["proven"] = True
    if schema.runs:
        meta["runs"] = schema.runs
    return raw, meta, comments


def from_preset(preset: str, out: str | Path | None = None) -> str:
    """Convert a TUI catalog preset by id (needs the public harness package installed)."""
    try:
        from blackhole_tui.catalog import SCHEMAS
    except ImportError as e:
        raise RecipeError("presets need the public blackhole-pipeline package (harness/) installed") from e
    sc = next((s for s in SCHEMAS if s.id == preset), None)
    if sc is None:
        raise RecipeError(f"no preset {preset!r}; one of {', '.join(s.id for s in SCHEMAS)}")
    raw, meta, comments = preset_raw(sc)
    header = (f"{sc.name}: converted from the TUI preset {sc.id!r}.\n"
              "pipeline.* steps are the real pipeline's stages; their params are blackhole_pipeline.DEFAULTS keys.")
    src = from_raw(raw, meta=meta, header=header, comments=comments)
    if out:
        Path(out).write_text(src)
    return src
