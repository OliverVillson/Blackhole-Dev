"""What blackhole_dev needs to know about the real pipeline (public harness/blackhole_pipeline).

The source of truth is blackhole_pipeline.recipe (it reads the bundles on the VM). When that
package is not installed next to blackhole_dev, the small fallbacks below keep lint, plan
and bundling working; tests check that both agree.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

try:
    from blackhole_pipeline import DEFAULTS
except ImportError:  # the pipeline package is not installed here: pipeline params go unchecked
    DEFAULTS = None
try:
    from blackhole_pipeline.recipe import ALWAYS_FIRST, FORMAT, PIPELINE_STEPS, stage_list, write_bundle
    HAVE_PIPELINE = True
except ImportError:  # a pipeline without --recipe support (or none)
    HAVE_PIPELINE = False
    FORMAT = "bhr/1"
    PIPELINE_STEPS = ("reap", "heal", "gptq", "reaq", "mlx", "qheal", "bench", "quant", "package")
    ALWAYS_FIRST = ["detect", "plan", "weights", "calibrate"]

    def stage_list(raw: dict) -> list[str]:
        out = list(ALWAYS_FIRST)
        for st in raw.get("stage") or []:
            op = str(st.get("kind", "")).split("@")[0]
            if op == "pipeline.reap":
                out += ["score", "prune", "eval"]
            elif op.startswith("pipeline."):
                out.append(op.split(".", 1)[1])
            else:
                out.append(st.get("id") or op.split(".")[0])
        return out

    def write_bundle(path, files: dict[str, bytes], manifest: dict) -> str:
        manifest = {**manifest, "format": FORMAT,
                    "files": {n: hashlib.sha256(b).hexdigest() for n, b in sorted(files.items())}}
        members = {"manifest.json": (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode(), **files}
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tf:
                for name in sorted(members):
                    data = members[name]
                    ti = tarfile.TarInfo(name)
                    ti.size, ti.mtime, ti.mode = len(data), 0, 0o644
                    tf.addfile(ti, io.BytesIO(data))
        Path(path).write_bytes(buf.getvalue())
        return hashlib.sha256(buf.getvalue()).hexdigest()

# canonical order of the pipeline's own stages (recipes may reorder; lint warns)
CANON = ["reap", "heal", "gptq", "reaq", "mlx", "qheal", "bench", "quant", "package"]


def param_names() -> set[str] | None:
    """Params a pipeline.* step may set: DEFAULTS keys + REAPer Config fields + purpose.
    None when the pipeline is not installed here (params are then not checked)."""
    if DEFAULTS is None:
        return None
    names = set(DEFAULTS) | {"purpose"}
    try:
        from dataclasses import fields

        from reaper_pipeline.job import Config
        names |= {f.name for f in fields(Config)}
    except ImportError:
        names |= {"calib", "max_seq", "teacher_backend", "answer_max_tokens", "calib_samples"}
    return names
