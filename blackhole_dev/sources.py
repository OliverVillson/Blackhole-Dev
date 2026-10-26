"""Where each tensor of an edited model comes from.

Edits never touch the source checkpoint. Every tensor of the edited model is a Source:

  File      a tensor of a checkpoint file, or some of its rows (dropped / reordered /
            duplicated experts of a fused [E, ...] tensor, router rows). Saved by copying
            byte ranges, so nothing is decoded and quantized blocks stay bit-exact.
  Lazy      computed when read or saved: merged experts, column slices (FFN neurons), weight
            writes, edited router rows. Holds a function of other sources, not an array, so
            an edit plan over a 60 GB model costs no memory until it is saved.

Both give .raw() (storage dtype, the array as it would be saved) and .float() (float32).
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from blackhole.anatomy import st

# Read meters (blackhole_dev.analysis.ReadMeter): every byte a File source hands out is counted
# here first, so an analysis can be held to a read budget before it touches the weights.
METERS: list = []


def _count(n: int) -> None:
    for m in METERS:
        m.add(int(n))


class Source:
    dtype: str
    shape: tuple

    @property
    def nbytes(self) -> int:
        n = int(np.prod(self.shape, dtype=np.int64)) if self.shape else 1
        return n * st.BITS[self.dtype] // 8

    @property
    def numel(self) -> int:
        return int(np.prod(self.shape, dtype=np.int64)) if self.shape else 1

    def raw(self) -> np.ndarray:
        raise NotImplementedError

    def float(self) -> np.ndarray:
        return st.decode(np.asarray(self.raw()), self.dtype)

    def read(self, index) -> np.ndarray:
        """float32 values at a numpy index, reading as little as the source allows."""
        return st.decode(np.asarray(self.raw()[index]), self.dtype)

    def rows(self, rows: list[int]) -> "Source":
        return Lazy(self.dtype, (len(rows),) + tuple(self.shape[1:]), lambda: np.asarray(self.raw())[rows],
                    note="rows")

    def write(self, fd: int) -> None:
        import os
        os.write(fd, np.ascontiguousarray(self.raw()).tobytes())

    @property
    def exact(self) -> bool:
        """Saved as a byte copy of the original checkpoint."""
        return False


class File(Source):
    def __init__(self, entry: st.Entry, rows: list[int] | None = None):
        self.entry = entry
        self.dtype = entry.dtype
        self._rows = rows
        self.shape = entry.shape if rows is None else (len(rows),) + tuple(entry.shape[1:])

    def __repr__(self) -> str:
        return f"File({self.entry.name}{'' if self._rows is None else f' rows {self._rows}'})"

    @property
    def exact(self) -> bool:
        return True

    def _full(self) -> np.ndarray:
        e = self.entry
        return e.blob.array(e.offset, e.dtype, e.shape)

    def raw(self) -> np.ndarray:
        if METERS:
            _count(self.nbytes)
        a = self._full()
        return a if self._rows is None else np.asarray(a[self._rows])

    def read(self, index) -> np.ndarray:
        if METERS:
            _count(np.broadcast_to(np.empty((), bool), self.shape)[index].size * st.BITS[self.dtype] // 8)
        a = self._full()
        if self._rows is not None:
            idx = index if isinstance(index, tuple) else (index,)
            first = idx[0] if idx else slice(None)
            if isinstance(first, (int, np.integer)):
                a, index = a[self._rows[first]], idx[1:]
            else:
                a = a[np.asarray(self._rows)[first]]
                index = (slice(None),) + idx[1:]
        return st.decode(np.asarray(a[index]), self.dtype)

    def rows(self, rows: list[int]) -> "Source":
        base = list(range(self.entry.shape[0])) if self._rows is None else self._rows
        return File(self.entry, [base[r] for r in rows])

    def ranges(self) -> list[tuple[int, int]]:
        e = self.entry
        if self._rows is None:
            return [(e.offset, e.nbytes)]
        row = e.nbytes // e.shape[0]
        out: list[tuple[int, int]] = []
        for r in self._rows:
            o = e.offset + r * row
            if out and out[-1][0] + out[-1][1] == o:
                out[-1] = (out[-1][0], out[-1][1] + row)
            else:
                out.append((o, row))
        return out

    def write(self, fd: int) -> None:
        for o, n in self.ranges():
            self.entry.blob.copy_to(fd, o, n)


class Lazy(Source):
    def __init__(self, dtype: str, shape: tuple, fn: Callable[[], np.ndarray], note: str = ""):
        self.dtype, self.shape, self.fn, self.note = dtype, tuple(shape), fn, note

    def __repr__(self) -> str:
        return f"Lazy({self.note}, {self.dtype}{list(self.shape)})"

    def raw(self) -> np.ndarray:
        a = np.asarray(self.fn())
        if tuple(a.shape) != self.shape:
            raise ValueError(f"{self.note}: computed shape {a.shape} != planned {self.shape}")
        return a


def computed(src: Source, fn: Callable[[np.ndarray], np.ndarray], note: str) -> Lazy:
    """A float edit of a whole source: fn(float32 array) -> float array, saved in src's dtype."""
    if not st.DTYPES[src.dtype][1]:
        return Lazy(src.dtype, src.shape, lambda: st.encode(fn(src.raw().astype(np.float32)), src.dtype), note)
    if src.dtype in st.FP8:
        raise TypeError(f"{note}: fp8 weights carry separate block scales; edit them after dequantizing")
    return Lazy(src.dtype, src.shape, lambda: st.encode(fn(src.float()), src.dtype), note)


def blend(srcs: list[Source], weights: list[float], note: str) -> Lazy:
    """Weighted sum of sources of one shape (merged experts)."""
    s0 = srcs[0]
    if any(tuple(s.shape) != tuple(s0.shape) for s in srcs):
        raise ValueError(f"{note}: shapes differ {[s.shape for s in srcs]}")

    def fn():
        acc = np.zeros(s0.shape, np.float32)
        for s, w in zip(srcs, weights):
            acc += np.float32(w) * s.float()
        return st.encode(acc, s0.dtype)
    return Lazy(s0.dtype, s0.shape, fn, note)


def columns(src: Source, cols: list[int], note: str) -> Lazy:
    return Lazy(src.dtype, tuple(src.shape[:-1]) + (len(cols),), lambda: np.asarray(src.raw())[..., cols], note)


class Overlay(Source):
    """Writes on top of a source: (view index, sub index, value or fn) applied in order to the
    float32 weights, then stored back in the source's dtype. Repeated writes to one tensor
    share one overlay, so a loop setting single weights stays one decode and one encode."""

    def __init__(self, base: Source):
        if base.dtype in st.FP8:
            raise TypeError("fp8 weights carry separate block scales; write them after dequantizing")
        self.base, self.dtype, self.shape, self.ops = base, base.dtype, tuple(base.shape), []

    def __repr__(self) -> str:
        return f"Overlay({self.base!r}, {len(self.ops)} writes)"

    def float(self) -> np.ndarray:
        a = np.array(self.base.float(), dtype=np.float32, copy=True)
        for vi, si, val in self.ops:
            a = _apply(a, vi, si, val)
        return a

    def raw(self) -> np.ndarray:
        return st.encode(self.float(), self.dtype)

    def read(self, index) -> np.ndarray:
        return self.float()[index]


def _apply(a: np.ndarray, vi, si, val) -> np.ndarray:
    if vi is None and si is None:
        new = np.asarray(val(a) if callable(val) else np.broadcast_to(np.asarray(val, np.float32), a.shape),
                         np.float32)
        if new.shape != a.shape:
            raise ValueError(f"a write must keep the shape {a.shape}, got {new.shape}")
        return np.array(new, copy=True)
    target = a if vi is None else a[vi]
    view = vi is None or np.shares_memory(target, a)
    if not view:
        target = np.array(target, copy=True)
    if si is None:
        new = np.asarray(val(target) if callable(val) else val, np.float32)
        target[...] = new
    else:
        target[si] = val(target[si]) if callable(val) else np.asarray(val, np.float32)
    if not view:
        a[vi] = target
    return a
