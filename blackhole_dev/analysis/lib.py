"""Helpers the built-in analyses share (and user analyses may import): sampled weight stats,
read-cost estimates, the parts of a layer, job folders, and model-vs-model diffs."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable

import numpy as np

from blackhole.anatomy import st
from blackhole_dev import sources
from blackhole_dev.parts import Stats, View

# ------------------------------------------------------------------ views and sampling


def views_of(parts) -> list[View]:
    """The weight matrices (2-D and up, or expert rows) of parts / views / a selection;
    norms and biases are left out."""
    if isinstance(parts, View):
        parts = [parts]
    out = []
    for p in parts:
        vs = [p] if isinstance(p, View) else list(p.views)
        out += [v for v in vs if len(v.shape) >= 2]
    return out


def _row_index(n: int, rows: int) -> np.ndarray | None:
    if rows <= 0 or n <= rows:
        return None
    return np.unique(np.linspace(0, n - 1, rows).round().astype(np.int64))


def sample(v: View, rows: int = 256) -> np.ndarray:
    """`rows` evenly spaced rows of a weight matrix (all of it when rows <= 0 or it is small),
    read without touching the rest of the tensor."""
    idx = _row_index(v.shape[0], rows) if v.shape else None
    if idx is None:
        return v.numpy()
    if v.index is None:
        return v.source.read((idx,))
    if v.row is not None:
        return v.source.read((v.row, idx))
    return v.numpy()[idx]


def sample_bytes(v: View, rows: int = 256) -> int:
    n = v.numel * st.BITS[v.dtype] // 8
    if not v.shape or rows <= 0 or v.shape[0] <= rows:
        return n
    return n * len(_row_index(v.shape[0], rows)) // v.shape[0]


def cost(parts, rows: int = 256) -> int:
    return sum(sample_bytes(v, rows) for v in views_of(parts))


def sampled_stats(parts, rows: int = 256) -> dict:
    """Stats (mean, std, rms, absmax, kurtosis, crest, zero_frac, ...) over sampled rows of
    every weight matrix of `parts`. rows <= 0 reads everything (exact)."""
    s = Stats()
    for v in views_of(parts):
        s.add(sample(v, rows))
    return s.result()


def sampled_values(parts, rows: int = 256, cap: int = 4_000_000, seed: int = 0) -> np.ndarray:
    """The sampled weights as one float32 array (for histograms), at most `cap` values."""
    chunks = [sample(v, rows).ravel() for v in views_of(parts)]
    a = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    if a.size > cap:
        a = np.random.default_rng(seed).choice(a, cap, replace=False)
    return a.astype(np.float32, copy=False)


# ------------------------------------------------------------------ the parts of a layer


def layer_groups(L) -> dict[str, list]:
    """A layer's parts by kind: attention, mixer, mlp, experts, shared, router."""
    g: dict[str, list] = {}
    if L.attn is not None:
        g["attention"] = [L.attn]
    if L.mixer is not None:
        g["mixer"] = [L.mixer]
    if L.mlp is not None:
        g["mlp"] = [L.mlp]
    if L.moe is not None:
        g["experts"] = list(L.moe.experts)
        if L.moe.shared is not None:
            g["shared"] = [L.moe.shared]
        g["router"] = [L.moe.router]
    return g


GROUP_ORDER = ("attention", "mixer", "mlp", "experts", "shared", "router")


def has_scores(m) -> bool:
    return any(e.attrs.get("score") is not None for L in m.layers if L.moe is not None for e in L.moe.experts)


# ------------------------------------------------------------------ job folders

HELD_OUT = re.compile(r"(?:^|\s)(?:(\S[^:]*?)\s+)?step\s+(\d+)(?:/\d+)?:\s*held-out KL\s+([0-9]*\.?[0-9]+)", re.I)


def find_job(folder: str | Path) -> dict:
    """What a job folder (or a pulled model folder) holds: events.log, config.json, bench
    summaries, the anatomy receipt and metrics.json files."""
    root = Path(folder).expanduser()
    if not root.is_dir():
        raise FileNotFoundError(f"{root} is not a folder")
    cands = [root, root.parent] if root.name == "out" else [root, root / "out"]
    ev = next((c / "events.log" for c in cands if (c / "events.log").is_file()), None)
    benches = []
    for p in sorted(root.glob("**/summary.json")):
        if len(p.relative_to(root).parts) > 5:
            continue
        try:
            s = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(s, dict) and "pass@1" in s:
            benches.append({"path": str(p), "name": str(p.parent.relative_to(root)), **s})
    receipt = next((json.loads(c.joinpath("blackhole-anatomy.json").read_text()) for c in cands
                    if c.joinpath("blackhole-anatomy.json").is_file()), None)
    cfg = next((json.loads(c.joinpath("config.json").read_text()) for c in cands
                if c.joinpath("config.json").is_file()), None)
    return {"root": str(root), "events": str(ev) if ev else None, "bench": benches, "receipt": receipt,
            "config": cfg}


def read_events(path: str | Path) -> dict:
    """events.log folded: stage rows (status, last pct, result keys), KL points, metrics."""
    stages: dict[str, dict] = {}
    kl: list[dict] = []
    metrics: dict = {}
    skip = {"stage", "status", "ts", "pct", "msg", "outcome"}
    for line in Path(path).read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict) or "stage" not in ev:
            continue
        s = stages.setdefault(ev["stage"], {"stage": ev["stage"], "status": "pending", "first": ev.get("ts"),
                                            "last": ev.get("ts"), "result": {}})
        s["status"] = ev.get("status", s["status"])
        s["last"] = ev.get("ts", s["last"])
        if ev.get("status") == "running" and isinstance(ev.get("kl"), (int, float)) and isinstance(ev.get("step"), int):
            kl.append({"stage": ev["stage"], "step": ev["step"], "kl": float(ev["kl"])})
        elif isinstance(ev.get("msg"), str) and (mm := HELD_OUT.search(ev["msg"])):
            kl.append({"stage": ev["stage"], "step": int(mm.group(2)), "kl": float(mm.group(3))})
        if ev.get("status") == "done":
            for k, v in ev.items():
                if k not in skip and isinstance(v, (int, float, str)) and not isinstance(v, bool):
                    s["result"][k] = v
                    if isinstance(v, (int, float)):
                        metrics[k] = v
    return {"stages": list(stages.values()), "kl": kl, "metrics": metrics}


# ------------------------------------------------------------------ comparing two models


def same_bytes(a: sources.Source, b: sources.Source) -> bool:
    """True when two sources are certainly the same bytes without reading them: the same
    tensor of the same file (a fork's hard link or symlink counts), same rows."""
    if not (isinstance(a, sources.File) and isinstance(b, sources.File)):
        return False
    ea, eb = a.entry, b.entry
    if ea.blob.remote or eb.blob.remote:
        return ea.blob.where == eb.blob.where and ea.offset == eb.offset and a._rows == b._rows
    try:
        same = os.path.samefile(ea.blob.where, eb.blob.where)
    except OSError:
        return False
    return same and ea.offset == eb.offset and ea.dtype == eb.dtype and a._rows == b._rows


def tensor_pairs(a, b) -> dict:
    """Tensors of a and b by name: shared with the same shape, shape changed, only in a, only in b."""
    na, nb = set(a._t), set(b._t)
    both = na & nb
    same_shape = sorted(n for n in both if tuple(a._t[n].shape) == tuple(b._t[n].shape))
    return {"same_shape": same_shape,
            "reshaped": sorted(n for n in both if n not in set(same_shape)),
            "only_a": sorted(na - nb), "only_b": sorted(nb - na)}


def rel_diff(sa: sources.Source, sb: sources.Source, rows: int = 64) -> dict:
    """||a - b|| / ||a|| and cosine on sampled rows (all rows when rows <= 0)."""
    if same_bytes(sa, sb):
        return {"rel_diff": 0.0, "cosine": 1.0, "identical": True}
    idx = _row_index(sa.shape[0], rows) if len(sa.shape) >= 1 else None
    if idx is None:
        x, y = sa.float(), sb.float()
    else:
        x, y = sa.read((idx,)), sb.read((idx,))
    x, y = np.asarray(x, np.float64).ravel(), np.asarray(y, np.float64).ravel()
    nx, ny = float(np.linalg.norm(x)), float(np.linalg.norm(y))
    return {"rel_diff": float(np.linalg.norm(x - y)) / (nx or 1e-30), "cosine": float(x @ y) / ((nx * ny) or 1e-30),
            "identical": False}


def rel_diff_bytes(sa: sources.Source, sb: sources.Source, rows: int = 64) -> int:
    if same_bytes(sa, sb):
        return 0
    n = sa.nbytes + sb.nbytes
    if len(sa.shape) >= 1 and rows > 0 and sa.shape[0] > rows:
        n = n * len(_row_index(sa.shape[0], rows)) // sa.shape[0]
    return n


LAYER_RE = re.compile(r"(?:^|\.)layers\.(\d+)\.")


def layer_of(name: str) -> int | None:
    mm = LAYER_RE.search(name)
    return int(mm.group(1)) if mm else None


def config_diff(a: dict, b: dict, prefix: str = "") -> list[tuple[str, object, object]]:
    out = []
    for k in sorted(set(a) | set(b)):
        va, vb = a.get(k), b.get(k)
        if isinstance(va, dict) and isinstance(vb, dict):
            out += config_diff(va, vb, f"{prefix}{k}.")
        elif va != vb:
            out.append((prefix + k, va, vb))
    return out


def short(v, n: int = 60) -> str:
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= n else s[: n - 1] + "…"


def gb(n: float) -> float:
    return round(n / 1e9, 3)


def pick(seq: Iterable, n: int) -> list:
    seq = list(seq)
    return seq if len(seq) <= n else [seq[i] for i in np.linspace(0, len(seq) - 1, n).round().astype(int)]
