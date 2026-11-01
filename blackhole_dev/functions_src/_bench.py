"""Shared code of the benchmark functions (kl-eval, speed-bench, external-bench): which model
folder a name means, the pipeline's KL measure, timing a model or an OpenAI-compatible
endpoint, starting a local server for a benchmark, and reading a score out of another
harness's results. A fork may import it or copy it.

Everything here works on plain transformers models, the standard library and an HTTP endpoint,
so it runs on the CPU of any machine (the tests use a tiny random Qwen3 and a fake server) as
well as on the GPU VM, and against a Mac's mlx_lm.server.
"""

from __future__ import annotations

import json
import math
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

TOPK_REF = 20          # the pipeline's KL: teacher's top-20 tokens, both renormalised there
NAMES = ("original", "pruned", "healed", "int4", "reaq", "mlx")


def log(msg: str) -> None:
    print(f"[bench {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- which model

def model_dirs(job) -> dict:
    """The job's model folders by name (a name whose folder has no config.json is left out)."""
    out = {}
    for name in NAMES:
        try:
            p = getattr(job, {"original": "model_dir", "pruned": "pruned_dir", "healed": "healed_dir",
                              "int4": "gptq_dir", "reaq": "reaq_dir", "mlx": "mlx_dir"}[name])
        except Exception:  # noqa: BLE001  (a stage that never ran)
            p = None
        if p is not None and (Path(p) / "config.json").exists():
            out[name] = Path(p)
    return out


def resolve(job, which: str) -> tuple[str, Path]:
    """(label, folder) for a model name of the job, "latest" (healed, else pruned, else the
    original), or a folder path."""
    dirs = model_dirs(job)
    if which in ("", "latest"):
        for name in ("healed", "pruned", "original"):
            if name in dirs:
                return name, dirs[name]
        raise RuntimeError("the job has no model folder yet (run the weights stage first)")
    if which in NAMES:
        if which not in dirs:
            raise RuntimeError(f"the job has no {which} model yet (no config.json in its folder)")
        return which, dirs[which]
    p = Path(which).expanduser()
    if not (p / "config.json").exists():
        raise RuntimeError(f"{which!r} is neither one of {', '.join(NAMES)} nor a model folder with a config.json")
    return p.name, p


def is_mlx(path: Path) -> bool:
    """An MLX folder (what the mlx / qheal stages write), which transformers cannot load."""
    cfg = json.loads((Path(path) / "config.json").read_text())
    q = cfg.get("quantization") or {}
    return bool(q and "group_size" in q) or (Path(path) / "flint_mlx.py").exists()


# --------------------------------------------------------------------------- KL to the base

def load(path, device: str | None = None):
    """A causal LM for scoring: bf16 spread over the GPUs when there are any, else fp32 on the CPU."""
    import torch
    from transformers import AutoModelForCausalLM

    import transformers
    cuda = torch.cuda.is_available() and device != "cpu"
    key = "dtype" if int(transformers.__version__.split(".")[0]) >= 5 else "torch_dtype"
    kw = {key: torch.bfloat16 if cuda else torch.float32, "trust_remote_code": True}
    if cuda:
        kw["device_map"] = device or "auto"
    hf = AutoModelForCausalLM.from_pretrained(str(path), **kw).eval()
    for q in hf.parameters():
        q.requires_grad_(False)
    return hf


def free() -> None:
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _dev(hf):
    return hf.get_input_embeddings().weight.device


def teacher_ref(hf, data, k: int = TOPK_REF) -> list[dict]:
    """Per batch of token ids: the teacher's top-k log-probs at every position but the last,
    and its NLL of the next token. Kept on the CPU so the teacher can be freed before the
    student loads (two big models never share the GPU)."""
    import torch
    out = []
    with torch.no_grad():
        for ids in data:
            lp = hf(input_ids=ids.to(_dev(hf)), use_cache=False).logits[:, :-1].float().log_softmax(-1)
            tgt = ids[:, 1:].to(lp.device)
            v, i = lp.topk(k, dim=-1)
            out.append({"ids": ids.cpu(), "top_v": v.cpu(), "top_i": i.cpu(),
                        "nll": (-lp.gather(-1, tgt[..., None])[..., 0]).sum().item()})
    return out


def compare(hf, refs: list[dict]) -> dict:
    """The pipeline's eval measure of a student against teacher_ref: KL(teacher || student)
    over the teacher's top-k tokens (both renormalised there), top-1 agreement, and both
    perplexities on the same text."""
    import torch
    kl = agree = nll_s = nll_t = 0.0
    n = 0
    with torch.no_grad():
        for r in refs:
            ids = r["ids"]
            lp = hf(input_ids=ids.to(_dev(hf)), use_cache=False).logits[:, :-1].float().log_softmax(-1).cpu()
            tv, ti = r["top_v"], r["top_i"]
            pt = tv.exp()
            pt = pt / pt.sum(-1, keepdim=True)
            ls = lp.gather(-1, ti)
            ls = ls - ls.logsumexp(-1, keepdim=True)
            kl += (pt * (pt.log() - ls)).sum().item()
            agree += (lp.argmax(-1) == ti[..., 0]).sum().item()
            nll_s += -lp.gather(-1, ids[:, 1:, None])[..., 0].sum().item()
            nll_t += r["nll"]
            n += ti.shape[0] * ti.shape[1]
    n = max(n, 1)
    return {"tokens": n, "kl": kl / n, "top1_agreement": agree / n,
            "ppl_teacher": math.exp(nll_t / n), "ppl_student": math.exp(nll_s / n)}


# --------------------------------------------------------------------------- speed, local

def peak_mem_gb() -> float | None:
    """Peak memory of this process so far: the GPU's allocator when on CUDA, else the RSS."""
    try:
        import torch
        if torch.cuda.is_available():
            return sum(torch.cuda.max_memory_allocated(d) for d in range(torch.cuda.device_count())) / 2**30
    except ImportError:
        pass
    try:
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return rss / (2**30 if sys.platform == "darwin" else 2**20)   # bytes on macOS, KiB on Linux
    except Exception:  # noqa: BLE001
        return None


def prompt_ids(tok, n: int, prompt_tokens: int, seed: int = 0) -> list[list[int]]:
    """n prompts of exactly prompt_tokens ids: a fixed coding question repeated, cut to length,
    each with a different opening so a prefix cache cannot answer for the next."""
    base = ("Write a Python function that parses a log file, groups the error lines by their "
            "stack trace, and prints the five most common traces with their counts. ")
    out = []
    for i in range(n):
        ids = tok(f"Task {seed}-{i}. " + base * (1 + prompt_tokens // 16), add_special_tokens=False)["input_ids"]
        out.append(ids[:prompt_tokens])
    return out


def local_speed(hf, tok, prompts: list[list[int]], max_tokens: int) -> dict:
    """Greedy decoding of every prompt with transformers, one at a time: time to the first
    token (the prefill), decode tok/s after it, and peak memory."""
    import torch
    dev = _dev(hf)
    pad = tok.pad_token_id if tok.pad_token_id is not None else (tok.eos_token_id or 0)
    ttft, decode_s, made = [], 0.0, 0
    with torch.no_grad():
        for ids in prompts:
            x = torch.tensor([ids], device=dev)
            t0 = time.perf_counter()
            hf.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=1, min_new_tokens=1,
                        do_sample=False, pad_token_id=pad)
            _sync()
            t1 = time.perf_counter()
            g = hf.generate(input_ids=x, attention_mask=torch.ones_like(x), max_new_tokens=max_tokens,
                            min_new_tokens=max_tokens, do_sample=False, pad_token_id=pad)
            _sync()
            t2 = time.perf_counter()
            new = g.shape[1] - x.shape[1]
            ttft.append(t1 - t0)
            decode_s += max(t2 - t1 - (t1 - t0), 1e-9)   # the full run minus its own prefill
            made += max(new - 1, 0)
    return summarize(ttft, made, decode_s, len(prompts), sum(len(p) for p in prompts)) | {"peak_mem_gb": peak_mem_gb()}


def _sync() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    except ImportError:
        pass


def summarize(ttft: list[float], tokens: int, decode_s: float, requests: int, prompt_tokens: int,
              wall_s: float | None = None) -> dict:
    s = sorted(ttft)
    out = {"requests": requests, "prompt_tokens": prompt_tokens, "completion_tokens": tokens,
           "ttft_ms_median": 1000 * s[len(s) // 2] if s else None,
           "ttft_ms_p90": 1000 * s[min(len(s) - 1, int(0.9 * len(s)))] if s else None,
           "decode_tok_s": tokens / decode_s if decode_s > 0 else None}
    if s:
        out["prefill_tok_s"] = prompt_tokens / max(sum(s), 1e-9)
    if wall_s is not None:
        out["wall_s"] = wall_s
        out["throughput_tok_s"] = tokens / wall_s if wall_s > 0 else None
    return out


# --------------------------------------------------------------------------- speed, endpoint

def _headers(api_key: str = "") -> dict:
    h = {"Content-Type": "application/json"}
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def served_models(url: str, api_key: str = "", timeout: float = 5.0) -> list[str]:
    req = urllib.request.Request(url.rstrip("/") + "/models", headers=_headers(api_key))
    with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310  (the user's own endpoint)
        return [m.get("id") for m in json.loads(r.read()).get("data", [])]


def stream_one(url: str, model: str, prompt: str, max_tokens: int, api_key: str = "",
               timeout: float = 600.0) -> dict:
    """One streamed /completions request: seconds to the first token, total seconds, and the
    completion tokens (the server's usage count when it sends one, else one per chunk)."""
    body = {"model": model, "prompt": prompt, "max_tokens": max_tokens, "temperature": 0.0, "stream": True,
            "stream_options": {"include_usage": True}, "ignore_eos": True}
    req = urllib.request.Request(url.rstrip("/") + "/completions", data=json.dumps(body).encode(),
                                 headers=_headers(api_key), method="POST")
    t0 = time.perf_counter()
    first = None
    chunks = 0
    usage = None
    with urllib.request.urlopen(req, timeout=timeout) as r:   # noqa: S310
        for raw in r:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            ev = json.loads(data)
            if ev.get("usage"):
                usage = ev["usage"]
            for c in ev.get("choices") or []:
                if c.get("text"):
                    chunks += 1
                    if first is None:
                        first = time.perf_counter()
    t1 = time.perf_counter()
    toks = int((usage or {}).get("completion_tokens") or chunks)
    return {"ttft": (first or t1) - t0, "total": t1 - t0, "tokens": toks,
            "prompt_tokens": int((usage or {}).get("prompt_tokens") or 0)}


def endpoint_speed(url: str, model: str, prompts: list[str], max_tokens: int, concurrency: int = 1,
                   api_key: str = "") -> dict:
    """Every prompt through stream_one, `concurrency` at a time: TTFT, per-request decode tok/s
    and the aggregate throughput."""
    from concurrent.futures import ThreadPoolExecutor
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max(1, concurrency)) as ex:
        rs = list(ex.map(lambda p: stream_one(url, model, p, max_tokens, api_key), prompts))
    wall = time.perf_counter() - t0
    made = sum(max(r["tokens"] - 1, 0) for r in rs)
    decode = sum(max(r["total"] - r["ttft"], 1e-9) for r in rs)
    out = summarize([r["ttft"] for r in rs], made, decode, len(rs), sum(r["prompt_tokens"] for r in rs), wall)
    out["concurrency"] = concurrency
    return out


# --------------------------------------------------------------------------- a local server

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def server_cmd(kind: str, path: Path, port: int, name: str, extra: str = "") -> list[str]:
    """The command that serves `path` on an OpenAI-compatible endpoint: vLLM on the GPU VM,
    mlx_lm.server on a Mac (with the settings that fit a 16 GB machine)."""
    if kind == "vllm":
        cmd = ["vllm", "serve", str(path), "--port", str(port), "--served-model-name", name,
               "--trust-remote-code"]
    elif kind == "mlx":
        cmd = [sys.executable, "-m", "mlx_lm.server", "--model", str(path), "--port", str(port),
               "--prompt-concurrency", "1", "--prefill-step-size", "512", "--prompt-cache-size", "2"]
    else:
        raise ValueError(f"serve must be '', 'vllm' or 'mlx', not {kind!r}")
    return cmd + shlex.split(extra)


@contextmanager
def serving(kind: str, path: Path, name: str, extra: str = "", timeout: float = 1800.0, log_path: Path | None = None):
    """Starts a server for the model, waits until /v1/models answers, yields its base URL
    (http://127.0.0.1:PORT/v1) and the process, and stops it afterwards."""
    port = free_port()
    cmd = server_cmd(kind, path, port, name, extra)
    log("serving: " + " ".join(cmd))
    out = open(log_path, "ab") if log_path else subprocess.DEVNULL
    proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    url = f"http://127.0.0.1:{port}/v1"
    try:
        t0 = time.time()
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f"the {kind} server exited ({proc.returncode}) before it was ready"
                                   + (f"; its log: {log_path}" if log_path else ""))
            try:
                served_models(url, timeout=2.0)
                break
            except (urllib.error.URLError, OSError, ValueError):
                if time.time() - t0 > timeout:
                    raise RuntimeError(f"the {kind} server was not ready after {timeout:.0f}s") from None
                time.sleep(2.0)
        yield url, proc
    finally:
        stop(proc)
        if log_path:
            out.close()


def stop(proc) -> None:
    import signal
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=60)
    except Exception:  # noqa: BLE001
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:  # noqa: BLE001
            proc.kill()


def tree_rss_gb(pid: int) -> float | None:
    """Resident memory of a process and its children (psutil when installed, else ps)."""
    try:
        import psutil
        p = psutil.Process(pid)
        return sum(q.memory_info().rss for q in [p, *p.children(recursive=True)]) / 2**30
    except ImportError:
        pass
    except Exception:  # noqa: BLE001
        return None
    try:
        rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,rss="], capture_output=True, text=True, timeout=10).stdout
    except Exception:  # noqa: BLE001
        return None
    kids: dict[int, list] = {}
    rss: dict[int, int] = {}
    for line in rows.splitlines():
        a = line.split()
        if len(a) == 3:
            kids.setdefault(int(a[1]), []).append(int(a[0]))
            rss[int(a[0])] = int(a[2])
    total, todo = 0, [pid]
    while todo:
        q = todo.pop()
        total += rss.get(q, 0)
        todo += kids.get(q, [])
    return total / 2**20 if total else None


def gpu_used_gb() -> float | None:
    """Memory in use on all NVIDIA GPUs (nvidia-smi), or None without one."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10)
    except Exception:  # noqa: BLE001
        return None
    if out.returncode != 0:
        return None
    return sum(float(x) for x in out.stdout.split() if x.strip()) / 1024


# --------------------------------------------------------------------------- other harnesses

PRESETS = {
    # SWE-bench Pro (Scale AI's public set) through BlackHole-Harness's VM script
    # (harness/scripts/swebench-pro.sh): it serves the model itself on 127.0.0.1:8000 (or reuses
    # a server already there; an MLX HEX folder is converted to <folder>-vllm on first use), runs
    # the agent in Docker, re-grades, and writes runs/<name>/results.json = {instance: true|false}.
    # Its last line is `R/T resolved (P%), E errored`. Needs Docker: the GPU VM, not the Mac.
    "swebench-pro": {"command": "bash ~/BlackHole-Harness/harness/scripts/swebench-pro.sh {model_dir} "
                                "--tasks smoke -n {workers} --name {name}",
                     "result": "~/.blackhole/swebench/runs/{name}/results.json", "score_key": "",
                     "regex": r"(\d+)/(\d+) resolved", "metric": "resolved", "serves_itself": True},
    # any harness that prints `score: 0.42` or `pass@1: 42.0%` as its last such line
    "generic": {"command": "", "result": "", "score_key": "",
                "regex": r"(?i)(?:pass@1|accuracy|score|resolved)\s*[:=]\s*([0-9.]+)\s*(%?)",
                "metric": "score", "serves_itself": False},
}

_SCORE_KEYS = ("resolved_rate", "resolve_rate", "pass@1", "accuracy", "score", "resolved")


def _as_rate(v, total=None) -> float | None:
    """A number as a 0..1 rate: a count over `total`, a percentage over 1, or a rate as it is."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, int):
        return v / total if total else (float(v) if v in (0, 1) else None)
    return v / 100 if v > 1 else float(v)


def score_from_json(obj, key: str = "") -> tuple[float | None, dict]:
    """(score as a 0..1 rate, details) from a harness's results JSON:
    a key path (`a.b.c`) when given; else a mapping of instance -> true/false (or ->
    {"resolved": bool}) gives the resolved share; else the first of resolved_rate, pass@1,
    accuracy, score, resolved (a count is divided by `total` / `submitted` when present)."""
    if key:
        v = obj
        for part in key.split("."):
            v = v[int(part)] if isinstance(v, list) else v[part]
        return _as_rate(v), {"key": key}
    if isinstance(obj, dict) and obj and all(isinstance(v, bool) or (isinstance(v, dict) and isinstance(v.get("resolved"), bool))
                                             for v in obj.values()):
        ok = sum(1 for v in obj.values() if (v if isinstance(v, bool) else v["resolved"]))
        return ok / len(obj), {"n_resolved": ok, "instances": len(obj)}
    if isinstance(obj, list) and obj and all(isinstance(v, dict) and "resolved" in v for v in obj):
        ok = sum(1 for v in obj if v["resolved"])
        return ok / len(obj), {"n_resolved": ok, "instances": len(obj)}
    if isinstance(obj, dict):
        total = next((obj[k] for k in ("total", "total_instances", "submitted", "instances") if isinstance(obj.get(k), int)), None)
        for k in _SCORE_KEYS:
            v = obj.get(k)
            if isinstance(v, list):       # e.g. "resolved": [ids]
                if total:
                    return len(v) / total, {"n_resolved": len(v), "instances": total}
                continue
            r = _as_rate(v, total)
            if r is not None:
                return r, {"key": k, **({"instances": total} if total else {})}
    return None, {}


def score_from_text(text: str, regex: str) -> float | None:
    """The last match of `regex` in the text: group 1 is the number, read as a percentage when
    group 2 is "%" or it is over 1; when group 2 is a number, the score is group 1 / group 2."""
    hits = list(re.finditer(regex, text))
    if not hits:
        return None
    m = hits[-1]
    x = float(m.group(1))
    g2 = m.group(2) if (m.lastindex or 0) >= 2 else ""
    if g2 and g2.replace(".", "", 1).isdigit():          # `R/T`: a count over a total
        return x / float(g2) if float(g2) else None
    return x / 100 if g2 == "%" or x > 1 else x


def fill(template: str, **values) -> str:
    """{name} placeholders filled with shell-quoted values; {{ and }} stay literal braces."""
    return template.format(**{k: shlex.quote(str(v)) for k, v in values.items()})
