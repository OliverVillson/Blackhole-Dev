"""blackhole_dev.recipe and the app helper (blackhole_dev.rpc): the Python recipe format, the
lossless TOML / preset converters, lint, the dry-run plan, .bhr bundles and JSON-RPC over stdio.
Numpy only; the preset and pipeline-hook tests need the public harness package installed."""

from __future__ import annotations

import json
import subprocess
import sys
import tarfile
import tomllib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from tinyckpt import tiny_moe  # noqa: E402

from blackhole_dev.recipe import Recipe, RecipeError, gate, load  # noqa: E402
from blackhole_dev.recipe.bundle import bundle  # noqa: E402
from blackhole_dev.recipe.convert import from_raw, from_toml  # noqa: E402
from blackhole_dev.recipe.lint import lint  # noqa: E402
from blackhole_dev.recipe.plan import plan  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def _public_schemas() -> list[Path]:
    import blackhole
    pub = Path(blackhole.__file__).resolve().parents[1] / "schemas"
    return sorted(pub.rglob("*.toml")) if pub.is_dir() else []


SCHEMAS = sorted((ROOT / "schemas").glob("*.toml")) + _public_schemas()


@pytest.fixture
def model(tmp_path):
    return tiny_moe(tmp_path / "models" / "tiny")


def write(tmp_path: Path, name: str, text: str) -> Path:
    p = tmp_path / "recipes" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


# --------------------------------------------------------------------------- the format


def test_recipe_compiles_to_the_schema_dict():
    r = Recipe("me/demo", "1.2.0", title="Demo", targets={"architectures": ["moe"]}, meta={"target": "mac16"})
    prune = r.input("prune", float, default=0.25, min=0.0, max=0.5)
    score = r.step("score.reap", max_seq=2048)
    r.step("prune.reap", ratio=prune, saliency=score.saliency, gates=[gate("kl", "<=", 0.1, on_fail="warn")])
    r.step("eval.kl", model=r.base.model, note=f"after {prune}")
    r.eval(gates=[gate("prune.kl", "<", 0.2)], suites=["kl"])
    raw = r.to_raw()
    assert raw["inputs"] == {"prune": {"type": "float", "default": 0.25, "min": 0.0, "max": 0.5}}
    assert raw["stage"][0] == {"kind": "score.reap", "max_seq": 2048}          # auto id: no id key, like TOML
    assert raw["stage"][1]["ratio"] == "${inputs.prune}" and raw["stage"][1]["saliency"] == "${score.saliency}"
    assert raw["stage"][1]["gates"] == [{"metric": "kl", "op": "<=", "value": 0.1, "on_fail": "warn"}]
    assert raw["stage"][2]["note"] == "after ${inputs.prune}" and raw["stage"][2]["model"] == "${base.model}"
    assert raw["eval"] == {"suites": ["kl"], "gates": [{"metric": "prune.kl", "op": "<", "value": 0.2}]}
    assert "meta" not in raw and r.meta == {"target": "mac16"}
    s = r.schema()
    assert [st.id for st in s.stages] == ["score", "prune", "eval"] and r.runner == "core"


def test_step_ids_and_pipeline_rules():
    r = Recipe("me/x")
    a, b = r.step("eval.kl"), r.step("eval.kl")
    assert (a.id, b.id) == ("eval", "eval2")
    with pytest.raises(RecipeError, match="already used"):
        r.step("prune.reap", id="eval")
    p = Recipe("me/p")
    reap = p.step("pipeline.reap", prune=0.25)
    assert reap.id == "reap" and p.to_raw()["stage"][0]["id"] == "reap" and p.runner == "pipeline"
    with pytest.raises(RecipeError, match="keep their stage name"):
        p.step("pipeline.heal", id="heal2")
    e = p.fn("reap-prune", ratio=0.3)
    assert e.kind == "model.edit" and e.params == {"fn": "reap-prune", "args": {"ratio": 0.3}} and e.id == "reap_prune"
    assert p.runner == "mixed"


@pytest.mark.parametrize("path", SCHEMAS, ids=lambda p: p.name)
def test_toml_converts_losslessly(path, tmp_path):
    raw = tomllib.loads(path.read_text())
    src = from_toml(path, tmp_path / "r.py")              # from_raw checks the round trip itself
    assert load(tmp_path / "r.py").to_raw() == raw
    assert "recipe = Recipe(" in src


def test_converter_uses_variables_for_references():
    src = from_toml(ROOT / "schemas" / "reapq-hex.toml")
    assert "prune = recipe.input(" in src and "args={\"ratio\": prune}" in src
    assert "gates=[gate(\"hex-quantize.rel_mse\", \"<=\", 0.2)]" in src


def test_presets_give_the_same_pipeline_job():
    catalog = pytest.importorskip("blackhole_tui.catalog")
    job_config = pytest.importorskip("blackhole_pipeline.recipe").job_config
    from blackhole_pipeline.job import params
    from blackhole_dev.recipe.convert import from_preset
    real = [s for s in catalog.SCHEMAS if s.stage_list]
    assert {"qwen-mac-qhex", "mac-qhex", "reaq-codebook"} <= {s.id for s in real}
    for sc in real:
        r = load(text=from_preset(sc.id))
        tui = {"model": "m", "schema": sc.id, "purpose": "", "steps": [s.__dict__ for s in sc.steps], "quant": sc.quant}
        cfg = job_config({"raw": r.to_raw(), "meta": r.meta}, {}, model="m")
        assert cfg["stage_list"] == list(sc.stage_list), sc.id
        assert params(cfg) == params(tui), sc.id


# --------------------------------------------------------------------------- loading and lint


def test_loader_problems_carry_lines(tmp_path):
    with pytest.raises(RecipeError) as e:
        load(text="from blackhole_dev.recipe import Recipe\nrecipe = Recipe('me/x'\n")
    assert e.value.problems[0]["code"] == "syntax"
    p = write(tmp_path, "boom.py", "from blackhole_dev.recipe import Recipe\nrecipe = Recipe('me/x')\n\n1 / 0\n")
    with pytest.raises(RecipeError) as e:
        load(p)
    assert e.value.problems[0]["line"] == 4 and "ZeroDivisionError" in e.value.problems[0]["message"]
    with pytest.raises(RecipeError, match="no Recipe"):
        load(text="x = 1\n")
    two = "from blackhole_dev.recipe import Recipe\na = Recipe('me/a')\nb = Recipe('me/b')\n"
    with pytest.raises(RecipeError, match="2 Recipes"):
        load(text=two)
    assert load(text=two + "recipe = b\n").id == "me/b"


def test_lint_points_at_the_right_line(tmp_path):
    p = write(tmp_path, "bad.py", "\n".join([
        "from blackhole_dev.recipe import Recipe",
        "recipe = Recipe('me/bad', base='x')",
        "recipe.step('pipeline.reap', prune=0.3)",
        "recipe.step('pipeline.mlx', mlx_bitz=3)",
        "recipe.step('pipeline.heal', heal_minutes=recipe.hw.gpu_mem_gb)",
        "recipe.step('pipeline.reap')",
        ""]))
    _r, probs = lint(p)
    by_line = {(x["line"], x["code"]) for x in probs}
    from blackhole_dev.recipe import pipeline as pl
    if pl.DEFAULTS is not None:
        assert (4, "op.param") in by_line        # unknown pipeline param (needs the pipeline package)
    assert (5, "schema") in by_line              # hw refs cannot reach a pipeline stage
    assert (5, "op.order") in by_line            # heal after mlx: a warning
    assert (6, "op.unknown") in by_line          # reap twice
    q = write(tmp_path, "ops.py", "\n".join([
        "from blackhole_dev.recipe import Recipe",
        "recipe = Recipe('me/ops')",
        "recipe.step('nope.op')",
        "recipe.fn('no-such-function')",
        "recipe.fn('reap-prune', ratoi=0.2)",
        ""]))
    _r, probs = lint(q)
    codes = {(x["line"], x["code"]) for x in probs}
    assert (3, "op.unknown") in codes and (4, "fn.unknown") in codes and (5, "fn.param") in codes
    ok = write(tmp_path, "ok.py", "from blackhole_dev.recipe import Recipe\nrecipe = Recipe('me/ok')\n"
                                  "recipe.fn('reap-prune', ratio=0.25)\nrecipe.fn('reaq', avg_bits=3.5)\n")
    assert [x for x in lint(ok)[1] if x["severity"] == "error"] == []


# --------------------------------------------------------------------------- plan


def test_plan_simulates_size_effects(model):
    r = Recipe("me/p", base=str(model))
    r.step("pipeline.reap", prune=0.5)
    r.step("pipeline.mlx", mlx_hex=1, mlx_bits=3)
    out = plan(r, device="mac16")
    rows = {x["label"]: x["value"] for x in out["rows"]}
    assert out["fits"] is True and out["sizeGb"] > 0 and rows["Runner"] == "pipeline"
    assert [s["sim"] for s in out["steps"]] == ["simulated", "simulated"]
    full = plan(Recipe("me/none", base=str(model)), device="mac16")
    assert out["sizeGb"] < full["sizeGb"] / 2.5            # half the experts, 3-bit tables vs f32
    assert out["estHours"] is not None and out["needs"]["gpu_gb"] > 0
    fn = Recipe("me/f", base=str(model))
    fn.fn("reap-prune", ratio=0.5)
    fn.fn("reap-score", calib="calib.jsonl")
    f = plan(fn, device="gpu8")
    assert f["steps"][0]["sim"] == "simulated" and f["steps"][1]["sim"] == "not simulated"
    assert f["sizeGb"] < full["sizeGb"]
    missing = plan(Recipe("me/m", base="/nope/model"), device="mac16")
    assert missing["sizeGb"] is None and missing["fits"] is None
    assert missing["problems"][0]["code"] == "plan.no-model"
    assert full["gated"] is None and full["baseGb"] > 0      # a local folder: no Hub question


def test_hub_headers_are_cached_and_failures_fail_fast(monkeypatch, model):
    import blackhole_dev.model as M
    from blackhole.anatomy import st
    files = st.checkpoint_files(model)
    heads = []
    for f in files:
        hdr, base = st.Blob(str(model / f)).header()
        heads.append((str(model / f), hdr, base, {}))
    cfg = json.loads((model / "config.json").read_text())
    calls = []
    monkeypatch.setattr(M, "_hub_cache", {})
    monkeypatch.setattr(M, "_hub_fail", {})
    monkeypatch.setattr(M, "_gated", {"me/tiny": False})

    def read(rid, revision, token, deadline_s):
        calls.append(rid)
        if rid == "me/down":
            raise M.HubUnreachable("huggingface.co did not answer within 30s for me/down")
        return cfg, heads
    monkeypatch.setattr(M, "_read_hub_headers", read)
    a = M.open("me/tiny")
    b = M.open("me/tiny")
    assert calls == ["me/tiny"] and a is not b and a.root is None
    assert len(a.plan().__dict__) and a.plan().total_gb == b.plan().total_gb
    out = plan(Recipe("me/h", base="me/tiny"), device="mac16")
    assert out["gated"] is False and out["sizeGb"] > 0 and calls == ["me/tiny"]
    with pytest.raises(M.HubUnreachable):
        M.open("me/down")
    down = plan(Recipe("me/d", base="me/down"), device="mac16")      # remembered: no second wait
    assert calls == ["me/tiny", "me/down"]
    assert "cannot reach huggingface.co" in down["problems"][0]["message"] and down["sizeGb"] is None


# --------------------------------------------------------------------------- bundles


def test_bundle_pins_files_and_runs_through_the_public_hook(tmp_path, model):
    fdir = tmp_path / "functions"
    fdir.mkdir()
    (fdir / "halve.py").write_text("from blackhole_dev import function\n\n"
                                   "@function('halve-test', per='model')\ndef halve(m, by: float = 0.5):\n    return {}\n")
    from blackhole_dev import functions as fns
    fns.load(str(fdir / "halve.py"))
    p = write(tmp_path, "mine.py", "\n".join([
        "from blackhole_dev import function",
        "from blackhole_dev.recipe import Recipe",
        "",
        "@function('inline-test', per='model')",
        "def inline(m):",
        "    return {}",
        "",
        f"recipe = Recipe('me/mine', '0.2.0', base={str(model)!r}, targets={{'architectures': ['moe']}})",
        "ratio = recipe.input('ratio', 'float', default=0.25)",
        "recipe.fn('reap-prune', ratio=ratio)",
        "recipe.fn('halve-test')",
        "recipe.fn('inline-test')",
        ""]))
    out = bundle(p, inputs={"ratio": 0.5})
    man = out["manifest"]
    assert man["format"] == "bhr/1" and man["runner"] == "core" and man["inputs"] == {"ratio": 0.5}
    assert man["stages"] == ["reap_prune", "halve_test", "inline_test"] and man["name"] == "mine"
    origins = {f["name"]: f["origin"] for f in out["functions"]}
    assert origins == {"reap-prune": "builtin", "halve-test": "user", "inline-test": "recipe"}
    with tarfile.open(out["bundle"]) as tf:
        names = sorted(tf.getnames())
        rec = json.loads(tf.extractfile("recipe.json").read())
    assert names == ["functions/halve.py", "manifest.json", "recipe.json", "recipe.py"]
    stages = {s["id"]: s for s in rec["raw"]["stage"]}
    assert stages["halve_test"]["functions"] == ["functions/halve.py"]
    assert stages["inline_test"]["functions"] == ["recipe.py"]
    assert bundle(p, inputs={"ratio": 0.5}, out=tmp_path / "b2.bhr")["manifest"]["files"] == man["files"]

    hook = pytest.importorskip("blackhole_pipeline.recipe")
    man2, files = hook.read_bundle(out["bundle"])
    assert man2["files"] == man["files"]
    # a pipeline recipe: config.json for the TUI job, stage list in recipe order
    q = write(tmp_path, "pipe.py", "\n".join([
        "from blackhole_dev.recipe import Recipe",
        "recipe = Recipe('me/pipe', base='Qwen/Qwen3-30B-A3B', meta={'target': 'mac16'})",
        "prune = recipe.input('prune', 'float', default=0.25)",
        "recipe.step('pipeline.reap', prune=prune, calib='code')",
        "recipe.step('pipeline.heal', heal_minutes=30)",
        "recipe.step('pipeline.mlx', mlx_hex=1)",
        "recipe.step('pipeline.package')",
        ""]))
    b = bundle(q, inputs={"prune": 0.375}, with_plan=False)
    assert b["manifest"]["stages"] == ["detect", "plan", "weights", "calibrate", "score", "prune", "eval", "heal", "mlx",
                                       "package"]
    job = tmp_path / "job"
    cfg = hook.prepare(job, b["bundle"])
    assert cfg["model"] == "Qwen/Qwen3-30B-A3B" and cfg["target"] == "mac16" and cfg["purpose"] == ""
    assert cfg["steps"][0] == {"kind": "reap", "params": {"prune": 0.375, "calib": "code"}}
    assert json.loads((job / "config.json").read_text()) == cfg
    assert (job / "recipe" / "recipe.py").read_text() == q.read_text()
    from blackhole_pipeline.job import params
    assert params(cfg)["prune"] == 0.375 and params(cfg)["heal_minutes"] == 30 and params(cfg)["mlx_hex"] == 1
    # tampering is refused
    bad = tmp_path / "bad.bhr"
    with tarfile.open(b["bundle"]) as tf:
        members = {m.name: tf.extractfile(m).read() for m in tf.getmembers()}
    members["recipe.json"] = members["recipe.json"].replace(b"code", b"chat")
    import io
    with tarfile.open(bad, "w:gz") as tf:
        for n, d in members.items():
            ti = tarfile.TarInfo(n)
            ti.size = len(d)
            tf.addfile(ti, io.BytesIO(d))
    with pytest.raises(hook.RecipeBundleError, match="does not match"):
        hook.read_bundle(bad)


def test_fallbacks_match_the_pipeline_package():
    hook = pytest.importorskip("blackhole_pipeline.recipe")
    import importlib
    import blackhole_dev.recipe.pipeline as pl
    raw = {"stage": [{"kind": "pipeline.reap"}, {"kind": "job.fn", "id": "distil", "fn": "distil"},
                     {"kind": "pipeline.mlx"}]}
    names = ("blackhole_pipeline", "blackhole_pipeline.recipe")
    saved = {n: sys.modules.get(n) for n in names}
    for n in names:
        sys.modules[n] = None                         # import blocked: the fallback branch runs
    try:
        fb = importlib.reload(pl)
        assert not fb.HAVE_PIPELINE
        assert fb.stage_list(raw) == hook.stage_list(raw)
        assert fb.PIPELINE_STEPS == hook.PIPELINE_STEPS and fb.ALWAYS_FIRST == hook.ALWAYS_FIRST
    finally:
        sys.modules.update(saved)
        importlib.reload(pl)
    assert pl.HAVE_PIPELINE


# --------------------------------------------------------------------------- the helper over stdio


def rpc(cwd: Path, *msgs: dict) -> list[dict]:
    lines = "".join(json.dumps({"jsonrpc": "2.0", **m}) + "\n" for m in msgs)
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.rpc"], input=lines, capture_output=True, text=True,
                       cwd=cwd, timeout=120)
    assert p.returncode == 0, p.stderr
    return [json.loads(x) for x in p.stdout.splitlines()]


def test_helper_speaks_json_rpc(tmp_path, model):
    write(tmp_path, "demo.py", "\n".join([
        "from blackhole_dev.recipe import Recipe",
        f"recipe = Recipe('me/demo', base={str(model)!r})",
        "prune = recipe.input('prune', 'float', default=0.5)",
        "recipe.step('pipeline.reap', prune=prune)",
        "print('ZZSTRAYZZ on stdout')",
        ""]))
    out = rpc(tmp_path,
              {"id": 1, "method": "initialize", "params": {"workspace": str(tmp_path), "recipesDir": str(tmp_path / "recipes")}},
              {"id": 2, "method": "recipe.lint", "params": {"path": "recipes/demo.py"}},
              {"id": 3, "method": "recipe.lint", "params": {"path": "recipes/demo.py", "text": "recipe = (\n"}},
              {"id": 4, "method": "recipe.steps", "params": {"path": "recipes/demo.py"}},
              {"id": 5, "method": "recipe.plan", "params": {"path": "recipes/demo.py", "device": "mac16"}},
              {"id": 6, "method": "anatomy.open", "params": {"model": str(model)}},
              {"id": 7, "method": "anatomy.summary", "params": {}},
              {"id": 8, "method": "anatomy.get", "params": {"query": "layers.1.moe.experts.2"}},
              {"id": 9, "method": "anatomy.open", "params": {"model": str(tmp_path / "nope")}},
              {"id": 10, "method": "recipe.plan", "params": {"path": "recipes/demo.py", "text": "x = 1\n"}},
              {"id": 11, "method": "functions.list", "params": {}},
              {"id": 12, "method": "no.such"},
              {"id": 13, "method": "shutdown"})
    res = {m["id"]: m for m in out if "id" in m}
    assert [m for m in out if "ZZSTRAYZZ" in json.dumps(m)] == []
    assert "recipe.plan" in res[1]["result"]["methods"]
    assert res[2]["result"]["problems"] == []
    assert res[3]["result"]["problems"][0]["code"] == "syntax"
    assert res[4]["result"]["steps"][0] == {"name": "reap", "fn": "pipeline.reap", "kind": "pipeline",
                                           "detail": "REAP drops ${inputs.prune} of routed experts", "line": 4,
                                           "user": False}
    assert res[5]["result"]["fits"] is True and res[5]["result"]["steps"][0]["sim"] == "simulated"
    assert res[6]["result"]["kind"] == "moe" and res[6]["result"]["layers"] == 3
    assert res[7]["result"]["expertsPerLayer"] == 6 and res[7]["result"]["tree"][1]["lazy"] is True
    assert res[8]["result"]["kind"] == "expert" and res[8]["result"]["insert"] == 'm["layers[1].moe.experts[2]"]'
    assert res[9]["error"]["code"] == -32002
    assert res[10]["error"]["code"] == -32001 and res[10]["error"]["data"]["problems"][0]["code"] == "recipe.none"
    assert any(f["name"] == "reap-prune" for f in res[11]["result"])
    assert res[12]["error"]["code"] == -32601 and res[13]["result"] == {}
    assert any(m.get("method") == "progress" and m["params"]["requestId"] == 5 for m in out)


def test_lint_takes_a_functions_file_as_clean_and_still_flags_a_file_with_neither(tmp_path):
    from blackhole_dev.recipe.lint import lint
    f = tmp_path / "my_quant.py"
    f.write_text('from blackhole_dev import function\n\n\n@function("my-quant-x", per="model")\n'
                 'def my_quant_x(m, bits: int = 4):\n    return m\n')
    assert lint(f) == (None, [])
    g = tmp_path / "nothing.py"
    g.write_text("x = 1\n")
    assert [p["code"] for p in lint(g)[1]] == ["recipe.none"]
