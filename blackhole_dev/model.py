"""Model: a checkpoint opened for inspection and editing.

Opening reads config.json and the safetensors headers (a few KB per shard, from a folder or
straight from the Hub with range requests), never the weights. Every edit changes the
model's tensor map (see sources.py) and is logged; save() writes a new checkpoint in the
source's own tensor names and dtypes, copying byte ranges wherever the edit allows, plus
blackhole-anatomy.json (the receipt: every edit, formats, trainable set, sizes before and
after) and blackhole-lineage.json.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np

from blackhole.anatomy import formats, st
from blackhole_dev import layout
from blackhole_dev.parts import (MLP, Attention, Embedding, Expert, Layer, LMHead, Mixer, MoE, Norm, Part,
                                     Router, Selection, View)
from blackhole_dev.sources import File, Lazy, Overlay, Source, blend, columns

EXPERT_KEYS = ("num_experts", "num_local_experts", "n_routed_experts", "moe_num_experts")
TOP_K_KEYS = ("num_experts_per_tok", "moe_k", "moe_topk", "top_k", "num_selected_experts")
SKIP_FILES = ("model.safetensors.index.json", "config.json", "blackhole-anatomy.json", "blackhole-lineage.json",
              "blackhole-hex.safetensors")
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pt", ".pth", ".gguf", ".msgpack", ".h5")
API = "blackhole-anatomy/v1"


class AnatomyError(RuntimeError):
    pass


def _natural(name: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name)]


class Model(Part):
    """The whole model. Children: layers, embed, head, norm, mtp. See blackhole_dev."""
    kind = "model"
    children_names = ("layers", "embed", "head", "norm", "mtp")

    def __init__(self, model_id: str, root: Path | None, config: dict, entries: list[st.Entry],
                 extra_files: Iterable[Path] = ()):
        self.model, self.path, self.attrs = self, "", {}
        self.id, self.root, self.config = model_id, root, config
        self.extra_files = list(extra_files)
        self._t: dict[str, Source] = {e.name: File(e) for e in entries}
        self.log: list[dict] = []
        self.formats: dict[tuple[str, int | None], str] = {}
        self.trainable: dict[tuple[str, int | None], bool] = {}
        self.head_vocab: list[int] | None = None
        self.notes: dict[str, dict] = {}
        self.functions: dict[str, str] = {}          # named functions applied: name -> code sha256
        self.hex: dict[tuple, object] = {}           # (layer, expert id, role) -> hex.Hex after hex-quantize
        self._config0 = copy.deepcopy(config)
        self._scores: dict[tuple, dict] = {}         # (model id, layer, expert) -> {score, freq, ...}
        self._layout: layout.Layout | None = None
        lay = self.layout
        self.layer_attrs: list[dict] = [{"origin": (self.id, L.index)} for L in lay.layers]
        self.expert_attrs: dict[int, list[dict]] = {
            L.index: [{"origin": [(self.id, L.index, j)]} for j in range(L.ffn.num_experts)]
            for L in lay.layers if L.ffn and L.ffn.moe}
        self._before = self._footprint()

    # ------------------------------------------------------------------ basics
    def __repr__(self) -> str:
        return f"<Model {self.id} {self.info.model_type} {'/'.join(self.info.kinds)} " \
               f"{len(self.layout.layers)} layers {self.params / 1e9:.3g}B params>"

    @property
    def tc(self) -> dict:
        """The text model's config (config['text_config'] for image-text checkpoints)."""
        return self.config.get("text_config") or self.config.get("language_config") or self.config

    @property
    def info(self):
        from blackhole.hw.model import from_config
        return from_config(self.id, self.config, 0)

    @property
    def layout(self) -> layout.Layout:
        if self._layout is None:
            self._layout = layout.parse({n: s.shape for n, s in self._t.items()},
                                        self.tc.get("num_hidden_layers", 10 ** 9))
        return self._layout

    def _changed(self) -> None:
        self._layout = None

    @property
    def views(self) -> list[View]:
        return [View(self, n) for n in self._t]

    def tensor(self, name: str) -> View:
        if name not in self._t:
            near = [n for n in self._t if name.split(".")[-2:] == n.split(".")[-2:]][:3]
            raise KeyError(f"no tensor {name!r}" + (f"; similar: {near}" if near else ""))
        return View(self, name)

    @property
    def tensor_names(self) -> list[str]:
        return sorted(self._t, key=_natural)

    def __getitem__(self, query: str) -> Selection:
        return self.select(query)

    def parts(self) -> list[Part]:
        out: list[Part] = [p for p in (self.embed, self.head, self.norm) if p is not None]
        for L in self.layers:
            out.append(L)
            for p in (L.attn, L.mixer, L.mlp, L.moe):
                if p is not None:
                    out.append(p)
            if L.moe:
                out += [L.moe.router] + L.moe.experts + ([L.moe.shared] if L.moe.shared else [])
        return out

    # ------------------------------------------------------------------ parts
    @property
    def embed(self) -> Embedding | None:
        names = self.layout.embed
        return Embedding(self, "embed", [View(self, n) for n in names]) if names else None

    @property
    def head(self) -> LMHead | None:
        names = self.layout.head
        if names:
            return LMHead(self, "head", [View(self, n) for n in names], vocab_kept=len(self.head_vocab)
                          if self.head_vocab else None)
        if self.embed is not None and (self.tc.get("tie_word_embeddings") or self.config.get("tie_word_embeddings")):
            return LMHead(self, "head", self.embed.views, tied=True)
        return None

    @property
    def norm(self) -> Norm | None:
        names = self.layout.norm
        return Norm(self, "norm", [View(self, n) for n in names]) if names else None

    @property
    def layers(self) -> list[Layer]:
        return [self._layer(L, i) for i, L in enumerate(self.layout.layers)]

    @property
    def mtp(self) -> list[Layer]:
        return [self._layer(L, L.index, "mtp") for L in self.layout.mtp]

    def _kind_of(self, L: layout.LayerLayout) -> str:
        types = self.tc.get("layer_types")
        if isinstance(types, list) and L.index < len(types):
            t = str(types[L.index])
            return "mixer" if layout.RECURRENT_HINT.search(t) else t
        return L.attn_kind or "?"

    def _layer(self, L: layout.LayerLayout, i: int, kind: str | None = None) -> Layer:
        v = lambda n, idx=None, label="": View(self, n, idx, label)  # noqa: E731
        attn = mixer = mlp = moe = None
        roles = {r: v(ns[0], label=r) for r, ns in L.attn.items()}
        attn_views = [v(n, label=r) for r, ns in L.attn.items() for n in ns]
        if L.attn_kind == "attention":
            attn = Attention(self, f"layers.{i}.attn", attn_views, roles, self._heads(L, roles), layer=i)
        elif L.attn_kind == "mixer":
            mixer = Mixer(self, f"layers.{i}.mixer", attn_views, layer=i)
            mixer.roles = roles
        f = L.ffn
        if f is not None and not f.moe:
            mlp = MLP(self, f"layers.{i}.mlp", [v(n, label=r) for r, ns in f.proj.items() for n in ns],
                      {r: v(ns[0], label=r) for r, ns in f.proj.items()}, i)
        elif f is not None:
            moe = self._moe(L, i)
        la = self.layer_attrs[i] if kind is None and i < len(self.layer_attrs) else {}
        extra = {k: x for k, x in la.items() if k != "origin"}
        return Layer(self, f"{'mtp' if kind == 'mtp' else 'layers'}.{i}", [v(n) for n in L.names], attn, mixer, mlp,
                     moe, [Norm(self, f"layers.{i}.norms", [v(n) for n in L.norms], layer=i)] if L.norms else [],
                     index=i, kind=kind or self._kind_of(L), is_moe=bool(moe), **extra)

    def _heads(self, L: layout.LayerLayout, roles: dict):
        if not all(r in roles for r in "qkvo"):
            return None
        c = self.tc
        n = c.get("num_attention_heads")
        if not n:
            return None
        kv = c.get("num_key_value_heads") or n
        hd = c.get("head_dim") or (c.get("hidden_size", 0) // n)
        if roles["q"].shape[0] != n * hd or roles["k"].shape[0] != kv * hd:
            return None
        return n, kv, hd

    def _moe(self, L: layout.LayerLayout, i: int) -> MoE:
        f = L.ffn
        v = lambda n, idx=None, label="": View(self, n, idx, label)  # noqa: E731
        router = Router(self, f"layers.{i}.moe.router", [v(n) for n in f.router], layer=i)
        attrs = self.expert_attrs.get(i) or [{"origin": []} for _ in range(f.num_experts)]
        scores = [self._expert_score(a) for a in attrs]
        known = sorted((s["score"], j) for j, s in enumerate(scores) if s.get("score") is not None)
        rank = {j: (r / (len(known) - 1) if len(known) > 1 else 1.0) for r, (_, j) in enumerate(known)}
        experts = []
        for j in range(f.num_experts):
            if f.experts:
                views = [v(n, label=r) for r, ns in f.experts.get(j, {}).items() for n in ns]
            else:
                views = [v(n, (j,), r) for r, ns in f.fused.items() for n in ns if self._t[n].shape[0] == f.num_experts]
            extra = {k: x for k, x in attrs[j].items() if k != "origin"}
            experts.append(Expert(self, f"layers.{i}.moe.experts.{j}", views, id=j, layer=i,
                                  score=scores[j].get("score"), freq=scores[j].get("freq"), rank=rank.get(j),
                                  **{**{k: x for k, x in scores[j].items() if k not in ("score", "freq")}, **extra}))
        shared = None
        if f.shared:
            shared = MLP(self, f"layers.{i}.moe.shared", [v(n, label=r) for r, ns in f.shared.items() for n in ns],
                         {r: v(ns[0], label=r) for r, ns in f.shared.items()}, i, shared=True)
        allv = router.views + [x for e in experts for x in e.views] + (shared.views if shared else []) \
            + [v(n) for n in f.other]
        return MoE(self, f"layers.{i}.moe", allv, router, experts, shared, layer=i, n_experts=f.num_experts,
                   top_k=self.top_k)

    @property
    def top_k(self) -> int:
        return next((self.tc[k] for k in TOP_K_KEYS if isinstance(self.tc.get(k), int)), 0)

    def _expert_score(self, attrs: dict) -> dict:
        hits = [self._scores[o] for o in attrs.get("origin", []) if tuple(o) in self._scores]
        if not hits:
            return {}
        out = {"score": max(h["score"] for h in hits)}
        if all(h.get("freq") is not None for h in hits):
            out["freq"] = sum(h["freq"] for h in hits)
        for k in hits[0]:
            if k not in ("score", "freq"):
                out[k] = hits[0][k]
        return out

    # ------------------------------------------------------------------ scores and notes
    def load_scores(self, scores) -> "Model":
        """Attach REAP scores: REAPer's work/saliency.json, the score.reap artifact, or a dict
        {layer: {"saliency": [...], "freq": [...]}} in the base model's numbering. After that,
        experts have score, freq and rank, and queries can filter on them."""
        if isinstance(scores, (str, Path)):
            scores = json.loads(Path(scores).read_text())
        rows = scores.get("layers") if isinstance(scores, dict) and "layers" in scores else \
            [{"layer": int(k), **v} for k, v in scores.items()]
        n = 0
        for row in rows:
            L = int(row["layer"])
            if "experts" in row and isinstance(row["experts"], list):
                for e in row["experts"]:
                    self._scores[(self.id, L, int(e["id"]))] = {"score": float(e["saliency"]),
                                                                "freq": e.get("freq"),
                                                                **{k: e[k] for k in e if k not in ("id", "saliency", "freq")}}
                    n += 1
            else:
                freq = row.get("freq") or [None] * len(row["saliency"])
                tot = sum(f for f in freq if f) or None
                for j, s in enumerate(row["saliency"]):
                    f = freq[j]
                    self._scores[(self.id, L, j)] = {"score": float(s), "freq": f / tot if (f is not None and tot) else f}
                    n += 1
        self.log.append({"op": "load_scores", "experts": n})
        return self

    def set_scores(self, layer: int, scores: Iterable[float], freq: Iterable[float] | None = None) -> None:
        """Scores for the experts of a layer as it is now (e.g. measured on the edited model)."""
        attrs = self.expert_attrs[layer]
        freq = list(freq) if freq is not None else [None] * len(attrs)
        for j, s in enumerate(scores):
            key = (self.id, "current", layer, j)
            self._scores[key] = {"score": float(s), "freq": freq[j]}
            attrs[j]["origin"] = [key]

    def annotate(self, parts: Iterable[Part], key: str, fn) -> "Model":
        """Store fn(part) as attribute `key` on every part, so queries can filter on it:
            m.annotate(m["experts"], "kurt", lambda e: e.stats()["kurtosis"])
            m["experts[kurt>8]"].quant("hex4")
        Expert and layer attributes follow them through structural edits."""
        for p in parts:
            val = fn(p)
            if p.kind == "expert":
                self.expert_attrs[p.attrs["layer"]][p.attrs["id"]][key] = val
            elif p.kind == "layer":
                self.layer_attrs[p.attrs["index"]][key] = val
            else:
                self.notes.setdefault(p.path, {})[key] = val
        return self

    # ------------------------------------------------------------------ weight-level edits
    def _overlay(self, name: str, vi, si, val, note: str) -> None:
        src = self._t[name]
        if not isinstance(src, Overlay):
            src = Overlay(src)
            self._t[name] = src
        src.ops.append((vi, si, val))
        last = self.log[-1] if self.log else {}
        if last.get("op") == "write" and last.get("tensor") == name and last.get("note") == note:
            last["count"] += 1
        else:
            self.log.append({"op": "write", "tensor": name, "note": note, "count": 1})

    def _set_format(self, view: View, fmt: str) -> None:
        fmt = formats.check(fmt)
        if view.index is not None and view.row is None:
            raise ValueError(f"{view!r}: formats apply to whole tensors or to expert rows of fused tensors")
        self.formats[(view.name, view.row)] = fmt
        self._log_count("quant", fmt)

    def _set_trainable(self, view: View, flag: bool) -> None:
        if view.index is not None and view.row is None:
            raise ValueError(f"{view!r}: train/freeze apply to whole tensors or to expert rows of fused tensors")
        self.trainable[(view.name, view.row)] = flag
        self._log_count("train" if flag else "freeze", None)

    def _log_count(self, op: str, arg) -> None:
        last = self.log[-1] if self.log else {}
        if last.get("op") == op and last.get("arg") == arg:
            last["tensors"] += 1
        else:
            self.log.append({"op": op, "arg": arg, "tensors": 1})

    def reaq(self, avg_bits: float = 3.5, hi: str = "hex4", lo: str = "hex3", layers: Iterable[int] | None = None) -> dict:
        """REAQ (Router-weighted Expert Activation Quantization): in every MoE layer the experts
        with the highest REAP scores get `hi`, the rest `lo`, so the average lands at avg_bits
        and no expert is removed. Needs scores (load_scores or LiveModel.reap_scores).
        Returns {layer: number of experts at hi}."""
        bh, bl = formats.bpw(hi), formats.bpw(lo)
        if not bl <= avg_bits <= bh:
            raise ValueError(f"avg_bits {avg_bits} is outside [{bl}, {bh}] for {lo}/{hi}")
        out = {}
        for L in self.layers:
            if L.moe is None or (layers is not None and L.index not in set(layers)):
                continue
            ex = L.moe.experts
            if any(e.attrs.get("score") is None for e in ex):
                raise AnatomyError(f"layer {L.index} has experts without scores: load_scores() first")
            n_hi = int(round(len(ex) * (avg_bits - bl) / (bh - bl)))
            order = sorted(ex, key=lambda e: -e.attrs["score"])
            for k, e in enumerate(order):
                e.quant(hi if k < n_hi else lo)
            out[L.index] = n_hi
        self.log.append({"op": "reaq", "avg_bits": avg_bits, "hi": hi, "lo": lo, "layers": len(out)})
        return out

    def trim_head(self, keep: Iterable[int]) -> None:
        """Output-only vocab trim: the LM head keeps these token ids at export."""
        ids = sorted({int(i) for i in keep})
        V = self.tc.get("vocab_size") or 0
        if V and ids and ids[-1] >= V:
            raise ValueError(f"token id {ids[-1]} >= vocab_size {V}")
        self.head_vocab = ids
        self.log.append({"op": "trim_head", "keep": len(ids)})

    # ------------------------------------------------------------------ experts
    def _moe_layout(self, layer: int) -> layout.FfnLayout:
        lays = self.layout.layers
        if not 0 <= layer < len(lays) or lays[layer].ffn is None or not lays[layer].ffn.moe:
            raise AnatomyError(f"layer {layer} has no MoE block")
        return lays[layer].ffn

    def _remap_experts(self, layer: int, order: list[int], merges: dict | None, entry: dict) -> None:
        f = self._moe_layout(layer)
        E = f.num_experts
        if not order:
            raise AnatomyError(f"layer {layer}: cannot drop every expert")
        if any(not 0 <= j < E for j in order):
            raise AnatomyError(f"layer {layer}: expert ids must be in 0..{E - 1}")
        rename: dict[tuple, list[tuple]] = {}
        if f.experts:
            old = {}
            for j, roles in f.experts.items():
                for ns in roles.values():
                    for n in ns:
                        old[n] = self._t.pop(n)
            for p, j in enumerate(order):
                for ns in f.experts.get(j, {}).values():
                    for n in ns:
                        new = n.replace(f"{f.prefix}.experts.{j}.", f"{f.prefix}.experts.{p}.", 1)
                        self._t[new] = old[n]
                        rename.setdefault((n, None), []).append((new, None))
            for p, (ids, w) in (merges or {}).items():
                for r, ns in f.experts.get(ids[0], {}).items():
                    for n in ns:
                        rest = n[len(f"{f.prefix}.experts.{ids[0]}."):]
                        srcs = [old[f"{f.prefix}.experts.{j}.{rest}"] for j in ids]
                        self._t[f"{f.prefix}.experts.{p}.{rest}"] = blend(srcs, w, f"merge experts {ids}")
        rowed = [n for ns in f.fused.values() for n in ns] + list(f.router)
        for n in rowed:
            s = self._t[n]
            if not s.shape or s.shape[0] != E:
                continue
            self._t[n] = s.rows(order)
            for p, j in enumerate(order):
                rename.setdefault((n, j), []).append((n, p))
            if n in f.router:
                continue
            for p, (ids, w) in (merges or {}).items():
                self._t[n] = _merged_rows(self._t[n], s, p, ids, w)
        self._carry(rename, keep_untouched=[n for n in rowed])
        if self.hex:
            old_hex = {k: v for k, v in self.hex.items() if k[0] == layer}
            self.hex = {k: v for k, v in self.hex.items() if k[0] != layer}
            for p, j in enumerate(order):
                for (a, b, r), v in old_hex.items():
                    if b == j and not (merges and p in merges):
                        self.hex[(layer, p, r)] = v
        attrs = self.expert_attrs.get(layer) or [{"origin": []} for _ in range(E)]
        new_attrs = [copy.deepcopy(attrs[j]) for j in order]
        for p, (ids, _) in (merges or {}).items():
            new_attrs[p]["origin"] = [o for j in ids for o in attrs[j]["origin"]]
        self.expert_attrs[layer] = new_attrs
        self.log.append(entry)
        self._changed()

    def _carry(self, rename: dict, keep_untouched: Iterable[str] = ()) -> None:
        """Move formats / trainable flags along with renamed tensors and rows."""
        for store in (self.formats, self.trainable):
            moved = {}
            for key in list(store):
                if key in rename:
                    val = store.pop(key)
                    for new in rename[key]:
                        moved[new] = val
                elif key[0] in keep_untouched and key[1] is not None:
                    store.pop(key)          # a dropped row
            store.update(moved)

    def keep_experts(self, layer: int, order: list[int], note: str = "keep") -> None:
        """The experts of `layer` become `order` (current ids; drop, reorder and duplicate in one)."""
        self._remap_experts(layer, list(order), None, {"op": f"experts.{note}", "layer": layer, "order": list(order)})

    def drop_experts(self, layer: int, ids: Iterable[int]) -> None:
        ids = set(int(i) for i in ids)
        E = self._moe_layout(layer).num_experts
        self._remap_experts(layer, [j for j in range(E) if j not in ids], None,
                            {"op": "experts.drop", "layer": layer, "ids": sorted(ids)})

    def duplicate_expert(self, layer: int, expert: int) -> None:
        """Append a copy of an expert (same router row: the two tie until training splits them)."""
        E = self._moe_layout(layer).num_experts
        self._remap_experts(layer, list(range(E)) + [expert], None,
                            {"op": "experts.duplicate", "layer": layer, "id": expert})

    def merge_experts(self, layer: int, ids: list[int], weights: Iterable[float] | str = "freq") -> None:
        """Merge experts into one: a weighted average of their weights ('freq' = share of routed
        tokens, 'score' = REAP score, 'equal', or a list). The merged expert sits at the
        position of the heaviest one and keeps its router row."""
        ids = [int(i) for i in ids]
        if len(set(ids)) < 2:
            raise AnatomyError("merge needs at least two different experts")
        attrs = self.layers[layer].moe.experts
        if isinstance(weights, str):
            key = {"freq": "freq", "score": "score"}.get(weights)
            w = [attrs[j].attrs.get(key) if key else 1.0 for j in ids]
            if any(x is None for x in w):
                w = [1.0] * len(ids)
        else:
            w = [float(x) for x in weights]
        tot = sum(w) or 1.0
        pairs = sorted(zip(ids, [x / tot for x in w]), key=lambda t: -t[1])
        ids, w = [p[0] for p in pairs], [p[1] for p in pairs]
        E = self._moe_layout(layer).num_experts
        order = [j for j in range(E) if j not in ids[1:]]
        self._remap_experts(layer, order, {order.index(ids[0]): (ids, w)},
                            {"op": "experts.merge", "layer": layer, "ids": ids, "weights": [round(x, 4) for x in w]})

    # ------------------------------------------------------------------ layers
    def _relayer(self, plan: list[tuple["Model", int]], entry: dict) -> None:
        lay = self.layout
        pre = lay.prefix
        L_old = len(lay.layers)
        hidden = self.tc.get("hidden_size")
        moved: dict[str, Source] = {}
        rename: dict[tuple, list[tuple]] = {}
        for (m, i) in plan:
            if m is not self and m.tc.get("hidden_size") != hidden:
                raise AnatomyError(f"cannot splice {m.id} layer {i}: hidden size {m.tc.get('hidden_size')} != {hidden}")
            if not 0 <= i < len(m.layout.layers):
                raise AnatomyError(f"{m.id} has no layer {i}")
        srcs = []
        for (m, i) in plan:
            Lm = m.layout.layers[i]
            srcs.append([(n[len(Lm.prefix) + 1:], m._t[n], n if m is self else None) for n in Lm.names])
        mtp = [[(n[len(Lx.prefix) + 1:], self._t[n], n) for n in Lx.names] for Lx in lay.mtp]
        for Lx in lay.layers + lay.mtp:
            for n in Lx.names:
                self._t.pop(n)
        for p, items in enumerate(srcs):
            for rel, s, old in items:
                new = f"{pre}layers.{p}.{rel}"
                moved[new] = s
                if old:
                    for key in [k for k in list(self.formats) + list(self.trainable) if k[0] == old]:
                        rename.setdefault(key, []).append((new, key[1]))
        for k, items in enumerate(mtp):
            for rel, s, old in items:
                new = f"{pre}layers.{len(plan) + k}.{rel}"
                moved[new] = s
                for key in [x for x in list(self.formats) + list(self.trainable) if x[0] == old]:
                    rename.setdefault(key, []).append((new, key[1]))
        dropped = {(n, r) for Lx in lay.layers for n in Lx.names for r in [None]}
        for store in (self.formats, self.trainable):
            keep = {}
            for key, val in store.items():
                if key in rename:
                    for new in rename[key]:
                        keep[new] = val
                elif (key[0], None) not in dropped and not any(key[0] in Lx.names for Lx in lay.mtp):
                    keep[key] = val
            store.clear()
            store.update(keep)
        self._t.update(moved)
        tc = self.tc
        for key, val in list(tc.items()):
            if not isinstance(val, list) or key == "architectures":
                continue
            if len(val) == L_old:
                tc[key] = [(val if m is self else (m.tc.get(key) if isinstance(m.tc.get(key), list) else val))[i]
                           if i < len(val if m is self else (m.tc.get(key) or val)) else val[-1] for (m, i) in plan]
            elif "layer" in key and val and all(isinstance(x, int) and 0 <= x < L_old for x in val):
                tc[key] = [p for p, (m, i) in enumerate(plan)
                           if i in (val if m is self else (m.tc.get(key) or []))]
        tc["num_hidden_layers"] = len(plan)
        old_la, old_ea = self.layer_attrs, self.expert_attrs
        self.layer_attrs = [copy.deepcopy(old_la[i]) if m is self else {"origin": (m.id, i)} for (m, i) in plan]
        new_ea = {}
        for p, (m, i) in enumerate(plan):
            src = old_ea if m is self else m.expert_attrs
            if i in src:
                new_ea[p] = copy.deepcopy(src[i])
                if m is not self:
                    for k, v in m._scores.items():
                        self._scores.setdefault(k, v)
        self.expert_attrs = new_ea
        self.hex = {(p, b, r): v for p, (mm, i) in enumerate(plan) for (a, b, r), v in
                    (self.hex if mm is self else mm.hex).items() if a == i}
        self.log.append(entry)
        self._changed()

    def _self_plan(self) -> list[tuple["Model", int]]:
        return [(self, i) for i in range(len(self.layout.layers))]

    def drop_layers(self, ids: Iterable[int]) -> None:
        ids = {int(i) % len(self.layout.layers) for i in ids}
        self._relayer([x for x in self._self_plan() if x[1] not in ids], {"op": "layers.drop", "ids": sorted(ids)})

    def duplicate_layer(self, i: int, at: int | None = None) -> None:
        """Insert a copy of layer i at position `at` (default: right after it). Depth up-scaling."""
        plan = self._self_plan()
        plan.insert(i + 1 if at is None else at, (self, i))
        self._relayer(plan, {"op": "layers.duplicate", "id": i, "at": i + 1 if at is None else at})

    def reorder_layers(self, order: list[int]) -> None:
        self._relayer([(self, int(i)) for i in order], {"op": "layers.reorder", "order": list(order)})

    def move_layer(self, i: int, to: int) -> None:
        order = list(range(len(self.layout.layers)))
        order.insert(to, order.pop(i))
        self._relayer([(self, j) for j in order], {"op": "layers.move", "id": i, "to": to})

    def splice_layer(self, dst: int, other: "Model", src: int) -> None:
        """Layer dst becomes layer src of `other` (same hidden size; byte-copied at save)."""
        plan = self._self_plan()
        plan[dst] = (other, src)
        self._relayer(plan, {"op": "layers.splice", "dst": dst, "from": other.id, "src": src})

    def insert_layer(self, at: int, other: "Model", src: int) -> None:
        plan = self._self_plan()
        plan.insert(at, (other, src))
        self._relayer(plan, {"op": "layers.insert", "at": at, "from": other.id, "src": src})

    # ------------------------------------------------------------------ neurons
    def prune_neurons(self, layer: int, keep: list[int], shared: bool = False) -> None:
        """Keep these intermediate channels of a dense FFN (or of a MoE's shared expert)."""
        f = self.layout.layers[layer].ffn
        if f is None or (f.moe and not shared) or (shared and not f.shared):
            raise AnatomyError(f"layer {layer} has no {'shared expert' if shared else 'dense MLP'}")
        roles = f.shared if shared else f.proj
        down = self._t[roles["down"][0]]
        I = down.shape[-1]
        if not keep or any(not 0 <= k < I for k in keep):
            raise AnatomyError(f"neuron ids must be in 0..{I - 1}")
        for r, ns in roles.items():
            for n in ns:
                s = self._t[n]
                if r == "down":
                    if len(s.shape) == 2:
                        self._t[n] = columns(s, keep, f"neurons {n}")
                elif r in ("gate", "up"):
                    self._t[n] = s.rows(keep)
                elif r == "gate_up":
                    self._t[n] = s.rows(keep + [I + k for k in keep])
        self.log.append({"op": "neurons.keep", "layer": layer, "shared": shared, "kept": len(keep), "of": I})
        self._changed()

    # ------------------------------------------------------------------ config
    def synced_config(self) -> dict:
        """config.json for the model as it is now."""
        cfg = copy.deepcopy(self.config)
        tc = cfg.get("text_config") or cfg.get("language_config") or cfg
        lay = self.layout
        counts = {L.ffn.num_experts for L in lay.layers if L.ffn and L.ffn.moe}
        if len(counts) == 1:
            E = counts.pop()
            for c in (tc, cfg):
                for k in EXPERT_KEYS:
                    if isinstance(c.get(k), int) and c[k] > 1:
                        c[k] = E
                for k in TOP_K_KEYS:
                    if isinstance(c.get(k), int) and c[k] > E:
                        c[k] = E
        dense = {self._t[L.ffn.proj["down"][0]].shape[-1] for L in lay.layers
                 if L.ffn and not L.ffn.moe and "down" in L.ffn.proj}
        if len(dense) == 1 and isinstance(tc.get("intermediate_size"), int):
            tc["intermediate_size"] = dense.pop()
        sh = {self._t[L.ffn.shared["down"][0]].shape[-1] for L in lay.layers
              if L.ffn and L.ffn.moe and "down" in L.ffn.shared}
        if len(sh) == 1 and isinstance(tc.get("shared_expert_intermediate_size"), int):
            tc["shared_expert_intermediate_size"] = sh.pop()
        if lay.mtp is not None and tc.get("num_nextn_predict_layers") and not lay.mtp:
            tc["num_nextn_predict_layers"] = 0
        return cfg

    def problems(self) -> list[str]:
        """What would make the saved checkpoint unloadable by stock loaders."""
        out = []
        lay = self.layout
        counts = {L.index: L.ffn.num_experts for L in lay.layers if L.ffn and L.ffn.moe}
        if len(set(counts.values())) > 1:
            out.append("MoE layers have different expert counts "
                       f"({', '.join(f'{k}:{v}' for k, v in sorted(counts.items()))}); Hugging Face configs hold "
                       "one count, so keep the same number in every layer")
        if counts:
            E = min(counts.values())
            k = self.top_k
            if k and k > E:
                out.append(f"top-k {k} is more than the {E} experts left")
            g = self.tc.get("n_group")
            if isinstance(g, int) and g > 1 and any(v % g for v in counts.values()):
                out.append(f"expert counts must divide into n_group={g} groups")
        dense = {L.index: self._t[L.ffn.proj["down"][0]].shape[-1] for L in lay.layers
                 if L.ffn and not L.ffn.moe and "down" in L.ffn.proj}
        if len(set(dense.values())) > 1:
            out.append("dense MLPs have different widths "
                       f"({', '.join(f'{k}:{v}' for k, v in sorted(dense.items()))}); intermediate_size is one number")
        sh = {self._t[L.ffn.shared["down"][0]].shape[-1] for L in lay.layers if L.ffn and L.ffn.moe and "down" in L.ffn.shared}
        if sh and self.tc.get("n_shared_experts") and not self.tc.get("shared_expert_intermediate_size"):
            base = self.tc.get("n_shared_experts") * (self.tc.get("moe_intermediate_size") or 0)
            if sh != {base}:
                out.append("this config sizes the shared expert as n_shared_experts x moe_intermediate_size; "
                           "pruned shared-expert widths cannot be expressed")
        from blackhole.hw.model import _moe_layers
        cfg_moe = _moe_layers(self.synced_config().get("text_config") or self.synced_config(),
                              max(counts.values()) if counts else 0)
        if counts and cfg_moe != len(counts):
            out.append(f"the config's rule for which layers are MoE (first_k_dense_replace / decoder_sparse_step / "
                       f"mlp_only_layers) gives {cfg_moe} MoE layers, the checkpoint has {len(counts)}")
        return out

    # ------------------------------------------------------------------ size and fit
    def _group(self) -> dict[str, str]:
        lay = self.layout
        g = {}
        for n in lay.embed:
            g[n] = "embed"
        for n in lay.head:
            g[n] = "head"
        for n in lay.norm:
            g[n] = "norms"
        for n in lay.other:
            g[n] = "other"
        for Lx in lay.mtp:
            for n in Lx.names:
                g[n] = "mtp"
        for Lx in lay.layers:
            for n in Lx.names:
                g[n] = "other"
            for ns in Lx.attn.values():
                for n in ns:
                    g[n] = "attention" if Lx.attn_kind == "attention" else "mixer"
            for n in Lx.norms:
                g[n] = "norms"
            f = Lx.ffn
            if f:
                for ns in f.proj.values():
                    for n in ns:
                        g[n] = "mlp"
                for n in f.router:
                    g[n] = "router"
                for roles in list(f.experts.values()) + [f.fused]:
                    for ns in roles.values():
                        for n in ns:
                            g[n] = "experts"
                for ns in f.shared.values():
                    for n in ns:
                        g[n] = "shared"
        return g

    def _tensor_bytes(self, name: str) -> float:
        s = self._t[name]
        fmt = self.formats.get((name, None))
        bits = formats.bpw(fmt) if fmt else st.BITS[s.dtype]
        total = s.numel * bits / 8
        rows = {r: f for (n, r), f in self.formats.items() if n == name and r is not None}
        if rows and s.shape:
            per = s.numel / s.shape[0]
            for r, f in rows.items():
                if r < s.shape[0]:
                    total += per * (formats.bpw(f) - bits) / 8
        return total

    def _footprint(self) -> dict:
        g = self._group()
        out: dict[str, dict] = {}
        V = self.tc.get("vocab_size") or 0
        for n, s in self._t.items():
            grp = g.get(n, "other")
            b = self._tensor_bytes(n)
            if grp == "head" and self.head_vocab and V:
                b *= len(self.head_vocab) / V
            row = out.setdefault(grp, {"params": 0, "bytes": 0.0})
            row["params"] += s.numel
            row["bytes"] += b
        return out

    def plan(self, device: str | None = None, budget_gb: float | None = None, context: int = 8192,
             kv_bits: int = 16, bandwidth_gbs: float | None = None) -> "Plan":
        """Size of the model as edited (formats included), its KV cache at `context`, active
        bytes per token, and whether it fits a device (blackhole.hw.DEVICES name) or budget."""
        from blackhole.hw import DEVICES
        from blackhole.hw.model import from_config
        fp = self._footprint()
        total = sum(r["bytes"] for r in fp.values())
        info = from_config(self.id, self.synced_config(), 0)
        E = max([L.ffn.num_experts for L in self.layout.layers if L.ffn and L.ffn.moe] or [0])
        k = self.top_k
        active = sum(r["bytes"] for gname, r in fp.items() if gname not in ("experts", "embed", "mtp"))
        if self.head is not None and self.head.attrs.get("tied"):
            active += fp.get("embed", {}).get("bytes", 0)
        if E:
            active += fp.get("experts", {}).get("bytes", 0) * min(k, E) / E
        kv = info.kv_bytes_per_token * kv_bits / 16 * context
        usable = budget_gb
        if device:
            if device not in DEVICES:
                raise ValueError(f"unknown device {device!r}; one of {sorted(DEVICES)}")
            mem, bw, kind = DEVICES[device]
            usable = budget_gb or mem * {"metal": 0.75, "cuda": 0.92, "cpu": 0.7}[kind]
            bandwidth_gbs = bandwidth_gbs or bw
        before = sum(r["bytes"] for r in self._before.values())
        return Plan(groups={g: {"params": r["params"], "gb": r["bytes"] / 1e9} for g, r in sorted(fp.items())},
                    total_gb=total / 1e9, before_gb=before / 1e9,
                    params_b=sum(r["params"] for r in fp.values()) / 1e9,
                    active_gb=active / 1e9, kv_gb=kv / 1e9, context=context, device=device, budget_gb=usable,
                    tok_s=(0.7 * bandwidth_gbs / (active / 1e9)) if bandwidth_gbs and active else None,
                    problems=self.problems())

    # ------------------------------------------------------------------ saving
    def receipt(self) -> dict:
        after = self._footprint()
        return {"api": API, "base": self.id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "edits": self.log, "functions": self.functions,
                "formats": {f"{n}" if r is None else f"{n}[{r}]": f for (n, r), f in sorted(self.formats.items())},
                "trainable": {f"{n}" if r is None else f"{n}[{r}]": t for (n, r), t in sorted(self.trainable.items())},
                "head_vocab": self.head_vocab,
                "scores": self._scores_now(),
                "layers": [{"origin": list(a["origin"])} for a in self.layer_attrs],
                "experts": {str(L): [[list(o) for o in a["origin"]] for a in attrs] for L, attrs in self.expert_attrs.items()},
                "before": {g: {"params": r["params"], "gb": round(r["bytes"] / 1e9, 4)} for g, r in self._before.items()},
                "after": {g: {"params": r["params"], "gb": round(r["bytes"] / 1e9, 4)} for g, r in after.items()}}

    def _scores_now(self) -> dict:
        """REAP scores of the experts as they are now (for the receipt; reloaded by open())."""
        out = {}
        for L in self.layers:
            if L.moe is None:
                continue
            sc = [e.attrs.get("score") for e in L.moe.experts]
            if all(x is not None for x in sc):
                out[str(L.index)] = {"saliency": sc, "freq": [e.attrs.get("freq") for e in L.moe.experts]}
        return out

    def save(self, dst: str | Path, force: bool = False, shard_gb: float = 4.0, on_progress=None) -> Path:
        """Write the edited model to dst: safetensors shards (byte copies where possible), the
        synced config.json, the source's tokenizer and other files, blackhole-anatomy.json
        and blackhole-lineage.json. Refuses when problems() is not empty unless force=True."""
        probs = self.problems()
        if probs and not force:
            raise AnatomyError("the edited model would not load:\n  - " + "\n  - ".join(probs)
                               + "\n(save(force=True) writes it anyway)")
        dst = Path(dst).expanduser()
        tmp = dst.with_name(dst.name + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        names = sorted(self._t, key=_natural)
        shards, cur, size = [], [], 0
        for n in names:
            b = self._t[n].nbytes
            if cur and size + b > shard_gb * 1e9:
                shards.append(cur)
                cur, size = [], 0
            cur.append(n)
            size += b
        if cur:
            shards.append(cur)
        wmap, total = {}, 0
        for i, group in enumerate(shards):
            fname = "model.safetensors" if len(shards) == 1 else f"model-{i + 1:05d}-of-{len(shards):05d}.safetensors"
            total += st.write_file(tmp / fname, [(n, self._t[n].dtype, self._t[n].shape, self._t[n]) for n in group],
                                   {"format": "pt"})
            wmap.update({n: fname for n in group})
            if on_progress:
                on_progress(i + 1, len(shards), fname)
        if len(shards) > 1:
            (tmp / "model.safetensors.index.json").write_text(
                json.dumps({"metadata": {"total_size": total}, "weight_map": wmap}, indent=2) + "\n")
        (tmp / "config.json").write_text(json.dumps(self.synced_config(), indent=2) + "\n")
        for p in self.extra_files:
            if p.is_file():
                shutil.copy2(p, tmp / p.name)
        rec = self.receipt()
        rec["output_bytes"] = total
        if self.hex:          # the HEX headers, so hex-pack can run on the saved model later
            self._save_hex(tmp / "blackhole-hex.safetensors")
            rec["hex_sidecar"] = "blackhole-hex.safetensors"
        (tmp / "blackhole-anatomy.json").write_text(json.dumps(rec, indent=2, default=str) + "\n")
        prev = {"base": self.id, "steps": []}
        if self.root and (self.root / "blackhole-lineage.json").exists():
            prev = json.loads((self.root / "blackhole-lineage.json").read_text())
        step = {"uses": "anatomy", "edits": len(self.log), "functions": self.functions}
        (tmp / "blackhole-lineage.json").write_text(
            json.dumps({**prev, "steps": prev["steps"] + [step]}, indent=2, default=str) + "\n")
        shutil.rmtree(dst, ignore_errors=True)
        tmp.rename(dst)
        return dst

    def _save_hex(self, path: Path) -> None:
        items = []
        for (L, j, role), h in sorted(self.hex.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
            pre = f"{L}.{j}.{role}"
            parts = h.packed()
            for name, dt in (("idx", "U32"), ("block_scale", "U8"), ("expert_scale", "F32"), ("levels", "F32")):
                a = parts[name]
                items.append((f"{pre}.{name}", dt, a.shape, _Const(a)))
            items.append((f"{pre}.shape", "I64", (2,), _Const(np.array(h.shape, np.int64))))
        st.write_file(path, items, {"format": "blackhole-hex", "block": str(next(iter(self.hex.values())).block)})

    def _load_hex(self, path: Path) -> None:
        from blackhole.anatomy import hex as hx
        ents = {e.name: e for e in st.entries(st.Blob(str(path)))}
        block = int((ents[next(iter(ents))].blob.header()[0].get("__metadata__") or {}).get("block", hx.HEX_BLOCK))
        keys = {n.rsplit(".", 1)[0] for n in ents}
        for k in keys:
            L, j, role = k.split(".", 2)
            get = lambda n: np.asarray(ents[f"{k}.{n}"].blob.array(ents[f"{k}.{n}"].offset, ents[f"{k}.{n}"].dtype, ents[f"{k}.{n}"].shape))  # noqa: E731
            parts = {n: get(n) for n in ("idx", "block_scale", "expert_scale", "levels")}
            self.hex[(int(L), int(j), role)] = hx.unpack_expert(parts, tuple(int(x) for x in get("shape")), block=block)

    def call(self, name: str, select: str | None = None, **params):
        """Run a named function (blackhole_dev.functions) on this model."""
        from blackhole_dev.functions import call
        return call(self, name, select, **params)

    def live(self, **kw):
        """The model in torch (transformers), with parts mapped to modules: see blackhole_dev.live."""
        from blackhole_dev.live import LiveModel
        return LiveModel(self, **kw)

    def summary(self) -> str:
        """A readable tree of the model."""
        i = self.info
        lines = [f"{self.id}  {i.model_type}  {'/'.join(i.kinds)}  {self.params / 1e9:.3g}B params"
                 + (f", {i.experts} experts top-{i.top_k}" if i.experts else "")]
        for p in (self.embed, self.head, self.norm):
            if p is not None:
                lines.append(f"  {p.path:<8} {p.params:>14,}  {', '.join(f'{v.name} {v.dtype}{list(v.shape)}' for v in p.views[:2])}"
                             + ("  (tied to embed)" if p.attrs.get("tied") else ""))
        prev = None
        run = 0
        layers = self.layers
        for L in layers + [None]:
            sig = None if L is None else _layer_sig(L)
            if sig == prev and L is not None:
                run += 1
                continue
            if prev is not None and run:
                lines.append(f"  ... {run} more like it")
            if L is None:
                break
            lines.append(f"  layers.{L.index:<3} {L.attrs['kind']:<18} {L.params:>12,}  {sig}")
            prev, run = sig, 0
        if self.mtp:
            lines.append(f"  mtp      {len(self.mtp)} multi-token-prediction layer(s)")
        if self.layout.other:
            lines.append(f"  other    {len(self.layout.other)} tensors (e.g. {self.layout.other[0]})")
        return "\n".join(lines)


class _Const:
    def __init__(self, a: np.ndarray):
        self.a = np.ascontiguousarray(a)

    @property
    def nbytes(self) -> int:
        return self.a.nbytes

    def write(self, fd: int) -> None:
        import os
        os.write(fd, self.a.tobytes())


def _layer_sig(L: Layer) -> str:
    bits = []
    if L.attn is not None:
        h = L.attn._heads_info
        bits.append(f"attn {'/'.join(L.attn.roles)}" + (f" {h[0]}h/{h[1]}kv x{h[2]}" if h else ""))
    if L.mixer is not None:
        bits.append("mixer " + "/".join(list(L.mixer.roles)[:4]))
    if L.moe is not None:
        bits.append(f"moe {L.moe.num_experts}e" + (f" +shared {L.moe.shared.neurons}" if L.moe.shared else "")
                    + (" fused" if not any(v.index is None for e in L.moe.experts[:1] for v in e.views) else ""))
    if L.mlp is not None:
        bits.append(f"mlp {L.mlp.neurons}")
    return ", ".join(bits)


def _merged_rows(rowed: Source, orig: Source, p: int, ids: list[int], w: list[float]) -> Lazy:
    def fn():
        a = rowed.float()
        o = orig.float()
        a[p] = sum(np.float32(x) * o[j] for j, x in zip(ids, w))
        return st.encode(a, rowed.dtype)
    return Lazy(rowed.dtype, rowed.shape, fn, f"merge rows {ids}")


@dataclass
class Plan:
    groups: dict
    total_gb: float
    before_gb: float
    params_b: float
    active_gb: float
    kv_gb: float
    context: int
    device: str | None = None
    budget_gb: float | None = None
    tok_s: float | None = None
    problems: list = field(default_factory=list)

    @property
    def fits(self) -> bool | None:
        return None if self.budget_gb is None else self.total_gb + self.kv_gb <= self.budget_gb

    def to_dict(self) -> dict:
        from dataclasses import asdict
        return asdict(self) | {"fits": self.fits}

    def __str__(self) -> str:
        lines = [f"{'part':<10} {'params':>15} {'GB':>9}"]
        for g, r in self.groups.items():
            lines.append(f"{g:<10} {r['params']:>15,} {r['gb']:>9.3f}")
        lines.append(f"{'total':<10} {int(self.params_b * 1e9):>15,} {self.total_gb:>9.3f}   (was {self.before_gb:.3f} GB)")
        lines.append(f"active per token {self.active_gb:.3f} GB, KV cache {self.kv_gb:.3f} GB at {self.context} tokens")
        if self.budget_gb is not None:
            lines.append(f"{'fits' if self.fits else 'does NOT fit'} {self.device or 'the budget'}: "
                         f"{self.total_gb + self.kv_gb:.2f} of {self.budget_gb:.2f} GB usable")
        if self.tok_s:
            lines.append(f"decode roughly {self.tok_s:.0f} tok/s (memory-bound estimate)")
        lines += [f"! {p}" for p in self.problems]
        return "\n".join(lines)


# --------------------------------------------------------------------------- opening


def open(model: str | Path, revision: str | None = None, token: str | None = None,  # noqa: A001
         download: bool = False) -> Model:
    """Open a checkpoint: a local folder, or a Hugging Face id. A Hub model is read in
    place (config + safetensors headers, a few KB; tensors on demand with range requests)
    unless download=True, which fetches the whole snapshot first."""
    p = Path(str(model)).expanduser()
    if p.is_dir():
        return _open_dir(p, str(model))
    rid = str(model)
    if download:
        from huggingface_hub import snapshot_download
        local = snapshot_download(rid, revision=revision, token=token,
                                  allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.py", "*.jinja", "*.tiktoken"])
        return _open_dir(Path(local), rid)
    from huggingface_hub import HfApi, hf_hub_download, hf_hub_url
    from huggingface_hub.utils import build_hf_headers
    cfg = json.loads(Path(hf_hub_download(rid, "config.json", revision=revision, token=token)).read_text())
    files = [f for f in HfApi().list_repo_files(rid, revision=revision, token=token) if f.endswith(".safetensors")]
    if not files:
        raise FileNotFoundError(f"{rid} has no safetensors files")
    headers = build_hf_headers(token=token)
    ents = []
    for f in sorted(files):
        ents += st.entries(st.Blob(hf_hub_url(rid, f, revision=revision), headers))
    return Model(rid, None, cfg, ents)


def _open_dir(root: Path, model_id: str) -> Model:
    cfgp = root / "config.json"
    if not cfgp.exists():
        raise FileNotFoundError(f"no config.json in {root}")
    cfg = json.loads(cfgp.read_text())
    ents = []
    for f in st.checkpoint_files(root):
        ents += st.entries(st.Blob(str(root / f)))
    extra = [p for p in sorted(root.iterdir()) if p.is_file() and p.name not in SKIP_FILES
             and not p.name.endswith(WEIGHT_SUFFIXES)]
    m = Model(model_id, root, cfg, ents, extra)
    if (root / "blackhole-hex.safetensors").exists():
        m._load_hex(root / "blackhole-hex.safetensors")
    if (root / "blackhole-anatomy.json").exists():
        m.notes["previous_receipt"] = {"path": str(root / "blackhole-anatomy.json")}
        prev = json.loads((root / "blackhole-anatomy.json").read_text())
        if prev.get("scores"):
            m.load_scores({int(k): {"saliency": v["saliency"], "freq": [f if f is not None else 0 for f in v["freq"]]}
                           for k, v in prev["scores"].items()})
            m.log.clear()
    return m


def diff(a: Model, b: Model, names: Iterable[str] | None = None) -> list[dict]:
    """Per-tensor relative difference ||a - b|| / ||a|| and cosine for tensors both models
    hold with the same shape: what an edit, a heal or a quantizer changed."""
    out = []
    for n in sorted(names or (set(a._t) & set(b._t)), key=_natural):
        if n not in a._t or n not in b._t or a._t[n].shape != b._t[n].shape:
            continue
        x, y = a._t[n].float().astype(np.float64).ravel(), b._t[n].float().astype(np.float64).ravel()
        nx, ny = float(np.linalg.norm(x)), float(np.linalg.norm(y))
        out.append({"tensor": n, "rel_diff": float(np.linalg.norm(x - y)) / (nx or 1e-30),
                    "cosine": float(x @ y) / ((nx * ny) or 1e-30), "max_abs": float(np.abs(x - y).max(initial=0.0))})
    return out


def sha256_file(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
