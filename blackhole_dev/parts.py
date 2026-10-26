"""The parts of a model a developer works with, and the weights inside them.

    View        one tensor (or one expert's slice of a fused tensor, one head's rows):
                read weights (v[3, 17], v.numpy()), write them (v[3, 17] = 0, v.apply(fn)),
                measure them (v.stats(), v.measure("hex3")), give them a format, freeze/train
    Part        a named piece of the model with views and children: Layer, Attention, Head,
                Mixer, MLP, MoE, Router, Expert, Embedding, Head, Norm
    Selection   a list of parts from a query, with the same verbs applied to every part

Every write is an edit on the model (nothing on disk changes until Model.save), so a part
fetched before an edit is stale afterwards: fetch parts again after structural edits.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Callable, Iterable

import numpy as np

from blackhole.anatomy import formats

if TYPE_CHECKING:
    from blackhole_dev.model import Model


def _shape_after(shape: tuple, index) -> tuple:
    if index is None:
        return tuple(shape)
    return np.broadcast_to(np.empty((), bool), shape)[index].shape


class Stats:
    """Streaming moments over one or more arrays (no full copy of a part in memory)."""

    def __init__(self):
        self.n = 0
        self.s1 = self.s2 = self.s4 = 0.0
        self.absmax = 0.0
        self.zeros = 0
        self.l1 = 0.0

    def add(self, a: np.ndarray) -> None:
        a = np.asarray(a, np.float64).ravel()
        if not a.size:
            return
        self.n += a.size
        self.s1 += float(a.sum())
        self.s2 += float((a * a).sum())
        self.s4 += float((a ** 4).sum())
        self.l1 += float(np.abs(a).sum())
        self.absmax = max(self.absmax, float(np.abs(a).max()))
        self.zeros += int((a == 0).sum())

    def result(self) -> dict:
        n = max(self.n, 1)
        mean = self.s1 / n
        var = max(self.s2 / n - mean * mean, 0.0)
        rms = math.sqrt(self.s2 / n)
        return {"count": self.n, "mean": mean, "std": math.sqrt(var), "rms": rms, "absmax": self.absmax,
                "l2": math.sqrt(self.s2), "mean_abs": self.l1 / n, "zero_frac": self.zeros / n,
                "kurtosis": (self.s4 / n) / (self.s2 / n) ** 2 if self.s2 else 0.0,
                "crest": self.absmax / rms if rms else 0.0}


class View:
    """One tensor of the model, or a slice of it (`index`, a numpy index into the tensor)."""

    def __init__(self, model: "Model", name: str, index=None, label: str = ""):
        self.model, self.name, self.index, self.label = model, name, index, label

    def __repr__(self) -> str:
        idx = "" if self.index is None else f"[{_fmt_index(self.index)}]"
        return f"<{self.name}{idx} {self.dtype}{list(self.shape)}>"

    @property
    def source(self):
        return self.model._t[self.name]

    @property
    def dtype(self) -> str:
        return self.source.dtype

    @property
    def shape(self) -> tuple:
        return _shape_after(self.source.shape, self.index)

    @property
    def numel(self) -> int:
        return int(np.prod(self.shape, dtype=np.int64)) if self.shape else 1

    @property
    def row(self) -> int | None:
        """The expert row of a fused [E, ...] tensor this view is, if it is one."""
        if isinstance(self.index, tuple) and len(self.index) == 1 and isinstance(self.index[0], (int, np.integer)):
            return int(self.index[0])
        return None

    # ----------------------------------------------------------------- reading
    def numpy(self) -> np.ndarray:
        """The weights as float32."""
        return self.source.float() if self.index is None else self.source.read(self.index)

    def __getitem__(self, idx) -> np.ndarray | float:
        if self.index is None:
            out = self.source.read(idx)
        elif self.row is not None:
            out = self.source.read((self.row,) + (idx if isinstance(idx, tuple) else (idx,)))
        else:
            out = self.numpy()[idx]
        return float(out) if np.ndim(out) == 0 else out

    def stats(self) -> dict:
        s = Stats()
        s.add(self.numpy())
        return s.result()

    def measure(self, fmt: str) -> dict:
        """Round-to-nearest error of `fmt` on these weights (see formats.measure)."""
        return formats.measure(self.numpy(), fmt)

    def histogram(self, bins: int = 32) -> tuple[np.ndarray, np.ndarray]:
        return np.histogram(self.numpy(), bins=bins)

    def norms(self, axis: int = -1) -> np.ndarray:
        """L2 norm of every row (axis=-1) or column (axis=0) of a 2-D view."""
        return np.linalg.norm(self.numpy(), axis=axis)

    # ----------------------------------------------------------------- writing (edits)
    def __setitem__(self, idx, value) -> None:
        self.model._overlay(self.name, self.index, idx, value, f"set {self.name}[{_fmt_index(idx)}]")

    def apply(self, fn: Callable[[np.ndarray], np.ndarray], note: str = "") -> "View":
        """Replace the weights with fn(weights) (float32 in, same shape out)."""
        self.model._overlay(self.name, self.index, None, fn, note or f"apply {getattr(fn, '__name__', 'fn')}")
        return self

    def set(self, value) -> "View":
        self.model._overlay(self.name, self.index, None, np.asarray(value, np.float32), "set")
        return self

    def scale(self, s: float) -> "View":
        return self.apply(lambda w: w * np.float32(s), f"scale {s}")

    def quant(self, fmt: str) -> "View":
        self.model._set_format(self, fmt)
        return self

    def freeze(self) -> "View":
        self.model._set_trainable(self, False)
        return self

    def train(self) -> "View":
        self.model._set_trainable(self, True)
        return self


def _fmt_index(idx) -> str:
    idx = idx if isinstance(idx, tuple) else (idx,)

    def one(i):
        if isinstance(i, slice):
            return f"{'' if i.start is None else i.start}:{'' if i.stop is None else i.stop}"
        return str(i)
    return ", ".join(one(i) for i in idx)


# --------------------------------------------------------------------------- parts


class Part:
    kind = "part"
    children_names: tuple = ()

    def __init__(self, model: "Model", path: str, views: list[View], **attrs):
        self.model, self.path, self.views, self.attrs = model, path, views, attrs

    def __repr__(self) -> str:
        extra = " ".join(f"{k}={_short(v)}" for k, v in self.attrs.items() if v is not None and k not in ("layer",))
        return f"<{type(self).__name__} {self.path} {self.params:,} params{' ' + extra if extra else ''}>"

    def child(self, name: str):
        return getattr(self, name, None) if name in self.children_names else None

    @property
    def tensors(self) -> list[View]:
        return list(self.views)

    @property
    def params(self) -> int:
        return sum(v.numel for v in self.views)

    @property
    def nbytes(self) -> int:
        from blackhole.anatomy import st
        return sum(v.numel * st.BITS[v.dtype] // 8 for v in self.views)

    def info(self) -> dict:
        return {"path": self.path, "kind": self.kind, "params": self.params, "bytes": self.nbytes,
                **{k: v for k, v in self.attrs.items() if v is not None},
                "tensors": [{"name": v.name, "index": None if v.index is None else _fmt_index(v.index),
                             "dtype": v.dtype, "shape": list(v.shape)} for v in self.views]}

    def select(self, query: str) -> "Selection":
        from blackhole_dev.query import select
        return select(self, query)

    def stats(self) -> dict:
        s = Stats()
        for v in self.views:
            s.add(v.numpy())
        return s.result()

    def measure(self, fmt: str) -> dict:
        err = ref = 0.0
        for v in self.views:
            w = v.numpy()
            q = formats.fake_quant(w, fmt)
            err += float(np.sum((w.astype(np.float64) - q) ** 2))
            ref += float(np.sum(w.astype(np.float64) ** 2))
        rel = err / (ref or 1e-30)
        return {"format": fmt, "bpw": formats.bpw(fmt), "rel_mse": rel, "snr_db": -10 * math.log10(max(rel, 1e-30))}

    def apply(self, fn: Callable[[np.ndarray], np.ndarray], note: str = "") -> "Part":
        for v in self.views:
            v.apply(fn, note)
        return self

    def quant(self, fmt: str) -> "Part":
        for v in self.views:
            if v.numel >= 2 and len(v.shape) >= 2 or v.row is not None:   # norms and biases stay as they are
                v.quant(fmt)
        return self

    def freeze(self) -> "Part":
        for v in self.views:
            v.freeze()
        return self

    def train(self) -> "Part":
        for v in self.views:
            v.train()
        return self


def _short(v):
    return f"{v:.4g}" if isinstance(v, float) else v


class Embedding(Part):
    kind = "embed"

    @property
    def weight(self) -> View:
        return self.views[0]


class LMHead(Part):
    kind = "head"

    @property
    def weight(self) -> View:
        return self.views[0]

    def trim(self, keep: Iterable[int]) -> "LMHead":
        """Output-only vocab trim: the head keeps these token ids (the MLX export writes the
        smaller head and maps ids back; the embedding keeps every token)."""
        self.model.trim_head(keep)
        return self


class Norm(Part):
    kind = "norm"


class Head(Part):
    """One attention head: its rows of q (and of k, v for its KV group) and its columns of o."""
    kind = "head"


class Attention(Part):
    kind = "attention"
    children_names = ("heads",)

    def __init__(self, model, path, views, roles: dict, heads_info: tuple | None, **attrs):
        super().__init__(model, path, views, **attrs)
        self.roles = roles
        self._heads_info = heads_info

    def __getattr__(self, name):
        roles = self.__dict__.get("roles", {})
        if name in roles:
            return roles[name]
        raise AttributeError(name)

    @property
    def heads(self) -> list[Head]:
        """Per-head views when q, k, v and o are separate projections."""
        if not self._heads_info:
            return []
        n_heads, n_kv, hd = self._heads_info
        q, k, v, o = (self.roles[r] for r in "qkvo")
        out = []
        group = n_heads // max(n_kv, 1)
        for h in range(n_heads):
            r = slice(h * hd, (h + 1) * hd)
            g = h // group
            kv = slice(g * hd, (g + 1) * hd)
            views = [View(self.model, q.name, (r,), "q"), View(self.model, k.name, (kv,), "k"),
                     View(self.model, v.name, (kv,), "v"), View(self.model, o.name, (slice(None), r), "o")]
            out.append(Head(self.model, f"{self.path}.heads.{h}", views, id=h, kv_group=g,
                            layer=self.attrs.get("layer")))
        return out


class Mixer(Part):
    """A linear-attention / DeltaNet / Mamba block (fixed-size state instead of a KV cache)."""
    kind = "mixer"

    def __getattr__(self, name):
        roles = self.__dict__.get("roles", {})
        if name in roles:
            return roles[name]
        raise AttributeError(name)


class MLP(Part):
    """A dense gated FFN (or a MoE's shared expert): gate, up, down."""
    kind = "mlp"

    def __init__(self, model, path, views, roles: dict, layer: int, shared: bool = False, **attrs):
        super().__init__(model, path, views, layer=layer, **attrs)
        self.roles, self.shared = roles, shared
        if shared:
            self.kind = "shared"

    def __getattr__(self, name):
        roles = self.__dict__.get("roles", {})
        if name in roles:
            return roles[name]
        raise AttributeError(name)

    @property
    def neurons(self) -> int:
        if "down" in self.roles:
            return self.roles["down"].shape[-1]
        return 0

    def neuron_scores(self) -> np.ndarray:
        """Weight-only importance of every intermediate channel: ||gate row|| * ||up row|| *
        ||down column||. Activation-scored importance (E|h| * ||down column||, what the dense
        default uses) needs the model running: LiveModel.neuron_scores."""
        down = self.roles["down"].norms(axis=0)
        if "gate_up" in self.roles:
            gu = self.roles["gate_up"].norms(axis=-1)
            g, u = gu[:len(gu) // 2], gu[len(gu) // 2:]
        else:
            g = self.roles["gate"].norms(axis=-1) if "gate" in self.roles else 1.0
            u = self.roles["up"].norms(axis=-1)
        return np.asarray(g * u * down)

    def prune_neurons(self, keep: Iterable[int] | None = None, ratio: float | None = None,
                      scores: np.ndarray | None = None) -> "MLP":
        """Keep these intermediate channels (or drop `ratio` of them, lowest score first)."""
        if keep is None:
            if ratio is None:
                raise ValueError("give keep= or ratio=")
            s = self.neuron_scores() if scores is None else np.asarray(scores)
            n = len(s) - int(round(len(s) * ratio))
            keep = sorted(np.argsort(-s, kind="stable")[:n].tolist())
        self.model.prune_neurons(self.attrs["layer"], sorted(int(i) for i in keep), shared=self.shared)
        return self


class Router(Part):
    kind = "router"

    @property
    def weight(self) -> View:
        return self.views[0]

    def logits(self, x: np.ndarray) -> np.ndarray:
        """Router logits [N, E] for hidden states x [N, hidden] (plus the bias if it has one)."""
        out = np.asarray(x, np.float32) @ self.weight.numpy().T
        b = next((v for v in self.views[1:] if v.name.endswith(".bias")), None)
        return out + b.numpy() if b is not None else out

    def scale(self, experts: Iterable[int] | int, s: float) -> "Router":
        """Multiply these experts' router rows by s (scales their logits)."""
        ids = [experts] if isinstance(experts, int) else list(experts)
        self.weight.apply(lambda w: _rows_mul(w, ids, s), f"router scale {ids} x{s}")
        return self

    def temperature(self, t: float) -> "Router":
        """Divide every logit by t (t > 1 spreads the routing, t < 1 sharpens it)."""
        self.weight.apply(lambda w: w / np.float32(t), f"router temperature {t}")
        return self

    def bias(self, experts: Iterable[int] | int, delta: float) -> "Router":
        """Add delta to these experts' routing bias (router bias or DeepSeek-style correction bias)."""
        ids = [experts] if isinstance(experts, int) else list(experts)
        b = next((v for v in self.views[1:] if v.name.endswith(("bias", "e_score_correction_bias"))), None)
        if b is None:
            raise ValueError(f"{self.path} has no bias to edit; scale() or set_row() change a bias-free router")

        def add(w):
            w = w.copy()
            w[ids] += np.float32(delta)
            return w
        b.apply(add, f"router bias {ids} +{delta}")
        return self

    def set_row(self, expert: int, values) -> "Router":
        self.weight[expert] = np.asarray(values, np.float32)
        return self


def _rows_mul(w: np.ndarray, ids: list[int], s: float) -> np.ndarray:
    w = w.copy()
    w[ids] *= np.float32(s)
    return w


class Expert(Part):
    """One routed expert. attrs: id, layer, score (REAP saliency), freq (share of routed
    tokens), rank (0 = lowest score in its layer, 1 = highest), origin (layer, id) in the base."""
    kind = "expert"

    def __getattr__(self, name):
        attrs = self.__dict__.get("attrs", {})
        if name in attrs:
            return attrs[name]
        raise AttributeError(name)

    @property
    def roles(self) -> dict:
        return {v.label: v for v in self.views if v.label}

    def drop(self) -> None:
        self.model.drop_experts(self.attrs["layer"], [self.attrs["id"]])

    def duplicate(self) -> None:
        self.model.duplicate_expert(self.attrs["layer"], self.attrs["id"])


class MoE(Part):
    kind = "moe"
    children_names = ("router", "experts", "shared")

    def __init__(self, model, path, views, router: Router, experts: list[Expert], shared: MLP | None, **attrs):
        super().__init__(model, path, views, **attrs)
        self.router, self.experts, self.shared = router, experts, shared

    @property
    def num_experts(self) -> int:
        return len(self.experts)

    def keep(self, ids: Iterable[int]) -> None:
        self.model.keep_experts(self.attrs["layer"], list(ids))

    def drop(self, ids: Iterable[int]) -> None:
        self.model.drop_experts(self.attrs["layer"], list(ids))

    def reorder(self, order: Iterable[int] | str = "score") -> None:
        """New expert order: a permutation, or "score" (highest REAP score first: hot experts
        become a contiguous id range, what tiered kernels and hot/cold placement need)."""
        if order == "score":
            order = sorted(range(self.num_experts), key=lambda j: -(self.experts[j].attrs.get("score") or 0.0))
        self.model.keep_experts(self.attrs["layer"], list(order), note="reorder")

    def merge(self, ids: Iterable[int], weights: Iterable[float] | str = "freq") -> None:
        self.model.merge_experts(self.attrs["layer"], list(ids), weights)

    def duplicate(self, expert: int) -> None:
        self.model.duplicate_expert(self.attrs["layer"], expert)


class Layer(Part):
    kind = "layer"
    children_names = ("attn", "mixer", "mlp", "moe", "norms", "ffn")

    def __init__(self, model, path, views, attn, mixer, mlp, moe, norms, **attrs):
        super().__init__(model, path, views, **attrs)
        self.attn, self.mixer, self.mlp, self.moe, self.norms = attn, mixer, mlp, moe, norms

    @property
    def ffn(self):
        return self.moe or self.mlp

    @property
    def index(self) -> int:
        return self.attrs["index"]

    def drop(self) -> None:
        self.model.drop_layers([self.index])

    def duplicate(self, at: int | None = None) -> None:
        self.model.duplicate_layer(self.index, at)

    def replace_with(self, other: "Layer") -> None:
        """Splice: this layer's weights become `other`'s (a layer of this or another model)."""
        self.model.splice_layer(self.index, other.model, other.index)


# --------------------------------------------------------------------------- selections


class Selection(list):
    """Parts matched by a query. The verbs apply to every part; structural ones (drop, merge)
    are grouped per layer and applied as one edit each."""

    def __repr__(self) -> str:
        return f"<Selection {len(self)} parts{': ' + ', '.join(p.path for p in self[:6]) if self else ''}" \
               f"{' ...' if len(self) > 6 else ''}>"

    @property
    def model(self):
        return self[0].model if self else None

    @property
    def tensors(self) -> list[View]:
        return [v for p in self for v in p.views]

    @property
    def params(self) -> int:
        return sum(p.params for p in self)

    def select(self, query: str) -> "Selection":
        out = Selection()
        for p in self:
            out.extend(p.select(query))
        return out

    def where(self, pred: Callable[[Part], bool]) -> "Selection":
        return Selection(p for p in self if pred(p))

    def stats(self) -> dict:
        s = Stats()
        for v in self.tensors:
            s.add(v.numpy())
        return s.result()

    def each(self, fn: Callable[[Part], object]) -> list:
        return [fn(p) for p in self]

    def table(self, *cols: str) -> str:
        cols = cols or ("path", "params", "score", "freq", "rank")
        rows = [[_cell(p, c) for c in cols] for p in self]
        w = [max([len(c)] + [len(r[i]) for r in rows]) for i, c in enumerate(cols)]
        lines = ["  ".join(c.ljust(w[i]) for i, c in enumerate(cols))]
        lines += ["  ".join(r[i].ljust(w[i]) for i in range(len(cols))) for r in rows]
        return "\n".join(lines)

    def apply(self, fn, note: str = "") -> "Selection":
        for p in self:
            p.apply(fn, note)
        return self

    def quant(self, fmt: str) -> "Selection":
        for p in self:
            p.quant(fmt)
        return self

    def freeze(self) -> "Selection":
        for p in self:
            p.freeze()
        return self

    def train(self) -> "Selection":
        for p in self:
            p.train()
        return self

    def measure(self, fmt: str) -> dict:
        err = ref = 0.0
        for v in self.tensors:
            w = v.numpy()
            err += float(np.sum((w.astype(np.float64) - formats.fake_quant(w, fmt)) ** 2))
            ref += float(np.sum(w.astype(np.float64) ** 2))
        rel = err / (ref or 1e-30)
        return {"format": fmt, "bpw": formats.bpw(fmt), "rel_mse": rel, "snr_db": -10 * math.log10(max(rel, 1e-30))}

    def drop(self) -> None:
        m = self.model
        if m is None:
            return
        kinds = {p.kind for p in self}
        if kinds == {"expert"}:
            by_layer: dict[int, list[int]] = {}
            for p in self:
                by_layer.setdefault(p.attrs["layer"], []).append(p.attrs["id"])
            for L, ids in by_layer.items():
                m.drop_experts(L, ids)
        elif kinds == {"layer"}:
            m.drop_layers([p.attrs["index"] for p in self])
        else:
            raise ValueError(f"drop() works on experts or layers, not {sorted(kinds)}")

    def merge(self, weights: Iterable[float] | str = "freq") -> None:
        """Merge the selected experts of each layer into one (the first of them)."""
        by_layer: dict[int, list[int]] = {}
        for p in self:
            if p.kind != "expert":
                raise ValueError("merge() works on experts")
            by_layer.setdefault(p.attrs["layer"], []).append(p.attrs["id"])
        for L, ids in by_layer.items():
            if len(ids) > 1:
                self.model.merge_experts(L, ids, weights)


def _cell(p: Part, c: str) -> str:
    v = getattr(p, c, None) if c in ("path", "params", "kind") else p.attrs.get(c)
    if v is None:
        return "-"
    return f"{v:.4g}" if isinstance(v, float) else (f"{v:,}" if isinstance(v, int) and c == "params" else str(v))
