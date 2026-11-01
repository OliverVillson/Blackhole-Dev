"""Benchmark functions (kl-eval, speed-bench, external-bench, recipes/examples/benchmarks.py):
score parsing and the KL measure on plain inputs, the endpoint timer against a fake
OpenAI-compatible server, and the three job functions run through blackhole_dev.jobctx on a
tiny random Qwen3 as the VM would."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from blackhole_dev.functions_src import _bench

ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- scores

def test_scores_from_harness_results():
    assert _bench.score_from_json({"a": True, "b": False, "c": True, "d": True})[0] == 0.75
    assert _bench.score_from_json({"a": {"resolved": True}, "b": {"resolved": False}})[0] == 0.5
    assert _bench.score_from_json([{"id": 1, "resolved": True}, {"id": 2, "resolved": False}])[0] == 0.5
    assert _bench.score_from_json({"resolved": 12, "total": 48})[0] == 0.25
    assert _bench.score_from_json({"resolved": ["x", "y"], "submitted": 8})[0] == 0.25
    assert _bench.score_from_json({"pass@1": 41.5})[0] == pytest.approx(0.415)
    assert _bench.score_from_json({"accuracy": 0.6})[0] == 0.6
    assert _bench.score_from_json({"results": {"gsm8k": {"exact_match": 0.31}}}, "results.gsm8k.exact_match")[0] == 0.31
    assert _bench.score_from_json({"resolved": 12})[0] is None           # a count with no total says nothing
    rx = _bench.PRESETS["generic"]["regex"]
    assert _bench.score_from_text("warmup\nscore: 0.2\n...\npass@1 = 37.5%\n", rx) == pytest.approx(0.375)
    assert _bench.score_from_text("nothing here", rx) is None
    assert _bench.score_from_text("2/9 resolved\n9/48 resolved (18.8%), 1 errored", _bench.PRESETS["swebench-pro"]["regex"]) \
        == pytest.approx(9 / 48)
    assert _bench.fill("run --model {model} --out {out}", model="a b", out="/x") == "run --model 'a b' --out /x"


# --------------------------------------------------------------------------- the KL measure

def test_kl_is_zero_against_itself_and_grows_with_noise():
    torch = pytest.importorskip("torch")

    class LM(torch.nn.Module):
        def __init__(self, noise=0.0):
            super().__init__()
            g = torch.Generator().manual_seed(0)
            self.emb = torch.nn.Embedding(50, 50)
            self.emb.weight.data = torch.randn(50, 50, generator=g) * 3 + noise * torch.randn(50, 50)

        def get_input_embeddings(self):
            return self.emb

        def forward(self, input_ids, use_cache=False):
            return type("O", (), {"logits": self.emb(input_ids)})()

    data = [torch.randint(0, 50, (2, 16), generator=torch.Generator().manual_seed(i)) for i in range(3)]
    refs = _bench.teacher_ref(LM(), data)
    same = _bench.compare(LM(), refs)
    assert abs(same["kl"]) < 1e-6 and same["top1_agreement"] == 1.0
    assert same["ppl_student"] == pytest.approx(same["ppl_teacher"], rel=1e-5) and same["tokens"] == 3 * 2 * 15
    torch.manual_seed(1)
    off = _bench.compare(LM(noise=2.0), refs)
    assert off["kl"] > 0.01 and off["top1_agreement"] < 1.0


# --------------------------------------------------------------------------- the endpoint timer

class _Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self._send(200, {"data": [{"id": "fake-model"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["stream"] and body["model"] == "fake-model"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        n = body["max_tokens"]
        for i in range(n):
            self.wfile.write(f'data: {json.dumps({"choices": [{"text": f" t{i}"}]})}\n\n'.encode())
        self.wfile.write(f'data: {json.dumps({"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": n}})}\n\n'.encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


@pytest.fixture
def fake_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


def test_endpoint_speed_against_a_fake_server(fake_server):
    assert _bench.served_models(fake_server) == ["fake-model"]
    res = _bench.endpoint_speed(fake_server, "fake-model", ["a", "b", "c"], 12, concurrency=2)
    assert res["requests"] == 3 and res["completion_tokens"] == 3 * 11 and res["prompt_tokens"] == 21
    assert res["decode_tok_s"] > 0 and res["throughput_tok_s"] > 0 and res["ttft_ms_median"] >= 0


def test_server_commands():
    v = _bench.server_cmd("vllm", Path("/m"), 8001, "flint", "--max-model-len 65536")
    assert v[:3] == ["vllm", "serve", "/m"] and "--served-model-name" in v and v[-2:] == ["--max-model-len", "65536"]
    m = _bench.server_cmd("mlx", Path("/m"), 8002, "flint")
    assert "mlx_lm.server" in m and "--prompt-concurrency" in m
    with pytest.raises(ValueError):
        _bench.server_cmd("ollama", Path("/m"), 1, "x")


# --------------------------------------------------------------------------- the job functions

def _tiny(path: Path) -> Path:
    torch = pytest.importorskip("torch")
    transformers = pytest.importorskip("transformers")
    rp = pytest.importorskip("reaper_pipeline")
    sys.path.insert(0, str(Path(rp.__file__).resolve().parents[1] / "tests"))
    from tiny_moe import tokenizer
    tok = tokenizer()
    torch.manual_seed(0)
    hf = transformers.Qwen3ForCausalLM(transformers.Qwen3Config(
        vocab_size=len(tok), hidden_size=64, num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2,
        intermediate_size=128, head_dim=16))
    hf.save_pretrained(path)
    tok.save_pretrained(path)
    return path


TEXTS = [f"def fix(bug{i}): return bug.trace() # debugging python code error stack {i}" for i in range(40)]

FAKE_HARNESS = """import json, sys
out, model = sys.argv[1], sys.argv[2]
json.dump({"i1": True, "i2": False, "i3": True, "i4": True}, open(out + "/results.json", "w"))
print("served model", model)
print("3/4 resolved (75.0%), 0 errored")
"""


def test_the_recipe_runs_as_job_functions(tmp_path, fake_server):
    pytest.importorskip("blackhole_pipeline")
    torch = pytest.importorskip("torch")
    from blackhole_dev.recipe.lint import lint
    r, probs = lint(ROOT / "recipes" / "examples" / "benchmarks.py")
    assert not [p for p in probs if p["severity"] == "error"], probs
    assert r.runner == "pipeline"
    base = _tiny(tmp_path / "qwen3-tiny")
    student = tmp_path / "qwen3-noisy"
    import transformers
    hf = transformers.AutoModelForCausalLM.from_pretrained(base)
    with torch.no_grad():
        for p in hf.parameters():
            p.add_(0.05 * torch.randn_like(p))
    hf.save_pretrained(student)
    transformers.AutoTokenizer.from_pretrained(base).save_pretrained(student)
    harness = tmp_path / "harness.py"
    harness.write_text(FAKE_HARNESS)
    calib = tmp_path / "calib.txt"
    calib.write_text("\n\n".join(TEXTS))

    job = tmp_path / "bh" / "bench"
    (job / "recipe").mkdir(parents=True)
    raw = r.to_raw()
    for st in raw["stage"]:          # the tiny settings, and the fake endpoint in place of vLLM
        if st["id"] == "kl":
            st.update(n_tokens=1024, seq_len=64, batch_size=4)
        if st["id"] == "speed":
            st.update(serve="", prompts=2, prompt_tokens=16, max_tokens=4)
        if st["id"] == "external":
            st.update(serve="", url=fake_server, served_model="fake-model", result="{out}/results.json")
    raw["stage"].append({"id": "speed-url", "kind": "job.fn", "fn": "speed-bench", "url": fake_server,
                         "prompts": 3, "max_tokens": 5})
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({
        "model": str(base), "schema": raw["id"], "target": "", "purpose": "", "steps": [],
        "inputs": {"model": str(student), "calib": str(calib), "n_tokens": 1024, "max_kl": 10.0,
                   "harness": f"{sys.executable} {harness} {{out}} {{model}}", "preset": "swebench-pro"}}))
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "BLACKHOLE_HOME": str(tmp_path / "bhhome"),
           "REAPER_HOME": str(tmp_path / "home"), "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions"),
           "CUDA_VISIBLE_DEVICES": ""}
    out = {}
    for sid in ("kl", "speed", "speed-url", "external"):
        p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", sid],
                           env=env, cwd=tmp_path, capture_output=True, text=True, timeout=600)
        assert p.returncode == 0, (sid, p.stdout[-3000:] + p.stderr[-3000:])
        evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
        assert evs[-1]["status"] == "done" and evs[-1].get("gate") != "failed", (sid, evs[-1])
        out[sid] = json.loads((job / "reaper" / "work" / f"fn-{sid}.json").read_text())["result"]
    assert out["kl"]["kl"] > 0 and 0 <= out["kl"]["top1_agreement"] <= 1 and out["kl"]["tokens"] > 0
    assert out["speed"]["decode_tok_s"] > 0 and out["speed"]["completion_tokens"] == 2 * 3
    assert out["speed-url"]["requests"] == 3 and out["speed-url"]["completion_tokens"] == 3 * 4
    assert out["external"]["resolved"] == 0.75 and out["external"]["instances"] == 4
    work = job / "reaper" / "work"
    assert json.loads((work / "external-swebench-pro.json").read_text())["score"] == 0.75
    assert "fake-model" in (work / "external" / "swebench-pro" / "run.log").read_text()

    # a KL over the gate stops the run with exit 3
    cfg = json.loads((job / "config.json").read_text())
    cfg["inputs"]["max_kl"] = 0.0
    (job / "config.json").write_text(json.dumps(cfg))
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", "kl"],
                       env=env, cwd=tmp_path, capture_output=True, text=True, timeout=600)
    assert p.returncode == 3 and '"gate": "failed"' in p.stdout
