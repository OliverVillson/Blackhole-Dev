"""Analysis (plots and stats as named scripts), the read budget, and model forks."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from tinyckpt import tiny_moe  # noqa: E402

import blackhole_dev  # noqa: E402
from blackhole_dev import analysis as an  # noqa: E402
from blackhole_dev.fork import fork, fork_plan, lineage, models, parent_changed  # noqa: E402

CHARTS = {"line", "bar", "hist", "heatmap", "scatter"}


@pytest.fixture
def model(tmp_path):
    return tiny_moe(tmp_path / "models" / "tiny")


@pytest.fixture(autouse=True)
def _no_workspace():
    an.set_workspace(None)
    an.refresh()
    yield
    an.set_workspace(None)
    an.refresh()


def test_every_builtin_runs_and_reads_what_it_estimated(model):
    m = blackhole_dev.open(model)
    m.set_scores(1, [0.1, 0.5, 0.2, 0.9, 0.3, 0.4], [0.1, 0.3, 0.1, 0.3, 0.1, 0.1])
    for name, a in an.registry().items():
        if a.needs == "none" or name == "compare":
            continue
        est = an.estimate(a, m, {})
        assert est["known"], name
        out = an.run(name, m)
        kinds = {b["kind"] for b in out["blocks"]}
        assert kinds & (CHARTS | {"tiles", "table"}), name
        assert out["reads"] <= est["bytes"], (name, out["reads"], est["bytes"])
        json.dumps(out, allow_nan=False)                     # the app gets strict JSON


def test_layer_stats_sampled_and_exact(model):
    m = blackhole_dev.open(model)
    exact = an.run("layer-stats", m, {"metric": "rms", "sample": 0})
    line = next(b for b in exact["blocks"] if b["kind"] == "line")
    assert {s["name"] for s in line["series"]} == {"attention", "experts", "shared", "router"}
    assert line["x"] == [0, 1, 2]
    with pytest.raises(ValueError):
        an.run("layer-stats", m, {"metric": "nope"})
    with pytest.raises(KeyError):
        an.run("layer-stats", m, {"bogus": 1})


def test_read_budget_stops_before_the_read(model):
    m = blackhole_dev.open(model)
    with pytest.raises(an.ReadBudgetExceeded) as e:
        an.run("weight-histogram", m, {"sample": 0}, budget=1000)
    assert e.value.used <= 1000 and e.value.budget == 1000
    assert an.run("overview", m, budget=0)["reads"] == 0          # headers only


def test_workspace_override_fork_and_plain_script(model, tmp_path):
    ws = tmp_path / "ws"
    an.set_workspace(ws)
    f = an.fork("overview")
    assert f["overrides"] and Path(f["path"]).parent == ws / "analysis"
    Path(f["path"]).write_text(Path(f["path"]).read_text().replace('title="Overview"', 'title="Mine"'))
    an.refresh()
    assert an.get("overview").title == "Mine"
    assert next(r for r in an.rows() if r["name"] == "overview")["origin"] == "override"
    g = an.fork("expert-stats", new_name="my-experts")
    an.refresh()
    assert "my-experts" in an.registry() and an.get("expert-stats").layer == an.BUILTIN
    (ws / "analysis" / "broken.py").write_text("raise RuntimeError('x')\n")
    assert an.refresh()[0]["file"].endswith("broken.py")
    m = blackhole_dev.open(model)
    plain = tmp_path / "plain.py"
    plain.write_text("r.title('Norms')\nr.tiles([('layers', len(m.layers))])\n"
                     "r.line('n', range(3), {'a': [1, 2, float('nan')]})\n")
    out = an.run_file(plain, m)
    assert out["title"] == "Norms" and out["metrics"] == {"layers": 3}
    assert out["blocks"][1]["series"][0]["values"] == [1, 2, None]
    deco = tmp_path / "deco.py"
    deco.write_text("from blackhole_dev.analysis import analysis\n"
                    "@analysis('tmp-one', needs='weights')\n"
                    "def run(r, m, k: int = 2):\n    r.tiles([('k', k * 2), ('rms', r.sampled(m['experts'])['rms'])])\n")
    out = an.run_file(deco, m, {"k": "5"})
    assert out["name"] == "tmp-one" and out["metrics"]["k"] == 10 and out["reads"] > 0
    assert "tmp-one" not in an.registry()                       # a run file does not stay registered
    assert g["name"] == "my-experts"


def test_fork_links_records_parent_and_diffs(model):
    plan = fork_plan(model)
    assert plan["copyBytes"] < plan["weightBytes"]
    f = fork(model, name="hot")
    root = Path(f["path"])
    rec = json.loads((root / "blackhole-fork.json").read_text())
    assert rec["parent"] == str(Path(model).resolve()) and rec["mode"] in ("link", "symlink")
    assert json.loads((root / "blackhole-lineage.json").read_text())["steps"][-1]["uses"] == "fork"
    fm = blackhole_dev.open(root)
    out = an.run("compare", fm)                              # a fork compares with its parent by default
    tiles = {t["label"]: t["value"] for b in out["blocks"] if b["kind"] == "tiles" for t in b["items"]}
    assert tiles["Tensors changed"] == 0 and out["reads"] == 0  # linked files are known identical, unread
    fm.layers[1].moe.experts[2].roles["down"].scale(0.5)
    fm.save(root)
    assert (root / "blackhole-fork.json").is_file()           # save keeps the fork receipt
    assert parent_changed(root) is False
    out = an.run("compare", blackhole_dev.open(root), {"sample": 0})
    top = next(b for b in out["blocks"] if b.get("title") == "Most changed tensors")
    assert top["rows"][0][0] == "model.layers.1.mlp.experts.2.down_proj.weight"
    assert pytest.approx(top["rows"][0][1]) == 1.0
    fm = blackhole_dev.open(root)
    fm.layers[0].moe.drop([1])
    fm.save(root, force=True)                                # uneven expert counts: fine for a diff
    out = an.run("compare", blackhole_dev.open(root))
    assert any(b["kind"] == "text" and "layer 0" in b["text"] for b in out["blocks"])
    top = next(b for b in out["blocks"] if b.get("title") == "Most changed tensors")
    assert not any(".layers.0.mlp.experts." in row[0] for row in top["rows"])
    chain = lineage(root)
    assert [x["name"] for x in chain] == ["hot", "tiny"] and chain[0]["edits"] >= 1
    f2 = fork(root, name="hot")                              # a free name next to it
    assert Path(f2["path"]).name == "hot-2" and lineage(f2["path"])[1]["name"] == "hot"
    names = {x["name"]: x for x in models([Path(model).parent])}
    assert names["hot-2"]["parent"] == str(root.resolve()) and names["tiny"]["parent"] is None


def test_job_results_reads_events_and_bench(tmp_path):
    job = tmp_path / "job"
    (job / "out" / "bench" / "mlx").mkdir(parents=True)
    (job / "events.log").write_text("\n".join([
        "starting",
        json.dumps({"stage": "distil", "status": "running", "msg": "distil step 10: held-out KL 0.030 (start 0.05)"}),
        json.dumps({"stage": "distil", "status": "running", "kl": 0.021, "step": 20}),
        json.dumps({"stage": "distil", "status": "done", "kl": 0.02, "size_gb": 9.8}),
        "{not json"]))
    (job / "out" / "bench" / "mlx" / "summary.json").write_text(json.dumps(
        {"bench": "LiveCodeBench v6", "problems": 10, "pass@1": 0.6,
         "by_difficulty": {"easy": {"pass@1": 0.9}, "hard": {"pass@1": 0.3}}}))
    out = an.run("job-results", None, {"folder": str(job)})
    kl = next(b for b in out["blocks"] if b.get("title") == "Held-out KL")
    assert kl["x"] == [10, 20] and kl["series"][0]["values"] == [0.03, 0.021]
    assert out["metrics"]["size_gb"] == 9.8 and out["metrics"]["LiveCodeBench v6 pass@1"] == 0.6


def rpc(cwd: Path, *msgs: dict) -> list[dict]:
    lines = "".join(json.dumps({"jsonrpc": "2.0", **m}) + "\n" for m in msgs)
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.rpc"], input=lines, capture_output=True, text=True,
                       cwd=cwd, timeout=120)
    assert p.returncode == 0, p.stderr
    return [json.loads(x) for x in p.stdout.splitlines()]


def test_helper_analysis_and_fork_methods(tmp_path, model):
    out = rpc(tmp_path,
              {"id": 1, "method": "initialize", "params": {"workspace": str(tmp_path), "modelsDir": str(Path(model).parent)}},
              {"id": 2, "method": "analysis.list", "params": {}},
              {"id": 3, "method": "analysis.estimate", "params": {"name": "layer-stats", "model": str(model)}},
              {"id": 4, "method": "analysis.run", "params": {"name": "layer-stats", "model": str(model), "budget": 10}},
              {"id": 5, "method": "analysis.run", "params": {"name": "overview", "model": str(model)}},
              {"id": 6, "method": "model.fork", "params": {"src": str(model), "name": "f"}},
              {"id": 7, "method": "model.list", "params": {}},
              {"id": 8, "method": "analysis.fork", "params": {"name": "overview"}},
              {"id": 9, "method": "analysis.list", "params": {}},
              {"id": 10, "method": "analysis.run", "params": {"name": "overview"}},
              {"id": 11, "method": "shutdown"})
    res = {m["id"]: m for m in out if "id" in m}
    assert "analysis.run" in res[1]["result"]["methods"]
    assert {"overview", "compare", "job-results"} <= {a["name"] for a in res[2]["result"]["analyses"]}
    assert res[3]["result"]["known"] and res[3]["result"]["bytes"] > 10
    assert res[4]["error"]["code"] == -32004 and res[4]["error"]["data"]["budget"] == 10
    assert res[5]["result"]["reads"] == 0 and res[5]["result"]["model"] == str(model)
    assert Path(res[6]["result"]["path"]).name == "f"
    assert {x["name"] for x in res[7]["result"]["models"]} == {"tiny", "f"}
    assert res[8]["result"]["path"].startswith(str(tmp_path / "analysis"))
    assert next(a for a in res[9]["result"]["analyses"] if a["name"] == "overview")["origin"] == "override"
    assert res[10]["error"]["code"] == -32002                   # no model open, none named
