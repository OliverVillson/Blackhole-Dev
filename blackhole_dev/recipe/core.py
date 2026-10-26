"""Recipe, Step, Ref and gate: a BlackHole schema written as Python.

A recipe file builds one `Recipe` at module level. Each `step()` is one stage of the
blackhole/v1 schema, with the op's params as keyword arguments; references to inputs,
earlier stages, the base model and the hardware are objects that print as `${...}`.
`to_raw()` gives exactly the dict a TOML schema parses to, so everything that reads
schemas (the runner, `blackhole validate`, the marketplace) reads recipes too.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from blackhole.core import schema as sch

# pipeline.<name>: the stages of the real pipeline (harness/blackhole_pipeline) a recipe can run
PIPELINE_STEPS = ("reap", "heal", "gptq", "reaq", "mlx", "qheal", "bench", "quant", "package")
INPUT_TYPES = {float: "float", int: "int", str: "text", bool: "bool"}
_SNAKE = re.compile(r"[^a-z0-9_]")


class RecipeError(ValueError):
    """A recipe that cannot be built. `problems` holds editor-ready dicts."""

    def __init__(self, msg: str, problems: list[dict] | None = None):
        super().__init__(msg)
        self.problems = problems or []


class Ref:
    """A reference that prints as ${path}: recipe.inputs.prune, score.saliency, recipe.base.model."""

    __slots__ = ("path",)

    def __init__(self, path: str):
        self.path = path

    def __getattr__(self, name: str) -> "Ref":
        if name.startswith("__"):
            raise AttributeError(name)
        return Ref(f"{self.path}.{name}")

    def __str__(self) -> str:
        return "${" + self.path + "}"

    def __format__(self, spec: str) -> str:
        return str(self)

    def __repr__(self) -> str:
        return f"Ref({self.path!r})"

    def __eq__(self, other) -> bool:
        return isinstance(other, Ref) and other.path == self.path

    def __hash__(self) -> int:
        return hash(self.path)


class _Inputs:
    def __init__(self, recipe: "Recipe"):
        object.__setattr__(self, "_r", recipe)

    def __getattr__(self, name: str) -> Ref:
        if name.startswith("__"):
            raise AttributeError(name)
        return Ref(f"inputs.{name}")

    def __getitem__(self, name: str) -> Ref:
        return Ref(f"inputs.{name}")


def gate(metric: str, op: str, value: Any, on_fail: str | None = None) -> dict:
    """A gate: stop the run (or warn) unless `metric op value` holds."""
    if op not in sch.GATE_OPS:
        raise RecipeError(f"gate op must be one of {sorted(sch.GATE_OPS)}")
    g = {"metric": metric, "op": op, "value": value}
    if on_fail is not None:
        g["on_fail"] = on_fail
    return g


def plain(value: Any) -> Any:
    """Refs to ${...} strings, tuples to lists, recursively."""
    if isinstance(value, Ref):
        return str(value)
    if isinstance(value, Step):
        raise RecipeError(f"a step is not a value; use one of its artifacts, e.g. {value.id}.model")
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def _caller_line() -> int:
    """Line in the recipe file that called into this module (first frame outside it)."""
    f = sys._getframe(1)
    here = __file__
    while f is not None and f.f_code.co_filename == here:
        f = f.f_back
    return f.f_lineno if f is not None else 0


class Step:
    """One stage. Attribute access gives references to what it produces: step.model,
    step.saliency, step.metrics.kl."""

    def __init__(self, kind: str, id: str, explicit_id: bool, params: dict, needs: dict | None,
                 gates: list | None, when: Any, always: bool, line: int):
        self.kind, self.id, self.explicit_id = kind, id, explicit_id
        self.params, self.needs, self.gates, self.when, self.always = params, needs, gates, when, always
        self.line = line

    def __getattr__(self, name: str) -> Ref:
        if name.startswith("_") or name in ("kind", "id", "explicit_id", "params", "needs", "gates", "when",
                                            "always", "line"):
            raise AttributeError(name)
        return Ref(f"{self.id}.{name}")

    @property
    def op(self) -> str:
        return self.kind.split("@")[0]

    @property
    def family(self) -> str:
        """pipeline (a stage of the real pipeline), job (a job function), or op (a catalog op)."""
        if self.op.startswith("pipeline."):
            return "pipeline"
        if self.op == "job.fn":
            return "job"
        return "op"

    @property
    def fn(self) -> str | None:
        """The named function this step calls, if it calls exactly one."""
        return self.params.get("fn") if isinstance(self.params.get("fn"), str) else None

    def functions(self) -> list[str]:
        """Every named function this step calls (fn, and each steps[].fn of model.edit)."""
        out = [self.fn] if self.fn else []
        for s in self.params.get("steps") or []:
            if isinstance(s, dict) and isinstance(s.get("fn"), str):
                out.append(s["fn"])
        return out

    def to_raw(self) -> dict:
        d: dict = {}
        if self.explicit_id:
            d["id"] = self.id
        d["kind"] = self.kind
        d.update(plain(self.params))
        if self.needs:
            d["needs"] = plain(self.needs)
        if self.gates:
            d["gates"] = plain(self.gates)
        if self.when is not True:
            d["when"] = plain(self.when)
        if self.always:
            d["always"] = True
        return d

    def __repr__(self) -> str:
        return f"Step({self.id!r}, {self.kind!r})"


class Recipe:
    """A schema as Python. Keyword arguments are the schema's top-level fields (title,
    description, author, license, tags, parent, base_compat, task, base, data, purpose,
    outputs, targets, footprint, data_policy); `meta` is app/pipeline metadata kept out
    of the blackhole/v1 dict (target device, preset quant label, ...)."""

    def __init__(self, id: str, version: str = "0.1.0", *, meta: dict | None = None, **fields):  # noqa: A002
        self.id, self.version = id, str(version)
        self.fields = fields
        self.meta = dict(meta or {})
        self.input_specs: dict[str, dict] = {}
        self.steps: list[Step] = []
        self.eval_table: dict | None = None
        self.line = _caller_line()
        self.inputs = _Inputs(self)
        self.base = Ref("base")
        self.hw = Ref("hw")
        self._taken: set[str] = set()

    # -------------------------------------------------------------- building
    def input(self, name: str, type: Any = "text", **spec) -> Ref:  # noqa: A002
        """Declare a knob users set (type text|int|float|bool|enum|model|path, or float/int/str/bool);
        spec: default, required, help, min, max, choices, advanced. Returns its reference."""
        t = INPUT_TYPES.get(type, type)
        if t not in sch.INPUT_TYPES:
            raise RecipeError(f"input {name}: type must be one of {sch.INPUT_TYPES}")
        self.input_specs[name] = {"type": t, **plain(spec)}
        return Ref(f"inputs.{name}")

    def step(self, kind: str, id: str | None = None, *, needs: dict | None = None, gates: list | None = None,  # noqa: A002
             when: Any = True, always: bool = False, **params) -> Step:
        """Add a stage running op `kind` (ns.op or ns.op@2, or pipeline.<stage>) with its params."""
        line = _caller_line()
        op = kind.split("@")[0]
        explicit = id is not None
        if op.startswith("pipeline."):
            name = op.split(".", 1)[1]
            if explicit and id != name:
                raise RecipeError(f"pipeline steps keep their stage name as id ({name!r}, not {id!r})",
                                  [_problem(f"pipeline steps keep their stage name as id ({name!r})", line)])
            id, explicit = name, True       # noqa: A001  the pipeline's own stage name
        if id is None:
            id = self._auto_id(op)          # noqa: A001
        elif id in self._taken and not op.startswith("pipeline."):   # a repeated pipeline stage: lint says so
            prev = next((s for s in self.steps if s.id == id), None)
            raise RecipeError(f"step id {id!r} is already used (line {prev.line if prev else '?'})",
                              [_problem(f"step id {id!r} is already used"
                                        + (f" by the step on line {prev.line}" if prev else ""), line)])
        self._taken.add(id)
        st = Step(kind, id, explicit, dict(params), needs, gates, when, always, line)
        self.steps.append(st)
        return st

    def fn(self, name: str, id: str | None = None, *, select: str | None = None, gates: list | None = None,  # noqa: A002
           when: Any = True, always: bool = False, scores: Any = None, functions: list | None = None,
           pack: str | None = None, **args) -> Step:
        """Call a named function. A job function (forkable pipeline stage) becomes a job.fn
        stage; any other becomes a model.edit stage with this one function."""
        sid = id or _SNAKE.sub("_", name.lower().replace("-", "_")).strip("_") or "fn"
        if sid[0].isdigit():
            sid = "fn_" + sid
        if id is None and sid in self._taken:
            sid = self._auto_id(sid, base=sid)
        if function_kind(name) == "job":
            return self.step("job.fn", sid, gates=gates, when=when, always=always, fn=name, **args)
        params: dict = {"fn": name}
        if select is not None:
            params["select"] = select
        if args:
            params["args"] = args
        for k, v in (("scores", scores), ("functions", functions), ("pack", pack)):
            if v is not None:
                params[k] = v
        return self.step("model.edit", sid, gates=gates, when=when, always=always, **params)

    def edit(self, steps: list[dict], id: str | None = None, **opts) -> Step:  # noqa: A002
        """Several named functions in one model.edit stage: [{"fn": "reaq", "avg_bits": 3.5}, ...]."""
        return self.step("model.edit", id, steps=steps, **opts)

    def eval(self, gates: list | None = None, **table) -> None:  # noqa: A003
        """The schema's [eval] table: suites and the final gates the receipt checks."""
        self.eval_table = {**plain(table), **({"gates": plain(gates)} if gates is not None else {})}

    def _auto_id(self, op: str, base: str | None = None) -> str:
        short = base or op.split(".")[0]
        sid, n = short, 2
        while sid in self._taken:
            sid, n = f"{short}{n}", n + 1
        return sid

    # -------------------------------------------------------------- output
    @property
    def runner(self) -> str:
        """pipeline: pipeline.* and job.fn stages (blackhole_pipeline); core: catalog ops
        (blackhole.core.runner); mixed: both, which no runner takes yet."""
        fam = {s.family for s in self.steps}
        if not fam or fam <= {"pipeline", "job"}:
            return "pipeline"
        return "core" if fam == {"op"} else "mixed"

    @property
    def name(self) -> str:
        return self.id.split("/")[-1]

    def to_raw(self) -> dict:
        raw: dict = {"api": sch.API_VERSION, "id": self.id, "version": self.version}
        raw.update(plain(self.fields))
        if self.input_specs:
            raw["inputs"] = dict(self.input_specs)
        raw["stage"] = [s.to_raw() for s in self.steps]
        if self.eval_table is not None:
            raw["eval"] = self.eval_table
        return raw

    def schema(self) -> sch.Schema:
        return sch.parse(self.to_raw())

    def step_at(self, sid: str) -> Step | None:
        return next((s for s in self.steps if s.id == sid), None)

    def __repr__(self) -> str:
        return f"Recipe({self.id!r}, {self.version!r}, {len(self.steps)} steps)"


def function_kind(name: str) -> str | None:
    """per= of a registered function (tensor|part|model|job), None when unknown here."""
    try:
        from blackhole_dev import functions as fns
        return fns.get(name).per
    except Exception:  # noqa: BLE001
        return None


def _problem(message: str, line: int, severity: str = "error", code: str = "schema", **extra) -> dict:
    return {"severity": severity, "message": message, "line": line, "code": code, **extra}
