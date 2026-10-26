"""Helpers the built-in functions share: the HEX layout text, the format marks REAQ leaves on
experts, calibration text loading and a constant tensor for the safetensors writer. A fork may
import them or copy them into its own file."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

LAYOUT = """HEX experts (Header-Encoded eXperts, BlackHole-Harness layout v1; blackhole.anatomy.hex is the source of truth)

Per MoE layer and tier (tier16 = 16-level tables = 4 bits, tier8 = 8-level = 3 bits), for each
projection p in {gate_proj, up_proj, down_proj} (or the checkpoint's own role names for other
layouts), stacked over the n experts of the tier, inputs padded to a multiple of 32:
  <experts>.tier<L>.experts          int32   [n]                    expert ids in this tier
  <experts>.tier<L>.<p>.idx          uint32  [n, out, in/32*bits]   indices, `bits` per weight, one
                                                                    little-endian bit stream per block
                                                                    of 32 inputs (= bits words)
  <experts>.tier<L>.<p>.block_scale  uint8   [n, out, in/32]        fp8 e4m3 scale per block
  <experts>.tier<L>.<p>.expert_scale float32 [n]
  <experts>.tier<L>.<p>.levels       float32 [n, L]                 sorted level table in [-1, 1]
weight[e, o, i] = levels[e, idx[e, o, i]] * fp8(block_scale[e, o, i // 32]) * expert_scale[e]
Everything else (attention, routers, shared experts, embeddings, LM head) is stored as in the
source model. blackhole.anatomy.hex.hex_dequant() (torch) and unpack_expert() (numpy) rebuild
the weights; the MLX export and the Metal / Triton kernels read the same parts.
"""


def _levels_for(m, expert, default: int) -> int:
    for v in expert.views:
        f = m.formats.get((v.name, v.row))
        if f and f.startswith("hex"):
            return 16 if f.startswith("hex4") else 8
    return default


def _block_for(m, expert, default: int) -> int:
    for v in expert.views:
        f = m.formats.get((v.name, v.row))
        if f and f.startswith("hex") and "/b" in f:
            return int(f.split("/b")[1])
    return default


class _Const:
    def __init__(self, a: np.ndarray):
        self.a = np.ascontiguousarray(a)

    @property
    def nbytes(self) -> int:
        return self.a.nbytes

    def write(self, fd: int) -> None:
        import os
        os.write(fd, self.a.tobytes())


def _texts(calib) -> list:
    if isinstance(calib, (str, Path)):
        p = Path(calib)
        if p.suffix == ".jsonl":
            rows = [json.loads(x) for x in p.read_text().splitlines() if x.strip()]
            return [r["text"] if isinstance(r, dict) and "text" in r else r for r in rows]
        return [x for x in p.read_text().split("\n\n") if x.strip()]
    return list(calib or [])
