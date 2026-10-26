"""Problems with a recipe, each pinned to a line: what the editor's PROBLEMS panel shows.

Checks, in order: the file runs and builds one Recipe; the schema it compiles to parses
(blackhole.core.schema); every step names a known op / pipeline stage / function with
known params; references point backwards; the recipe has one runner; and the public
schema rules (blackhole.core.lint).
"""

from __future__ import annotations

import dataclasses
import re

from blackhole_dev.recipe import pipeline as pl
from blackhole_dev.recipe.core import Recipe, RecipeError
from blackhole_dev.recipe.loader import load

REF = re.compile(r"\$\{([A-Za-z_][\w.-]*)\}")


def _p(message: str, line: int, severity: str = "error", code: str = "schema", file: str | None = None) -> dict:
    d = {"severity": severity, "message": message, "line": max(1, int(line or 1)), "code": code}
    if file:
        d["file"] = file
    return d


def lint(path=None, text: str | None = None, publish: bool = False) -> tuple[Recipe | None, list[dict]]:
    """(recipe or None, problems). Never raises for a bad recipe."""
    fname = str(path) if path is not None else None
    try:
        r = load(path, text)
    except RecipeError as e:
        return None, e.problems or [_p(str(e), 1, code="recipe.error", file=fname)]
    probs = lint_recipe(r, publish)
    for p in probs:
        if fname:
            p.setdefault("file", fname)
    return r, probs


def _line_of(r: Recipe, msg: str) -> int:
    m = re.search(r"stage (?:\[(\d+)\]|([a-z][a-z0-9_]*))", msg)
    if m:
        if m.group(1) is not None and int(m.group(1)) < len(r.steps):
            return r.steps[int(m.group(1))].line
        st = r.step_at(m.group(2) or "")
        if st:
            return st.line
    m = re.search(r"inputs\.([A-Za-z_]\w*)", msg)
    return r.line


def lint_recipe(r: Recipe, publish: bool = False) -> list[dict]:
    from blackhole.core import schema as sch
    out: list[dict] = []
    try:
        raw = r.to_raw()
    except RecipeError as e:
        return e.problems or [_p(str(e), r.line)]
    try:
        sch.parse(raw)
    except sch.SchemaError as e:          # keep going: the step checks below still point at lines
        if not ("must be unique" in str(e) and any(s.family == "pipeline" for s in r.steps)):
            out.append(_p(str(e), _line_of(r, str(e))))
    except Exception as e:  # noqa: BLE001
        out.append(_p(f"{type(e).__name__}: {e}", r.line))

    runner = r.runner
    if runner == "mixed":
        first = next(s for s in r.steps if s.family == "op")
        out.append(_p("this recipe mixes pipeline.* / job functions with catalog ops; no runner takes both yet "
                      "(split it into two recipes)", first.line, code="recipe.mixed"))
    pnames = pl.param_names()
    seen_pipe: list[str] = []
    for st in r.steps:
        raw_st = st.to_raw()
        params = {k: v for k, v in raw_st.items() if k not in sch.RESERVED}
        if st.family == "pipeline":
            name = st.op.split(".", 1)[1]
            if name not in pl.PIPELINE_STEPS:
                out.append(_p(f"{st.op} is not a pipeline stage (one of {', '.join(pl.PIPELINE_STEPS)})",
                              st.line, code="op.unknown"))
                continue
            if name in seen_pipe:
                out.append(_p(f"{st.op} appears twice; the pipeline runs each stage once", st.line, code="op.unknown"))
            elif seen_pipe and pl.CANON.index(name) < max(pl.CANON.index(n) for n in seen_pipe):
                out.append(_p(f"{st.op} runs after a stage that normally follows it ({seen_pipe[-1]}); "
                              "intended?", st.line, "warning", "op.order"))
            seen_pipe.append(name)
            if pnames is None:
                out.append(_p("the pipeline package is not installed in the helper, so pipeline params are not checked",
                              st.line, "info", "op.param"))
            else:
                for k in params:
                    if k not in pnames:
                        near = sorted(n for n in pnames if n.startswith(k.split("_")[0]))[:6]
                        out.append(_p(f"{st.op}: unknown param {k!r}" + (f" (did you mean {', '.join(near)}?)" if near else ""),
                                      st.line, code="op.param"))
            for ref in REF.findall(str(params)):
                head = ref.split(".")[0]
                if head not in ("inputs",) and ref not in ("base.model", "base.id"):
                    out.append(_p(f"${{{ref}}}: a pipeline step can use inputs.<name>, base.model and base.id only",
                                  st.line, code="schema"))
            if st.gates:
                out.append(_p("gates on pipeline.* steps are not checked by the pipeline yet", st.line, "warning", "gate"))
        elif st.family == "job":
            out += _check_fn(st.fn or "", {k: v for k, v in params.items() if k != "fn"}, st.line)
        else:
            out += _check_op(st, params)
    if runner == "pipeline" and r.steps and not any(s.op == "pipeline.reap" for s in r.steps) and \
            any(s.family == "pipeline" for s in r.steps):
        out.append(_p("no pipeline.reap step: the pipeline still detects, downloads and calibrates, but nothing is "
                      "pruned", r.line, "info", "recipe.info"))
    if runner == "core":
        from blackhole.core.lint import lint as public_lint
        for msg in public_lint(raw, publish=publish):
            out.append(_p(msg, _line_of(r, msg), "warning", "lint"))
    return out


def _check_op(st, params: dict) -> list[dict]:
    from blackhole.core import ops
    out = []
    major = int(st.kind.split("@")[1]) if "@" in st.kind else 1
    try:
        cls = ops.get(st.op, major)
    except KeyError as e:
        msg = e.args[0]
        if st.op == "model.edit":
            msg += " (install blackhole-dev in the helper's Python: model.edit comes from it)"
        return [_p(msg, st.line, code="op.unknown")]
    except Exception as e:  # noqa: BLE001  an op module that does not import here
        return [_p(f"cannot load the op catalog: {type(e).__name__}: {e}", st.line, "warning", "op.unknown")]
    known = {f.name for f in dataclasses.fields(cls.Params)}
    for k in params:
        if k not in known:
            out.append(_p(f"{st.kind}: no param {k!r} (has {', '.join(sorted(known))})", st.line, code="op.param"))
    if st.op == "model.edit":
        calls = []
        if params.get("fn"):
            a = dict(params.get("args") or {})
            if params.get("select"):
                a["select"] = params["select"]
            calls.append((params["fn"], a))
        for s in params.get("steps") or []:
            if isinstance(s, dict):
                s = dict(s)
                calls.append((s.pop("fn", ""), s))
        if not calls:
            out.append(_p("model.edit needs fn or steps", st.line, code="op.param"))
        for name, a in calls:
            out += _check_fn(name, a, st.line, files=params.get("functions") or [])
    return out


def _check_fn(name: str, args: dict, line: int, files: list | None = None) -> list[dict]:
    try:
        from blackhole_dev import functions as fns
    except Exception as e:  # noqa: BLE001
        return [_p(f"functions unavailable: {e}", line, "warning", "fn.unknown")]
    if not name:
        return [_p("no function named (fn = \"...\")", line, code="fn.unknown")]
    try:
        fns.get(name)
    except KeyError as e:
        sev = "warning" if files else "error"     # may come from a file the stage loads on the VM
        return [_p(e.args[0], line, sev, "fn.unknown")]
    return [_p(m, line, code="fn.param") for m in fns.check(name, {k: v for k, v in args.items()})]
