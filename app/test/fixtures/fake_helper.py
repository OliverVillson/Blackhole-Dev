"""Stand-in for `python -m blackhole_dev.rpc`, speaking I1 with fixed answers.

Used by the shell's tests and for UI screenshots until the real helper ships. Not product code.
"""
import json
import os
import re
import sys

STATE = {"model": None}
BUILTINS = [
    ("reap-score", "model", "Router-weighted expert saliency (REAP) on calibration text."),
    ("reap-prune", "model", "Drop the lowest-ranked experts per layer."),
    ("reaq", "model", "Give experts bit widths from their REAP rank at a fixed average."),
    ("hex-quantize", "part", "Header-Encoded eXperts: learned value tables, FP8 block scales."),
    ("hex-pack", "model", "Pack HEX experts into the runtime layout."),
    ("merge-similar-experts", "model", "Merge experts whose outputs agree."),
    ("prune-neurons", "part", "Drop MLP neurons with the lowest saliency."),
    ("distil", "job", "Shortest verified trace distillation with on-policy rounds."),
    ("qheal", "job", "Heal around frozen low-bit experts after quantization."),
    ("bench", "job", "LiveCodeBench v6 with thinking budgets."),
]


def steps_of(text, path):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        m = re.search(r"recipe\.(fn|step|edit|eval)\(\s*(?:\[\{\"fn\":\s*)?\"?([\w.\-]*)", line)
        if m:
            kind, name = m.group(1), m.group(2) or m.group(1)
            user = os.path.exists(os.path.join(os.path.dirname(os.path.dirname(path)), "functions", name.replace("-", "_") + ".py"))
            out.append({"name": name if kind != "eval" else "eval", "fn": name or kind, "kind": "function" if kind in ("fn", "edit") else "op",
                        "detail": kind, "line": i, "user": user})
    return out


def lint(params):
    text = params.get("text")
    if text is None:
        text = open(params["path"]).read()
    problems = []
    try:
        compile(text, params["path"], "exec")
    except SyntaxError as e:
        problems.append({"severity": "error", "message": e.msg, "file": params["path"], "line": e.lineno or 1, "col": e.offset or 1, "code": "syntax"})
    if "Recipe(" not in text:
        problems.append({"severity": "error", "message": "no Recipe defined in this file", "file": params["path"], "line": 1, "code": "recipe.none"})
    return text, problems


def handle(method, params):
    if method == "initialize":
        return {"version": "0.1.0-fake", "python": sys.version.split()[0], "methods": ["recipe.lint", "recipe.plan", "recipe.steps"]}
    if method == "shutdown":
        return None
    if method == "recipe.lint":
        return {"problems": lint(params)[1]}
    if method == "recipe.steps":
        text, _ = lint(params)
        base = re.search(r"base=\"([^\"]+)\"", text)
        doc = re.match(r'\s*"""(.*?)"""', text, re.S)
        return {"base": base.group(1) if base else "", "target": "mac16", "doc": doc.group(1).strip() if doc else "", "steps": steps_of(text, params["path"])}
    if method == "recipe.devices":
        return {"devices": [{"id": "mac16", "label": "M-series 16 GB", "memGb": 16}, {"id": "b300", "label": "1x B300", "memGb": 288}]}
    if method == "recipe.plan":
        text, problems = lint(params)
        mac = params.get("device") == "mac16"
        return {
            "rows": [
                {"label": "experts", "value": "128 -> 96 per layer (-25%)"},
                {"label": "expert bits", "value": "HEX 16-level on top 10% · 8-level on the rest · avg 3.25 bpw"},
                {"label": "size", "value": "9.8 GB  from 61 GB bf16 · 6.2x smaller"},
                {"label": "fits", "value": "✓ M-series 16 GB (12 GB wired) with 32k context" if mac else "✓ 1x B300", "tone": "ok"},
                {"label": "est. VM time", "value": "~3 h on 1x B300"},
            ],
            "sizeGb": 9.8, "fits": True, "kvGb": 1.5, "estHours": 3.0, "problems": problems, "steps": steps_of(text, params["path"]),
        }
    if method == "recipe.bundle":
        # a real .bhr (gzip tar: manifest.json + recipe.py) so the VM module can send and check it
        import hashlib, io, tarfile, tempfile, time
        name = os.path.basename(params["path"]).rsplit(".", 1)[0]
        stages = ["detect", "plan", "weights", "calibrate", "score", "prune", "eval", "heal", "mlx", "qheal", "bench", "package"]
        manifest = {"format": "bhr/1", "name": name, "id": "blackhole/" + name, "version": "1.0.0", "base_model": "Qwen/Qwen3-30B-A3B",
                    "target": "mac16", "runner": "pipeline", "stages": stages, "inputs": {"speed": float(os.environ.get("FAKE_SPEED", "0.3"))},
                    "needs": {"gpu_gb": 160, "disk_gb": 20}, "blackhole_dev_version": "0.1.0", "files": {}, "functions": []}
        out = os.path.join(tempfile.gettempdir(), f"{name}-{int(time.time() * 1000)}.bhr")
        with tarfile.open(out, "w:gz") as t:
            for fname, data in (("manifest.json", json.dumps(manifest).encode()), ("recipe.py", open(params["path"], "rb").read())):
                info = tarfile.TarInfo(fname)
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        sha = hashlib.sha256(open(out, "rb").read()).hexdigest()
        return {"bundle": out, "sha256": sha, "functions": [], "manifest": manifest}
    if method == "functions.list":
        return [{"name": n, "per": p, "origin": "builtin", "path": "builtin/" + n, "doc": d} for n, p, d in BUILTINS]
    if method == "functions.source":
        n = params["name"]
        return {"path": "builtin/" + n, "readonly": True, "text": f'"""{n} (built-in source)."""\nfrom blackhole_dev import function\n\n\n@function("{n}")\ndef run(m, **kw):\n    return m\n'}
    if method == "anatomy.open":
        STATE["model"] = params["model"]
        return {"id": "m1", "name": params["model"].split("/")[-1], "layers": 48, "kind": "moe", "summary": "48 layers"}
    if method == "anatomy.summary":
        import math
        layers = [{"path": f"layers[{i}]", "label": f"layer {i}", "kind": "moe", "children": [
            {"path": f"layers[{i}].attn", "label": "attention", "kind": "attn"},
            {"path": f"layers[{i}].moe.router", "label": "router", "kind": "router"},
            {"path": f"layers[{i}].moe.experts", "label": "experts (128)", "kind": "experts", "lazy": True}]} for i in range(48)]
        return {"name": (STATE["model"] or "?").split("/")[-1], "kind": "moe", "layers": 48, "expertsPerLayer": 128, "topK": 8,
                "layerScores": [0.18 + 0.25 * abs(math.sin(i * 1.7)) + (0.12 if i > 36 else 0) for i in range(48)], "tree": layers}
    if method == "anatomy.get":
        q = params["query"]
        return {"path": "m." + q, "kind": "part", "rows": [["REAP rank", "0.71 · kept"], ["format", "hex3 (8-level)"], ["roles", "gate · up · down"]], "insert": f'm["{q}"]'}
    if method == "crash":
        os._exit(3)
    raise KeyError(method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if "id" not in msg:
            continue
        sys.stderr.write(f"fake helper: {msg['method']}\n")
        try:
            res = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg["method"], msg.get("params") or {})}
        except KeyError as e:
            res = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": f"method not found: {e}"}}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()
        if msg["method"] == "shutdown":
            break


if __name__ == "__main__":
    main()
