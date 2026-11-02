"""harness-test (serve the packaged build on the VM and try it): the build lookup, the answer
checks and log parsing on plain inputs, and the whole job function through blackhole_dev.jobctx
as the VM runs it, with a fake `vllm` (an OpenAI-compatible server), a fake nvidia-smi and a
fake blackhole_runtime converter in place of the GPU pieces."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from blackhole_dev.functions_src import _bench, harness_test as ht

ROOT = Path(__file__).resolve().parents[1]


def test_answer_checks_and_log_parsing(tmp_path):
    assert ht.judge("391", r"\b391\b") == (True, "ok")
    assert ht.judge("", None)[0] is False
    assert ht.judge("the the the " * 30, None) == (False, "repeats itself")
    assert ht.judge("It is 390.", r"\b391\b")[0] is False
    log = "INFO Model loading took 9.25 GiB and 31.2 seconds\nINFO Available KV cache memory: 150.50 GiB\n"
    mem = ht.server_memory(log)
    assert mem["weights_gb"] == pytest.approx(9.93, abs=0.01) and mem["kv_cache_gb"] == pytest.approx(161.6, abs=0.1)
    assert "max_model_len" in ht.explain("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate")
    assert "installer" in ht.explain("ValueError: Unknown quantization method: blackhole-hex")
    assert len(ht.read_prompts("")) == len(ht.SMOKE)
    assert ht.read_prompts("hello\n\nbye") == [("hello", None), ("bye", None)]
    f = tmp_path / "p.jsonl"
    f.write_text('{"prompt": "2+2?", "expect": "4"}\n')
    assert ht.read_prompts(str(f)) == [("2+2?", "4")]


def _folder(p: Path, cfg: dict) -> Path:
    p.mkdir(parents=True)
    (p / "config.json").write_text(json.dumps(cfg))
    (p / "model.safetensors").write_bytes(b"\0" * 1000)
    return p


def test_build_kinds(tmp_path):
    assert ht.kind_of(_folder(tmp_path / "a", {"model_type": "qwen3_5_moe", "hex": {"0": 8},
                                               "quantization": {"group_size": 64, "bits": 3}})) == "mlx-hex"
    assert ht.kind_of(_folder(tmp_path / "b", {"quantization": {"group_size": 64, "bits": 4}})) == "mlx"
    assert ht.kind_of(_folder(tmp_path / "c", {"quantization_config": {"quant_method": "blackhole-hex"}})) == "vllm-hex"
    assert ht.kind_of(_folder(tmp_path / "d", {"quantization_config": {"quant_method": "compressed-tensors"}})) == "hf"


def test_vllm_is_found_in_the_installers_venv(tmp_path, monkeypatch):
    monkeypatch.delenv("BLACKHOLE_VLLM", raising=False)
    monkeypatch.delenv("BLACKHOLE_VLLM_PY", raising=False)
    exe = tmp_path / "bh" / "vllm" / "bin" / "vllm"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    monkeypatch.setenv("BLACKHOLE_HOME", str(tmp_path / "bh"))
    assert _bench.vllm_exe() == str(exe)
    assert _bench.server_cmd("vllm", Path("/m"), 1, "x")[0] == str(exe)
    monkeypatch.setenv("BLACKHOLE_VLLM", "/opt/v/bin/vllm")
    assert _bench.vllm_exe() == "/opt/v/bin/vllm"


# --------------------------------------------------------------------------- the job function

FAKE_VLLM = r'''
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
a = sys.argv[1:]
assert a[0] == "serve", a
path, name, port = a[1], a[a.index("--served-model-name") + 1], int(a[a.index("--port") + 1])
cfg = json.load(open(path + "/config.json"))
with open(path + "/../served.txt", "a") as f:
    f.write(json.dumps({"path": path, "argv": a}) + "\n")
if "--fail" in a:
    print("torch.OutOfMemoryError: CUDA out of memory.", flush=True)
    sys.exit(1)
print("INFO Model loading took 1.50 GiB and 2.0 seconds", flush=True)
print("INFO Available KV cache memory: 10.00 GiB", flush=True)

def answer(q):
    if "17 * 23" in q: return "391"
    if "capital of France" in q: return "Paris"
    if "is_palindrome" in q: return "def is_palindrome(s):\n    t = [c.lower() for c in s if c.isalpha()]\n    return t == t[::-1]"
    return "A mixture-of-experts model routes each token to a few expert networks. Only those run, so it is fast."

class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def do_GET(self):
        self._json({"data": [{"id": name}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["model"] == name and body["stream"]
        if self.path.endswith("/chat/completions"):
            assert body["chat_template_kwargs"] == {"enable_thinking": False}
            words = answer(body["messages"][-1]["content"]).split(" ")
            evs = [{"choices": [{"delta": {"content": w + (" " if i < len(words) - 1 else "")}}]} for i, w in enumerate(words)]
            evs.append({"choices": [{"delta": {}, "finish_reason": "stop"}]})
            evs.append({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": len(words)}})
        else:
            n = body["max_tokens"]
            evs = [{"choices": [{"text": "x"}]} for _ in range(n)]
            evs.append({"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": n}})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for e in evs:
            time.sleep(0.002)
            self.wfile.write(("data: " + json.dumps(e) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
    def _json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

time.sleep(1.0)    # a server takes a moment to come up
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
'''

FAKE_VERIFY = r'''
import json, shutil, sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
shutil.copytree(src, dst)
cfg = json.loads((dst / "config.json").read_text())
for k in ("hex", "quantization", "expert_tiers"):
    cfg.pop(k, None)
cfg["quantization_config"] = {"quant_method": "blackhole-hex", "version": 1}
(dst / "config.json").write_text(json.dumps(cfg))
print(json.dumps({"ok": True}))
'''


def _script(p: Path, body: str) -> Path:
    p.write_text(f"#!{sys.executable}\n" + body)
    p.chmod(0o755)
    return p


@pytest.fixture
def vm(tmp_path):
    """A pretend GPU VM: fake vllm / nvidia-smi on PATH, a fake blackhole_runtime, a job whose
    package step left an MLX HEX build named in receipt.json."""
    pytest.importorskip("blackhole_pipeline")
    from blackhole_dev.recipe.lint import lint
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    _script(bin_ / "vllm", FAKE_VLLM)
    _script(bin_ / "nvidia-smi", "print(2048)\n")
    (bin_ / "python").symlink_to(sys.executable)
    rt = tmp_path / "pkgs" / "blackhole_runtime"
    rt.mkdir(parents=True)
    (rt / "__init__.py").write_text("")
    (rt / "verify.py").write_text(FAKE_VERIFY)
    (rt / "vllm_hex.py").write_text("")
    models = tmp_path / "models"
    build = _folder(models / "qwen-tiny-MLX-0GB", {"model_type": "qwen3_5_moe", "hex": {"0": 8},
                                                  "quantization": {"group_size": 64, "bits": 3}})
    r, probs = lint(ROOT / "recipes" / "examples" / "harness_test.py")
    assert not [p for p in probs if p["severity"] == "error"], probs
    port = _bench.free_port()
    job = tmp_path / "bh" / "test"
    (job / "recipe").mkdir(parents=True)
    raw = r.to_raw()
    raw["stage"][0].update(port=port, timeout_min=1, concurrency=2)
    raw["stage"].append({**raw["stage"][0], "id": "stop_after", "port": _bench.free_port(), "keep_serving": 0})
    raw["stage"].append({**raw["stage"][0], "id": "oom", "port": _bench.free_port(), "keep_serving": 0,
                         "serve_args": "--fail", "model": str(models / "qwen-tiny-MLX-0GB-vllm")})
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({
        "model": "Qwen/Qwen3-30B-A3B", "schema": raw["id"], "target": "", "purpose": "", "steps": [],
        "inputs": {"model": "packaged", "keep_serving": 1, "min_ok": 4}}))
    (job / "receipt.json").write_text(json.dumps({"model": str(build)}))
    env = {**os.environ, "PATH": f"{bin_}{os.pathsep}{os.environ['PATH']}", "BLACKHOLE_VLLM": str(bin_ / "vllm"),
           "PYTHONPATH": os.pathsep.join([str(tmp_path / "pkgs"), *filter(None, [os.environ.get("PYTHONPATH")])]),
           "BLACKHOLE_HOME": str(tmp_path / "bhhome"), "REAPER_HOME": str(tmp_path / "home"),
           "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "no-user-functions"), "HF_HUB_OFFLINE": "1"}
    pids = []
    yield {"job": job, "env": env, "build": build, "models": models, "port": port, "pids": pids, "cwd": tmp_path}
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass


def _run(vm, sid):
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(vm["job"]), "--stage", sid],
                       env=vm["env"], cwd=vm["cwd"], capture_output=True, text=True, timeout=300)
    evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{") and '"status"' in x]
    return p, evs


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:   # a zombie is not alive
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except OSError:
        return True


def test_packaged_hex_build_is_served_tested_and_left_up(vm):
    p, evs = _run(vm, "vm_test")
    assert p.returncode == 0, p.stdout[-4000:] + p.stderr[-4000:]
    assert evs[-1]["status"] == "done" and evs[-1].get("gate") != "failed", evs[-1]
    work = vm["job"] / "reaper" / "work"
    res = json.loads((work / "harness-test.json").read_text())
    srv = json.loads((work / "harness" / "server.json").read_text())
    vm["pids"].append(srv["pid"])
    # the MLX HEX export was converted next to itself, and vLLM got the converted folder
    conv = vm["models"] / "qwen-tiny-MLX-0GB-vllm"
    assert json.loads((conv / "config.json").read_text())["quantization_config"]["quant_method"] == "blackhole-hex"
    assert not (vm["build"] / "config.json").read_text().count("blackhole-hex")      # the build is untouched
    served = [json.loads(x) for x in (vm["models"] / "served.txt").read_text().splitlines()]
    assert served[-1]["path"] == str(conv) and "--reasoning-parser" in served[-1]["argv"]
    assert res["from"] == "receipt.json" and res["smoke_passed"] == res["smoke_total"] == 4
    assert res["decode_tok_s"] > 0 and res["throughput_tok_s"] > 0 and res["ttft_ms"] >= 0
    assert res["weights_gb"] == pytest.approx(1.61, abs=0.01) and res["kv_cache_gb"] == pytest.approx(10.74, abs=0.01)
    assert res["gpu_peak_gb"] == 2.0 and res["serving"] is True
    assert "391" in (work / "harness-test.md").read_text()
    assert "External server" in p.stdout and f"kill {srv['pid']}" in p.stdout
    # left up for chat; a second run reuses that server instead of starting another
    assert _alive(srv["pid"])
    p, evs = _run(vm, "vm_test")
    assert p.returncode == 0, p.stdout[-3000:] + p.stderr[-3000:]
    assert "reusing the vLLM copy" in p.stdout and "already served on port" in p.stdout
    assert len((vm["models"] / "served.txt").read_text().splitlines()) == 1


def test_keep_serving_0_stops_the_server_and_errors_are_explained(vm):
    p, evs = _run(vm, "stop_after")
    assert p.returncode == 0, p.stdout[-3000:] + p.stderr[-3000:]
    res = json.loads((vm["job"] / "reaper" / "work" / "harness-test.json").read_text())
    assert res["serving"] is False and "server_pid" not in res
    served = json.loads((vm["models"] / "served.txt").read_text().splitlines()[-1])
    port = int(served["argv"][served["argv"].index("--port") + 1])
    time.sleep(0.5)
    with pytest.raises(OSError):
        _bench.served_models(f"http://127.0.0.1:{port}/v1", timeout=1.0)
    # vLLM dying on start: a clear reason and the log tail, not a hang
    p, evs = _run(vm, "oom")
    assert p.returncode != 0
    assert "out of memory" in (p.stdout + p.stderr) and "max_model_len" in (p.stdout + p.stderr)


def test_clear_errors_without_a_gpu_or_for_plain_mlx(vm, tmp_path):
    env = {**vm["env"], "PATH": os.environ["PATH"]}      # no fake nvidia-smi
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(vm["job"]), "--stage", "vm_test"],
                       env=env, cwd=vm["cwd"], capture_output=True, text=True, timeout=300)
    if subprocess.run(["which", "nvidia-smi"], capture_output=True).returncode != 0:
        assert p.returncode != 0 and "needs an NVIDIA GPU" in p.stdout + p.stderr
    plain = _folder(tmp_path / "plain-mlx", {"quantization": {"group_size": 64, "bits": 4}})
    (vm["job"] / "receipt.json").write_text(json.dumps({"model": str(plain)}))
    p, _ = _run(vm, "vm_test")
    assert p.returncode != 0 and "plain MLX folder" in p.stdout + p.stderr
