"""Editor language support (blackhole_dev.lang) and its helper methods."""

import io
import json

import pytest

from blackhole_dev import lang
from blackhole_dev.rpc import Helper


def test_catalog_names_everything_a_recipe_uses():
    c = lang.catalog()
    assert {"input", "step", "fn", "edit", "eval"} <= set(c["recipe"]["methods"])
    assert [p["name"] for p in c["recipe"]["methods"]["fn"]["params"]][0] == "name"
    assert "title" in c["recipe"]["fields"] and "base" in c["recipe"]["fields"]
    assert [s["name"] for s in c["pipeline"]["steps"]][:2] == ["reap", "heal"]
    names = {f["name"]: f for f in c["functions"]}
    assert names["reap-prune"]["params"]["ratio"] == {"type": "float", "default": 0.25, "required": False}
    assert "<=" in c["gateOps"] and "float" in c["inputTypes"]
    assert c["query"]["children"]["moe"] == ["router", "experts", "shared"]
    assert any(m["id"].startswith("Qwen/") for m in c["models"])
    json.dumps(c)                                   # everything crosses the wire


def test_pipeline_params_carry_their_comments_and_stage():
    params = lang.catalog()["pipeline"]["params"]
    if not params:
        pytest.skip("blackhole_pipeline not installed")
    assert params["prune"]["stage"] == "reap" and "REAP" in params["prune"]["doc"]
    assert params["mlx_bits"]["stage"] == "mlx"
    assert params["qheal_minutes"]["stage"] == "qheal"


def test_comments_reader():
    src = 'X = {\n    "a": 1,   # first\n    "b": [1, 2],  # second\n    "c": 3,\n}\n'
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(src)
    assert lang._comments(f.name, "X") == {"a": "first", "b": "second"}


jedi = pytest.importorskip("jedi")


def test_jedi_completes_signs_and_explains():
    text = "from blackhole_dev.recipe import Recipe, gate\nrecipe = Recipe('a/b')\nrecipe.st"
    labels = [i["label"] for i in lang.complete(text, 3, 9)["items"]]
    assert "step" in labels and "step_at" in labels
    sig = lang.signatures("from blackhole_dev.recipe import gate\ngate('kl', ", 2, 11)["signatures"][0]
    assert sig["label"].startswith("gate(") and sig["active"] == 1
    assert "gate" in lang.hover("from blackhole_dev.recipe import gate\ngate", 2, 1)["contents"][0]["signature"]


def test_completions_answer_while_a_long_request_runs():
    """lang.complete runs beside the main queue: a slow request does not hold it up."""
    import threading
    h = Helper(out=io.StringIO())
    gate_open = threading.Event()
    h.methods["slow"] = lambda p: gate_open.wait(10) and {}
    lines = [{"jsonrpc": "2.0", "id": 1, "method": "slow", "params": {}},
             {"jsonrpc": "2.0", "id": 2, "method": "lang.complete",
              "params": {"text": "import os\nos.pa", "line": 2, "col": 5}}]

    class Inp:
        def __iter__(self):
            for m in lines:
                yield json.dumps(m) + "\n"
            # wait until the completion answered, then let the slow one finish
            for _ in range(200):
                if '"id": 2' in h.out.getvalue():
                    break
                threading.Event().wait(0.05)
            gate_open.set()
            yield json.dumps({"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": {}}) + "\n"

    h.serve(Inp())
    out = [json.loads(x) for x in h.out.getvalue().splitlines()]
    ids = [m["id"] for m in out]
    assert ids.index(2) < ids.index(1)
    assert "path" in [i["label"] for i in next(m for m in out if m["id"] == 2)["result"]["items"]]
