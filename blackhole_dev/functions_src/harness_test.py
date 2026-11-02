"""Built-in function `harness-test`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork harness-test`, or Fork in
the app's Functions view) to get your own copy in your functions folder; a function there with
the same name replaces this one everywhere, a renamed fork sits next to it. The shared code of
the benchmark functions is blackhole_dev/functions_src/_bench.py."""

from __future__ import annotations

import getpass
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
from pathlib import Path

from blackhole_dev.functions import function
from blackhole_dev.functions_src import _bench

# A few prompts with something to check in the answer (None: any sensible answer will do).
SMOKE = [
    ("What is 17 * 23? Reply with only the number.", r"\b391\b"),
    ("Name the capital of France in one word.", r"(?i)paris"),
    ("Write a Python function is_palindrome(s) that ignores case and every character that is not a "
     "letter. Reply with only the code.", r"def\s+is_palindrome\s*\("),
    ("Explain in two sentences what a mixture-of-experts language model is.", None),
]

MLX_ONLY = ("{path} is a plain MLX folder (no HEX experts), which vLLM cannot load. Chat with it on the Mac "
            "(Chat tab), or point model at the job's int4 / pruned folder, or a HEX build.")


# --------------------------------------------------------------------------- which build

def _cfg(p: Path) -> dict:
    try:
        return json.loads((p / "config.json").read_text())
    except (OSError, ValueError):
        return {}


def kind_of(p: Path) -> str:
    """'mlx-hex' (the pipeline's MLX HEX export: converted for vLLM first), 'mlx' (plain MLX,
    which vLLM cannot load), 'vllm-hex' (a blackhole-hex folder) or 'hf' (anything vLLM loads
    as it is: bf16, GPTQ / compressed-tensors, fp8)."""
    c = _cfg(p)
    if c.get("hex"):
        return "mlx-hex"
    if str((c.get("quantization_config") or {}).get("quant_method", "")).lower() == "blackhole-hex":
        return "vllm-hex"
    if _bench.is_mlx(p):
        return "mlx"
    return "hf"


def find_build(job, model: str) -> tuple[str, Path, str]:
    """(label, folder, where it came from). model = "final" is _bench.resolve's final artefact
    for a vLLM run (the hex-vllm folder, else a HEX MLX export, else int4, healed, pruned,
    original; a plain MLX export is skipped). "packaged" is the same, except that without a
    hex-vllm folder the folder package names in <job>/receipt.json wins when vLLM can serve
    it. Anything else: a job model name (int4, pruned, latest, ...) or a folder."""
    if model in ("", "packaged", "package") and _bench.hex_vllm_dir(job) is None:
        try:
            rec = job.bh.read("receipt.json") or {}
        except Exception:  # noqa: BLE001
            rec = {}
        p = Path(rec["model"]) if rec.get("model") else None
        if p is not None and (p / "config.json").exists() and kind_of(p) != "mlx":
            return p.name, p, "receipt.json"
    if model in ("", "packaged", "package", "final"):
        label, p = _bench.resolve(job, "final", mlx_ok=False)
        return label, p, "final"
    label, p = _bench.resolve(job, model)
    return label, p, "model"


def folder_gb(p: Path) -> float:
    return sum(f.stat().st_size for f in Path(p).resolve().rglob("*") if f.is_file()) / 1e9


# --------------------------------------------------------------------------- the VM side

def _runtime_python() -> str | None:
    """A Python with blackhole_runtime (and the pipeline) for the MLX -> vLLM conversion."""
    if importlib.util.find_spec("blackhole_runtime") is not None:
        return sys.executable
    home = Path(os.environ.get("BLACKHOLE_HOME") or Path.home() / ".blackhole")
    for c in (home / "venv" / "bin" / "python", Path.home() / "bh-venv" / "bin" / "python"):
        if c.is_file():
            return str(c)
    return None


def convert(job, src: Path, verify: bool) -> Path:
    """The MLX HEX export as a blackhole-hex folder for vLLM, next to it as <folder>-vllm (the
    same place harness/scripts/swebench-pro.sh puts it, so either reuses the other's). Built in
    <folder>-vllm.tmp and renamed only when the conversion (and the per-layer check) passed."""
    src = src.resolve()
    dst = src.with_name(src.name + "-vllm")
    if (dst / "config.json").exists() and kind_of(dst) == "vllm-hex" and (not verify or (dst / ".verified").exists()):
        job.log(f"harness-test: reusing the vLLM copy {dst}")
        return dst
    py = _runtime_python()
    if py is None:
        raise RuntimeError("blackhole_runtime is not installed on this machine, so the HEX build cannot be "
                           "converted for vLLM. On the VM run the BlackHole installer again: "
                           "curl -fsSL https://blackholeharness.dev/install.sh | bash")
    need = 2 * folder_gb(src) + 5
    free = shutil.disk_usage(src.parent).free / 1e9
    if free < need:
        raise RuntimeError(f"converting {src.name} for vLLM needs about {need:.0f} GB free next to it, "
                           f"{free:.0f} GB is free on {src.parent}")
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    mod = "blackhole_runtime.verify" if verify else "blackhole_runtime.convert"
    logf = job.path("work", "harness", "convert.log")
    logf.parent.mkdir(parents=True, exist_ok=True)
    job.emit(pct=8, msg=f"converting {src.name} for vLLM" + (" (and checking every layer)" if verify else ""))
    job.log(f"harness-test: {py} -m {mod} {src} {tmp}")
    with open(logf, "w") as f:
        p = subprocess.run([py, "-m", mod, str(src), str(tmp)], stdout=f, stderr=subprocess.STDOUT)
    if p.returncode != 0 or not (tmp / "config.json").exists():
        tail = logf.read_text(errors="ignore")[-1500:]
        raise RuntimeError(f"converting {src.name} for vLLM failed (exit {p.returncode}); "
                           f"full log: {logf}\n{tail}")
    shutil.rmtree(dst, ignore_errors=True)
    tmp.rename(dst)
    if verify:      # the marker harness/scripts/swebench-pro.sh checks before it reuses the folder
        (dst / ".verified").write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")
    return dst


def _plugin_ok(vllm: str) -> str | None:
    """None when the vLLM venv imports the blackhole-hex plugin, else what went wrong."""
    py = Path(vllm).parent / "python"
    if not py.exists():
        return None            # a vllm we cannot introspect: let the server say
    p = subprocess.run([str(py), "-c", "import blackhole_runtime.vllm_hex"], capture_output=True, text=True)
    return None if p.returncode == 0 else (p.stderr.strip().splitlines() or ["import failed"])[-1]


HINTS = [
    (r"(?i)out of memory|CUDA error: out of memory|No available memory for the cache blocks|"
     r"larger than the available KV cache",
     "the GPU ran out of memory: lower max_model_len (e.g. 16384) or raise gpu_mem, and check nothing else "
     "holds the GPU (nvidia-smi; an earlier server: pkill -f 'vllm serve')"),
    (r"(?i)Unknown quantization method|blackhole-hex|No module named .?blackhole_runtime",
     "vLLM does not know the blackhole-hex method: run the BlackHole installer on the VM again "
     "(curl -fsSL https://blackholeharness.dev/install.sh | bash), it installs blackhole_runtime into vLLM's venv"),
    (r"(?i)are not supported for now|not supported by vLLM|Cannot find model module|has no vLLM model",
     "this vLLM has no model class for the architecture: update vLLM (rerun the installer), or test the "
     "int4 / pruned folder instead"),
    (r"(?i)Address already in use", "the port is taken: set port to another number, or stop what runs there"),
    (r"(?i)max_model_len|max_position_embeddings", "lower max_model_len to what the model supports"),
]


def explain(log_text: str) -> str:
    for pat, hint in HINTS:
        if re.search(pat, log_text):
            return hint
    return "see the server log above"


def server_memory(log_text: str) -> dict:
    """Weights and KV cache in GB from vLLM's log (`Model loading took 17.3 GiB ...`,
    `Available KV cache memory: 120.5 GiB`)."""
    out = {}
    m = re.findall(r"Model loading took ([\d.]+) ?GiB", log_text)
    if m:
        out["weights_gb"] = round(float(m[-1]) * 2**30 / 1e9, 2)
    m = re.findall(r"Available KV cache memory: ([\d.]+) ?GiB", log_text)
    if m:
        out["kv_cache_gb"] = round(float(m[-1]) * 2**30 / 1e9, 2)
    return out


def start_server(job, path: Path, name: str, port: int, max_model_len: int, gpu_mem: float,
                 serve_args: str, timeout_min: float, logf: Path, qwen: bool):
    """`vllm serve` for the folder in its own session (so it can outlive the job), on
    127.0.0.1:port; returns the process once /v1/models answers."""
    vllm = _bench.vllm_exe()
    if not vllm:
        raise RuntimeError("vLLM is not installed on this machine. On the VM run the BlackHole installer: "
                           "curl -fsSL https://blackholeharness.dev/install.sh | bash")
    cmd = [vllm, "serve", str(path), "--served-model-name", name, "--host", "127.0.0.1", "--port", str(port),
           "--gpu-memory-utilization", str(gpu_mem), "--trust-remote-code"]
    if max_model_len:
        cmd += ["--max-model-len", str(max_model_len)]
    if qwen and "--reasoning-parser" not in serve_args:
        cmd += ["--reasoning-parser", "qwen3"]
    import shlex
    cmd += shlex.split(serve_args)
    job.log("harness-test: " + " ".join(shlex.quote(c) for c in cmd))
    out = open(logf, "ab")
    proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            start_new_session=True)
    out.close()
    url = f"http://127.0.0.1:{port}/v1"
    t0 = time.time()
    last = 0.0
    while True:
        if proc.poll() is not None:
            text = logf.read_text(errors="ignore")
            tail = "\n".join(text.splitlines()[-30:])
            raise RuntimeError(f"vLLM exited ({proc.returncode}) before it was ready: {explain(text)}.\n"
                               f"Server log {logf}:\n{tail}")
        try:
            _bench.served_models(url, timeout=2.0)
            return proc, url, time.time() - t0
        except (urllib.error.URLError, OSError, ValueError):
            pass
        if time.time() - t0 > timeout_min * 60:
            _bench.stop(proc)
            raise RuntimeError(f"vLLM was not ready after {timeout_min:.0f} minutes; server log: {logf}")
        if time.time() - last > 30:
            last = time.time()
            job.emit(pct=20, msg=f"starting vLLM on {name} ({time.time() - t0:.0f} s)")
        time.sleep(2.0)


# --------------------------------------------------------------------------- the checks

def read_prompts(prompts: str) -> list[tuple[str, str | None]]:
    """The smoke prompts: the built-in ones, or a .txt (one per line) / .jsonl ("prompt" or
    "text", optional "expect" regex) file, or prompts in the text itself, one per line."""
    if not prompts.strip():
        return list(SMOKE)
    p = Path(prompts).expanduser()
    if p.is_file():
        if p.suffix == ".jsonl":
            rows = [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
            return [(r.get("prompt") or r.get("text") or "", r.get("expect")) for r in rows]
        return [(x.strip(), None) for x in p.read_text().splitlines() if x.strip()]
    return [(x.strip(), None) for x in prompts.splitlines() if x.strip()]


def judge(answer: str, expect: str | None) -> tuple[bool, str]:
    """An answer passes when it is not empty, does not loop, and matches `expect` when given."""
    a = answer.strip()
    if not a:
        return False, "empty answer"
    words = a.split()
    if len(words) >= 40 and len(set(words)) / len(words) < 0.15:
        return False, "repeats itself"
    if expect and not re.search(expect, a):
        return False, f"expected /{expect}/"
    return True, "ok"


def tunnel_hint(port: int) -> str:
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001
        user = "USER"
    return (f"on the Mac: ssh -N -L {port}:127.0.0.1:{port} {user}@<VM address>   then in the app: Chat settings > "
            f"External server = http://127.0.0.1:{port}/v1")


@function("harness-test", per="job")
def harness_test(job, model: str = "final", prompts: str = "", max_tokens: int = 512, think: int = 0,
                 concurrency: int = 4, port: int = 8000, keep_serving: int = 1, max_model_len: int = 32768,
                 gpu_mem: float = 0.9, serve_args: str = "", verify: int = 1, url: str = "", served_model: str = "",
                 timeout_min: float = 30.0) -> dict:
    """Serves the packaged build on this GPU machine with vLLM (HEX builds through the
    blackhole-hex kernel of BlackHole-Harness's runtime) and tests it: a few prompts with
    their answers checked, single-stream decode tok/s, time to the first token, throughput
    at `concurrency`, weights / KV-cache / GPU memory, and the size on disk.

    model          "final" (the job's last build vLLM can serve: the hex-vllm folder, else a HEX
                   MLX export, else int4, healed, pruned, original), "packaged" (the same, but
                   the folder package names in receipt.json when there is no hex-vllm folder),
                   a job model name (int4, pruned, ...) or a folder. An MLX HEX export is converted once to <folder>-vllm next to it
                   (verify = 1 also proves every layer equals the Mac's numbers).
    prompts        empty for the built-in smoke prompts, a .txt / .jsonl file, or one prompt per line
    think          1 lets a thinking model think (answers take longer; raise max_tokens)
    keep_serving   1 leaves the server up on 127.0.0.1:`port` after the test so you can chat with
                   it (the log says how); 0 stops it. An earlier server of the same build on that
                   port is reused.
    url            test a server that is already running instead (served_model picks the model)
    Needs an NVIDIA GPU and the BlackHole installer's vLLM venv: the GPU VM, not the Mac.
    Writes work/harness-test.json and work/harness-test.md (every prompt and answer)."""
    hdir = job.path("work", "harness")
    hdir.mkdir(parents=True, exist_ok=True)
    logf = hdir / "vllm.log"
    proc = None
    started = False
    load_s = None
    info: dict = {}

    if url:
        base = url.rstrip("/")
        names = _bench.served_models(base)
        name = served_model or (names or ["default"])[0]
        label, path, where = name, None, "url"
    else:
        label, path, where = find_build(job, model)
        kind = kind_of(path)
        job.log(f"harness-test: testing {path} ({kind}, from {where})")
        if kind == "mlx":
            raise RuntimeError(MLX_ONLY.format(path=path))
        if _bench.gpu_used_gb() is None:
            raise RuntimeError("harness-test serves the build with vLLM and needs an NVIDIA GPU (nvidia-smi found "
                               "none). Run the recipe on the GPU VM (Run on VM); on the Mac, chat with the MLX "
                               "build in the Chat tab instead.")
        info["size_gb"] = round(folder_gb(path), 2)
        serve_dir = convert(job, path, bool(verify)) if kind == "mlx-hex" else path
        if kind in ("mlx-hex", "vllm-hex"):
            vllm = _bench.vllm_exe()
            bad = _plugin_ok(vllm) if vllm else None
            if bad:
                raise RuntimeError(f"vLLM's venv cannot load the blackhole-hex plugin ({bad}). On the VM run the "
                                   "BlackHole installer again: curl -fsSL https://blackholeharness.dev/install.sh | bash")
        name = label
        base = f"http://127.0.0.1:{port}/v1"
        try:
            running = _bench.served_models(base, timeout=2.0)
        except (urllib.error.URLError, OSError, ValueError):
            running = None
        if running is not None:
            if name in running:
                job.log(f"harness-test: {name} is already served on port {port}, reusing that server")
            else:
                raise RuntimeError(f"port {port} already serves {', '.join(running) or 'another model'}. Stop it on "
                                   f"the VM (pkill -f 'vllm serve') or set port to another number.")
        else:
            qwen = str((_cfg(serve_dir).get("text_config") or _cfg(serve_dir)).get("model_type", "")).startswith("qwen3")
            job.emit(pct=15, msg=f"starting vLLM on {name}")
            proc, base, load_s = start_server(job, serve_dir, name, port, max_model_len, gpu_mem, serve_args,
                                              timeout_min, logf, qwen)
            started = True
            info["load_s"] = round(load_s, 1)
            info["serve_dir"] = str(serve_dir)

    peak = {"gb": 0.0}
    done = threading.Event()

    def watch():
        while not done.wait(0.5):
            g = _bench.gpu_used_gb()
            if g:
                peak["gb"] = max(peak["gb"], g)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    rows = []
    finished = False
    try:
        smoke = read_prompts(prompts)
        extra = {} if think else {"chat_template_kwargs": {"enable_thinking": False}}
        for i, (q, expect) in enumerate(smoke):
            job.emit(pct=40 + 30 * i / max(len(smoke), 1), msg=f"prompt {i + 1}/{len(smoke)}")
            r = _bench.stream_chat(base, name, [{"role": "user", "content": q}], max_tokens, extra=extra)
            ok, why = judge(r["text"], expect)
            dec = max(r["total"] - r["ttft"], 1e-9)
            rows.append({"prompt": q, "answer": r["text"], "thinking": r["reasoning"], "ok": ok, "check": why,
                         "tokens": r["tokens"], "ttft_ms": round(1000 * r["ttft"], 1),
                         "tok_s": round(max(r["tokens"] - 1, 0) / dec, 1), "decode_s": dec,
                         "finish_reason": r["finish_reason"]})
            short = " ".join(r["text"].split())[:300]
            job.log(f"harness-test: [{'ok' if ok else why}] {q[:70]}\n    -> {short or '(empty)'}")
        texts = [f"Task {i}. Write a Python function that parses a log file and groups errors. " * 32
                 for i in range(max(concurrency, 1) * 2)]
        job.emit(pct=72, msg="decode speed, one request at a time")
        speed1 = _bench.endpoint_speed(base, name, texts[:2], 256, 1)
        job.emit(pct=80, msg=f"throughput at concurrency {concurrency}")
        speed = _bench.endpoint_speed(base, name, texts, 256, concurrency)
        finished = True
    finally:
        done.set()
        watcher.join(timeout=5)
        if proc is not None and not (keep_serving and finished):    # a failed test never leaves a server up
            _bench.stop(proc)

    if not any(r["answer"].strip() or r["thinking"].strip() for r in rows):
        raise RuntimeError("the server answered every prompt with nothing; see " + str(logf))
    res = {
        "model": label, "from": where,
        "smoke_passed": sum(r["ok"] for r in rows), "smoke_total": len(rows),
        "decode_tok_s": round(speed1["decode_tok_s"], 1) if speed1.get("decode_tok_s") else None,
        "throughput_tok_s": round(speed["throughput_tok_s"], 1) if speed.get("throughput_tok_s") else None,
        "ttft_ms": round(speed1["ttft_ms_median"], 1) if speed1.get("ttft_ms_median") is not None else None,
        "concurrency": concurrency,
        **({"model_dir": str(path)} if path is not None else {}), **info,
        "gpu_peak_gb": round(peak["gb"], 2) or None,
        **(server_memory(logf.read_text(errors="ignore")) if logf.exists() else {}),
        "url": base, "served_model": name,
        "serving": bool((started and keep_serving) or (not started and not url and path is not None)),
        "prompts": rows,
    }
    if started and keep_serving and proc is not None:
        res["server_pid"] = proc.pid
        job.write("work/harness/server.json", {"pid": proc.pid, "url": base, "model": name, "log": str(logf),
                                               "dir": info.get("serve_dir")})
    job.write("work/harness-test.json", res)
    (job.path("work", "harness-test.md")).write_text(report(res))

    mem = ", ".join(f"{k.replace('_gb', '')} {res[k]:.1f} GB" for k in ("weights_gb", "kv_cache_gb", "gpu_peak_gb")
                    if res.get(k))
    job.log(f"harness-test: {label}: {res['smoke_passed']}/{res['smoke_total']} prompts ok, "
            f"{res['decode_tok_s'] or 0:.1f} tok/s single stream, {res['throughput_tok_s'] or 0:.0f} tok/s at "
            f"concurrency {concurrency}, first token {res['ttft_ms'] or 0:.0f} ms" + (f", {mem}" if mem else ""))
    if res["serving"]:
        job.log(f"harness-test: the server stays up at {base} (model {name}). Chat with it {tunnel_hint(port)}. "
                f"Stop it on the VM: " + (f"kill {proc.pid}" if proc is not None else "pkill -f 'vllm serve'"))
    return {k: v for k, v in res.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}


def report(res: dict) -> str:
    """work/harness-test.md: the numbers, then every prompt and answer."""
    lines = [f"# harness-test: {res['model']}", "",
             f"- prompts ok: {res['smoke_passed']}/{res['smoke_total']}",
             f"- decode, one request at a time: {res.get('decode_tok_s')} tok/s; first token {res.get('ttft_ms')} ms "
             "(about 500-token prompts)",
             f"- throughput at concurrency {res.get('concurrency')}: {res.get('throughput_tok_s')} tok/s"]
    for k, what, unit in (("size_gb", "size on disk", " GB"), ("weights_gb", "weights on the GPU", " GB"),
                          ("kv_cache_gb", "KV cache", " GB"),
                          ("gpu_peak_gb", "GPU memory in use (vLLM reserves gpu_mem of the GPU up front)", " GB"),
                          ("load_s", "server start", " s")):
        if res.get(k) is not None:
            lines.append(f"- {what}: {res[k]}{unit}")
    lines.append(f"- served at {res['url']} as {res['served_model']}" + (" (still running)" if res.get("serving") else ""))
    for i, r in enumerate(res["prompts"], 1):
        lines += ["", f"## {i}. {'ok' if r['ok'] else r['check']}", "", f"> {r['prompt']}", "",
                  r["answer"].strip() or "(empty)", "",
                  f"_{r['tokens']} tokens, {r['tok_s']} tok/s, first token {r['ttft_ms']} ms_"]
    return "\n".join(lines) + "\n"
