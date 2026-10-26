"""The functions library: every built-in is a readable file, forking gives you the same power,
and a user function with a built-in's name replaces it (the override rule)."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import numpy as np
import pytest

import blackhole_dev as anatomy
from blackhole_dev import functions as fns

from test_anatomy import E, LAYERS, moe  # noqa: F401  (the hand-written MoE checkpoint fixture)

SRC = Path(fns.__file__).with_name("functions_src")


@pytest.fixture
def user(tmp_path, monkeypatch):
    """An empty user functions folder, and a registry that forgets workspaces afterwards."""
    d = tmp_path / "user-functions"
    d.mkdir()
    monkeypatch.setenv("BLACKHOLE_DEV_FUNCTIONS", str(d))
    monkeypatch.setattr(fns, "_workspaces", [])
    fns.refresh()
    yield d
    monkeypatch.undo()
    fns.refresh()


def builtins() -> dict[str, fns.Fn]:
    return {n: f for n, f in fns.registry().items() if f.builtin}


def test_every_builtin_is_its_own_readable_file():
    reg = builtins()
    assert len(reg) >= 30
    for name, f in reg.items():
        p = Path(f.path)
        assert p.parent == SRC and p.name == name.replace("-", "_") + ".py", (name, p)
        tree = ast.parse(p.read_text())
        decorated = [d.args[0].value for n in tree.body if isinstance(n, ast.FunctionDef) for d in n.decorator_list
                     if isinstance(d, ast.Call) and getattr(d.func, "id", "") == "function"]
        assert decorated == [name], (p, decorated)       # exactly this one function, so a fork is the whole of it
        assert f.doc and f.sha256 and len(f.sha256) == 64
        s = fns.source(name)
        assert s["readonly"] and s["text"] == p.read_text()
    # the pipeline's GPU stages are named functions too
    for name in ("calibrate", "reap-gpu", "traces", "distil", "qheal", "gptq", "reaq-codebook", "mlx-export", "bench",
                 "fp8-experts", "package"):
        assert reg[name].per == "job", name


def test_every_pipeline_stage_and_knob_is_reachable_from_a_function():
    """Decision 3: nothing a preset does is out of reach. Every stage of the pipeline is run by a
    built-in function and every run knob of the pipeline is a parameter of one of them."""
    pytest.importorskip("blackhole_pipeline")
    from blackhole_pipeline import DEFAULTS, STAGES
    text = "\n".join(Path(f.path).read_text() for f in builtins().values() if f.per == "job")
    from blackhole_pipeline import PROCESSES
    ran = set(re.findall(r'"([a-z]+)"', text)) & {p for p, _, _ in PROCESSES}   # run_stage("heal"), ("detect", ...)
    if '"-m", "blackhole_pipeline.bench"' in text:
        ran.add("bench")                                 # bench is ported: it drives the LiveCodeBench runner itself
    covered = {s for p, ss, _ in PROCESSES if p in ran for s in ss}
    assert set(STAGES) <= covered, set(STAGES) - covered
    knobs = set(re.findall(r'\b([a-z][a-z0-9_]+)=', text)) | set(re.findall(r'"([a-z][a-z0-9_]+)":', text))
    missing = {k for k in DEFAULTS if k not in knobs and k not in ("bench", "bench_models", "bench_limit",
                                                                     "bench_max_tokens", "bench_budgets", "bench_file")}
    assert not missing, missing   # bench_* are the bench function's own params (release, models, ...)


def test_fork_keeps_the_name_and_overrides_the_builtin(moe, user):  # noqa: F811
    orig = fns.get("clip-outliers")
    out = fns.fork("clip-outliers")
    p = Path(out["path"])
    assert p.parent == user and out["active"] and out["overrides"] == ["builtin"]
    f = fns.get("clip-outliers")
    assert f.layer == fns.USER and f.path == str(p.resolve())
    row = next(r for r in fns.rows() if r["name"] == "clip-outliers")
    assert row["forked_from"]["sha256"] == orig.sha256 and row["upstream_changed"] is False
    assert row["overrides"][0]["layer"] == "builtin"
    text = p.read_text()
    assert text.startswith(fns.FORK_MARK) and "replaces the original everywhere" in text
    # change the fork: every caller now gets yours
    p.write_text(text.replace("return np.clip(w, mu - sigma * s, mu + sigma * s)", "return w * 0"))
    fns.refresh()
    m = anatomy.open(moe)
    m.call("clip-outliers", select="layers[0].attn")
    assert np.all(m.layers[0].attn.roles["q"].numpy() == 0)
    # delete it: the built-in is back
    p.unlink()
    fns.refresh()
    assert fns.get("clip-outliers").builtin


def test_fork_under_a_new_name_sits_next_to_the_builtin(user):
    out = fns.fork("reap-prune", new_name="my-prune")
    assert out["name"] == "my-prune" and out["overrides"] == []
    assert fns.get("reap-prune").builtin and fns.get("my-prune").layer == fns.USER
    assert fns.get("my-prune").params == fns.get("reap-prune").params
    with pytest.raises(FileExistsError):
        fns.fork("reap-prune", new_name="my-prune")
    with pytest.raises(ValueError, match="edit it there"):
        fns.fork("my-prune")


def test_layers_workspace_beats_user_and_same_layer_twice_is_a_problem(tmp_path, user):
    (user / "a.py").write_text("from blackhole_dev import function\n"
                               "@function('scale')\ndef s(w, factor: float = 1.0, select: str = ''):\n    return w * 2\n")
    fns.refresh()                                        # the app calls this after every save in the folder
    assert fns.get("scale").layer == fns.USER
    ws = tmp_path / "project"
    fns.add_workspace(ws)
    (ws / "functions").mkdir(parents=True)
    (ws / "functions" / "b.py").write_text("from blackhole_dev import function\n"
                                           "@function('scale')\ndef s(w, factor: float = 1.0, select: str = ''):\n"
                                           "    return w * 3\n")
    fns.refresh()
    f = fns.get("scale")
    assert f.layer == fns.WORKSPACE and [d.layer for d in fns.definitions("scale")] == [0, 2, 3]
    assert fns.fork_dir() == (ws / "functions").resolve()
    # a second user file with the same name, and a broken one: problems, the registry still works
    (user / "c.py").write_text("from blackhole_dev import function\n"
                               "@function('scale')\ndef s(w, select: str = ''):\n    return w\n")
    (user / "d.py").write_text("this is not python\n")
    probs = fns.refresh()
    assert any("defined twice in the user layer" in p["error"] for p in probs)
    assert any(p["path"].endswith("d.py") for p in probs)
    assert fns.get("scale").layer == fns.WORKSPACE and "reaq" in fns.registry()


def test_recipe_layer_wins_over_everything(tmp_path, user):
    fns.fork("trim-head")
    f = tmp_path / "recipe_fns.py"
    f.write_text("from blackhole_dev import function\n"
                 "@function('trim-head', per='model')\ndef th(m, keep: list = ()):\n    return {'recipe': True}\n")
    fns.load(str(f))
    try:
        assert fns.get("trim-head").layer == fns.RECIPE
        assert [d.layer for d in fns.definitions("trim-head")] == [0, 2, 4]
    finally:
        fns._DEFS["trim-head"].pop(fns.RECIPE)
        fns._resolve("trim-head")


def test_unchanged_forks_of_every_model_builtin_rebuild_the_recipe_exactly(moe, tmp_path, user):  # noqa: F811
    """Fork every model-level built-in the REAP/REAQ/HEX recipe uses into the user folder and run
    the recipe on the forks: byte-identical output, so the forks have all the power the built-ins have."""
    def recipe(out):
        m = anatomy.open(moe)
        m.load_scores({L: {"saliency": list(range(E))} for L in range(LAYERS)})
        m.call("reap-prune", ratio=0.5)
        m.call("merge-similar-experts", pairs=1)
        m.call("reaq", avg_bits=3.75)
        m.call("hex-quantize")
        m.call("clip-outliers", select="layers[*].attn", sigma=3)
        m.call("hex-pack", dst=str(out))
        return m.functions
    used = ["reap-prune", "merge-similar-experts", "reaq", "hex-quantize", "clip-outliers", "hex-pack"]
    a = recipe(tmp_path / "builtin")
    for n in used:
        fns.fork(n)
    assert all(fns.get(n).layer == fns.USER for n in used)
    b = recipe(tmp_path / "forked")
    assert all(a[n] != b[n] for n in used)       # the receipt pins which code ran (the forks' own sha256)
    for name in ("model.safetensors", "config.json"):
        x, y = (tmp_path / "builtin" / name).read_bytes(), (tmp_path / "forked" / name).read_bytes()
        assert x == y, name


def test_job_functions_refuse_models_and_check_params():
    assert "unknown param" in fns.check("distil", {"minuts": 3})[0]
    assert fns.check("bench", {"models": "mlx"}) == []
    with pytest.raises(ValueError, match="job function"):
        fns.call(object(), "distil")
    with pytest.raises(ValueError, match="per-model"):
        fns.call_job(object(), "reap-prune")


def test_traces_keeps_the_shortest_verified_answer(tmp_path, monkeypatch):
    """traces on a stand-in teacher: unfinished answers never count, failing ones are dropped, the
    shortest passing answer per problem is the training row, and the pipeline's heal is told to
    train on these rows."""
    pytest.importorskip("reaper_pipeline")
    from blackhole_dev.functions_src import _teacher

    rows = [{"question_id": "a", "question_title": "add", "question_content": "Print a+b.", "starter_code": "",
             "difficulty": "easy", "platform": "x", "contest_date": "2024-09-01",
             "public_test_cases": json.dumps([{"input": "1 2\n", "output": "3\n", "testtype": "stdin"},
                                              {"input": "3 4\n", "output": "7\n", "testtype": "stdin"}]),
             "private_test_cases": "[]", "metadata": "{}"}]
    file = tmp_path / "probs.jsonl"
    file.write_text("".join(json.dumps(r) + "\n" for r in rows))
    good = "```python\na, b = map(int, input().split())\nprint(a + b)\n```"
    replies = [good + " and some more words", good, "```python\nprint(3)\n```", good + " cut"]

    class Tok:
        def decode(self, ids, skip_special_tokens=True):
            return replies[ids[0]]

    class FakeTeacher:
        tok = Tok()

        def encode_chat(self, messages):
            return [1, 2, 3]

        def generate_with_budget(self, enc, max_tokens, budget, pct=(0, 100)):
            # answer i: token ids [i, ...], length = how long the answer is; answer 3 never finished
            return [[0] * 9, [1] * 5, [2] * 3, [3] * 2]

        def finished(self, ids):
            return ids[0] != 3

        def free(self):
            pass
    monkeypatch.setattr(_teacher.Teacher, "of", classmethod(lambda cls, job: FakeTeacher()))

    class FakeJob:
        stage, params = "traces", {}
        written, knobs = {}, {}

        def emit(self, *a, **k):
            pass

        def path(self, *parts):
            p = tmp_path.joinpath(*parts)
            p.parent.mkdir(parents=True, exist_ok=True)
            return p

        def write(self, rel, obj):
            self.written[rel] = obj

        def set(self, **k):
            self.knobs.update(k)
    job = FakeJob()
    out = fns.call_job(job, "traces", problems=1, samples=4, file=str(file))
    got = [json.loads(x) for x in (tmp_path / "work" / "heal_data.jsonl").read_text().splitlines()]
    assert got == [{"ids": [1, 2, 3] + [1] * 5, "start": 3}]
    assert out["solved"] == 1 and out["passed"] == 2 and out["rows"] == 1
    assert job.knobs == {"heal_calib": "contest", "heal_samples": 4, "heal_prompts": 1}
    out = fns.call_job(job, "traces", problems=1, samples=4, file=str(file), keep="all")
    assert out["rows"] == 2
