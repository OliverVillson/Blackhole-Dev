"""The preset recipes (recipes/*.py) are plain recipe files built only from named functions,
and running them runs exactly the job the pipeline's own presets run."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from blackhole_dev import functions as fns
from blackhole_dev.recipe import lint, load

ROOT = Path(__file__).resolve().parents[1]
RECIPES = sorted((ROOT / "recipes").glob("*.py"))
spec = importlib.util.spec_from_file_location("make_presets", ROOT / "scripts" / "make_presets.py")
mp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mp)


@pytest.mark.parametrize("path", RECIPES, ids=lambda p: p.stem)
def test_preset_recipes_lint_clean_and_use_only_named_functions(path):
    r, probs = lint(path)
    assert r is not None and not [p for p in probs if p.get("severity") == "error"], probs
    for st in r.steps:
        raw = st.to_raw()
        assert raw["kind"] in ("job.fn", "model.edit"), raw          # no pipeline.* or catalog ops left
        calls = raw.get("steps") or [{"fn": raw["fn"], **raw.get("args", {}),
                                      **({} if raw["kind"] == "model.edit" else
                                         {k: v for k, v in raw.items() if k not in ("id", "kind", "fn")})}]
        for c in calls:
            c = dict(c)
            name = c.pop("fn")
            c.pop("gates", None)
            assert fns.get(name).builtin, name
            assert fns.check(name, {k: v for k, v in c.items() if k != "select"}) == [], (name, c)


class Recorder:
    """A job that records what job functions would do: knobs set and pipeline stages run."""

    def __init__(self):
        from blackhole_pipeline import DEFAULTS
        self.params = dict(DEFAULTS)
        self.knobs: dict = {}
        self.stages: list[str] = []
        self.config = {"model": "m"}
        self.stage = "rec"
        self.functions: dict = {}
        self.mlx_dir = Path("/mlx")
        self.bh = type("BH", (), {"read": lambda self, rel: None})()

    def set(self, **knobs):
        knobs = {k: v for k, v in knobs.items() if v is not None}
        self.knobs.update(knobs)
        self.params.update(knobs)
        return []

    def run_stage(self, name, fresh=False, pct=(0, 100), **knobs):
        self.set(**knobs)
        self.stages.append(name)
        return {}

    def is_done(self, stage):
        return True

    def call(self, name, **params):
        return fns.call_job(self, name, **params)

    def emit(self, *a, **k):
        pass

    log = emit


def run_recipe(recipe, rec: Recorder) -> None:
    for st in recipe.steps:
        raw = st.to_raw()
        params = {k: v for k, v in raw.items() if k not in ("id", "kind", "fn", "gates")}
        if raw["fn"] == "bench":     # bench drives the LiveCodeBench runner itself: record its settings
            rec.stages.append("bench")
            for knob, (fn, p) in mp.KNOBS.items():
                if fn == "bench" and p in params:
                    rec.knobs[knob] = f"lcb-{params[p]}" if knob == "bench" else params[p]
            continue
        fns.call_job(rec, raw["fn"], **params)


def test_generated_recipes_run_the_same_job_as_the_pipeline_presets(tmp_path):
    """For every preset in the installed pipeline's catalog: the generated recipe sets the same
    knobs to the same values and runs the same pipeline stages as the preset."""
    pytest.importorskip("blackhole_pipeline")
    from blackhole_pipeline import PROCESSES
    from blackhole_tui.catalog import SCHEMAS
    checked = 0
    for sc in SCHEMAS:
        if mp.runnable(sc):
            continue
        f = tmp_path / f"{sc.id}.py"
        f.write_text(mp.source(sc))
        rec = Recorder()
        run_recipe(load(f), rec)
        want = {k: v for s in sc.steps for k, v in s.params.items()}
        assert rec.knobs == want, sc.id
        order = list(sc.stage_list) if sc.stage_list else sc.stages()
        ran = {s for p, ss, _ in PROCESSES if p in rec.stages for s in ss} | ({"bench"} & set(rec.stages))
        assert {"reap" if s in ("score", "prune") else s for s in order} <= ran | {"reap"}, sc.id
        assert ran <= set(order) | {"score", "prune", "reap"}, sc.id
        checked += 1
    assert checked >= 5


def test_committed_presets_match_the_generator_where_the_catalog_agrees():
    """recipes/*.py come from the newest pipeline's catalog; where the installed catalog has the
    same preset with the same settings, the file is exactly what the generator writes."""
    pytest.importorskip("blackhole_pipeline")
    from blackhole_tui.catalog import SCHEMAS
    for sc in SCHEMAS:
        p = ROOT / "recipes" / f"{sc.id.replace('-', '_')}.py"
        if mp.runnable(sc) or not p.exists():
            continue
        rec = Recorder()
        run_recipe(load(p), rec)
        if rec.knobs == {k: v for s in sc.steps for k, v in s.params.items()}:
            assert p.read_text() == mp.source(sc), sc.id
