"""Model forks: a copy of a model folder to edit and analyse, with a receipt naming its parent.

    from blackhole_dev.fork import fork, lineage
    f = fork("~/BlackHole-Dev/models/qwen3.6-blackhole", name="hot-experts-x0.9")
    m = blackhole_dev.open(f["path"]); m["experts[rank>0.9]"].scale(0.9); m.save(f["path"])
    lineage(f["path"])          # [this fork, its parent, the parent's parent, ...]

mode="link" (the default) hard-links the weight files, so a fork costs no disk and no time;
on another file system it falls back to symlinks. That is safe with this API, because
Model.save() writes new files and swaps the folder; it never writes into a weight file. A tool
that edits safetensors files IN PLACE would change the parent too: use mode="copy" for that.
Small files (config, tokenizer, receipts) are always copied.

The receipt, blackhole-fork.json:
  {"format": "bh-fork/1", "name", "parent": <abs path>, "parent_name", "created_at", "mode",
   "files": {file: {"bytes", "header_sha256"}}}
header_sha256 fingerprints each weight file's safetensors header (a few KB, read at fork
time), so a diff can tell later whether the parent's files are still the ones forked.
The fork also appends {"uses": "fork", "parent": ...} to blackhole-lineage.json. Model.save()
carries blackhole-fork.json along, so a saved fork stays a fork of the same parent.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import time
from pathlib import Path

FORK_FILE = "blackhole-fork.json"
WEIGHTS = (".safetensors",)


def _header_sha(p: Path) -> str:
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        return hashlib.sha256(f.read(n)).hexdigest()


def _weight_files(root: Path) -> list[Path]:
    return sorted(p for p in root.iterdir() if p.is_file() and p.name.endswith(WEIGHTS))


def fork_plan(src: str | Path, mode: str = "link") -> dict:
    """What fork() will do, without doing it: bytes to copy (0 when linking)."""
    root = Path(src).expanduser().resolve()
    if not (root / "config.json").is_file():
        raise FileNotFoundError(f"{root} is not a model folder (no config.json)")
    w = _weight_files(root)
    wb = sum(p.stat().st_size for p in w)
    small = sum(p.stat().st_size for p in root.iterdir() if p.is_file() and p not in w)
    return {"src": str(root), "files": len(w), "weightBytes": wb, "copyBytes": small + (wb if mode == "copy" else 0),
            "mode": mode}


def _free_name(parent: Path, stem: str) -> Path:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-") or "fork"
    dst, n = parent / stem, 2
    while dst.exists():
        dst, n = parent / f"{stem}-{n}", n + 1
    return dst


def fork(src: str | Path, name: str | None = None, dst: str | Path | None = None, mode: str = "link",
         note: str = "") -> dict:
    """Fork the model folder `src` into `dst` (default: next to it, named `name`)."""
    if mode not in ("link", "copy"):
        raise ValueError("mode is link or copy")
    root = Path(src).expanduser().resolve()
    if not (root / "config.json").is_file():
        raise FileNotFoundError(f"{root} is not a model folder (no config.json); download it first")
    name = name or f"{root.name}-fork"
    out = Path(dst).expanduser() if dst else _free_name(root.parent, name)
    if out.exists():
        raise FileExistsError(f"{out} exists")
    tmp = out.with_name(out.name + ".forking")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    used = mode
    files = {}
    try:
        for p in sorted(root.iterdir()):
            if not p.is_file():
                continue
            q = tmp / p.name
            if p.name.endswith(WEIGHTS):
                files[p.name] = {"bytes": p.stat().st_size, "header_sha256": _header_sha(p)}
                if mode == "link":
                    try:
                        os.link(p, q)
                    except OSError:
                        os.symlink(p, q)
                        used = "symlink"
                else:
                    shutil.copy2(p, q)
            elif p.name != FORK_FILE:
                shutil.copy2(p, q)
        parent_fork = _read(root / FORK_FILE)
        rec = {"format": "bh-fork/1", "name": out.name, "parent": str(root),
               "parent_name": (parent_fork or {}).get("name") or root.name,
               "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "mode": used, "note": note,
               "files": files}
        (tmp / FORK_FILE).write_text(json.dumps(rec, indent=2) + "\n")
        lin = _read(root / "blackhole-lineage.json") or {"base": _base_of(root), "steps": []}
        lin["steps"] = list(lin.get("steps") or []) + [{"uses": "fork", "parent": str(root), "name": out.name,
                                                        "at": rec["created_at"]}]
        (tmp / "blackhole-lineage.json").write_text(json.dumps(lin, indent=2) + "\n")
        tmp.rename(out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"path": str(out), "name": out.name, "parent": str(root), "mode": used, "files": len(files)}


def _read(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text()) if p.is_file() else None
    except (OSError, json.JSONDecodeError):
        return None


def _base_of(root: Path) -> str:
    rec = _read(root / "blackhole-anatomy.json")
    return (rec or {}).get("base") or root.name


def info(path: str | Path) -> dict:
    """One model folder as the app lists it: name, parent (if a fork), edits so far, size."""
    root = Path(path).expanduser()
    f = _read(root / FORK_FILE)
    rec = _read(root / "blackhole-anatomy.json")
    size = 0
    for p in root.iterdir():
        if p.is_file() and p.name.endswith(WEIGHTS):
            try:
                size += p.stat().st_size
            except OSError:
                pass
    out = {"path": str(root), "name": root.name, "parent": f.get("parent") if f else None,
           "forkedAt": f.get("created_at") if f else None, "mode": f.get("mode") if f else None,
           "edits": len((rec or {}).get("edits") or []), "base": (rec or {}).get("base"), "sizeBytes": size}
    if f:
        out["parentChanged"] = parent_changed(root, f)
    return out


def parent_changed(root: Path, f: dict | None = None) -> bool | None:
    """True when the parent's weight files are no longer the ones forked (None: parent gone)."""
    f = f or _read(Path(root) / FORK_FILE) or {}
    parent = Path(f.get("parent") or "")
    if not parent.is_dir():
        return None
    for name, row in (f.get("files") or {}).items():
        p = parent / name
        if not p.is_file() or p.stat().st_size != row.get("bytes") or _header_sha(p) != row.get("header_sha256"):
            return True
    return False


def lineage(path: str | Path, limit: int = 32) -> list[dict]:
    """This model, its parent, the parent's parent, ... (stops at a folder that is no fork)."""
    out, seen = [], set()
    cur: Path | None = Path(path).expanduser().resolve()
    while cur is not None and cur.is_dir() and str(cur) not in seen and len(out) < limit:
        seen.add(str(cur))
        row = info(cur)
        out.append(row)
        cur = Path(row["parent"]) if row["parent"] else None
    return out


def models(dirs) -> list[dict]:
    """Every model folder (a config.json and weights) directly under `dirs`, forks included."""
    out = []
    for d in dirs:
        d = Path(d).expanduser()
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.is_dir() and (p / "config.json").is_file() and not p.name.endswith((".tmp", ".forking")):
                try:
                    out.append(info(p))
                except OSError:
                    continue
    return out
