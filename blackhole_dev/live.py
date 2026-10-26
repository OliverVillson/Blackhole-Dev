"""The model running in torch, with anatomy parts mapped onto its modules and parameters.

    live = m.live(device="cuda")                  # saves pending edits to a temp folder first
    live.reap_scores(texts)                       # REAP saliency, written back onto m's experts
    live.neuron_scores(texts)                     # E|h| * ||W_down col|| per dense FFN channel
    live.train_only("layers[*].moe.router")       # requires_grad + gradient masks
    live.kl(base, texts)                          # what an edit cost: KL and top-1 agreement

Checkpoint tensors and torch parameters do not always line up: transformers 5 loads per-expert
checkpoint keys into fused [E, ...] parameters. param_for() maps a View to (parameter, index),
and freezing one expert of a fused tensor is a gradient mask on its rows.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Iterable

import numpy as np

from blackhole_dev.model import Model
from blackhole_dev.parts import Selection, View
from blackhole_dev.sources import File


def dirty(m: Model) -> bool:
    """True when the model's weights or config differ from its source folder."""
    if m.root is None or m.config != m._config0:
        return True
    return any(not (isinstance(s, File) and s._rows is None and s.entry.name == n) for n, s in m._t.items())


class LiveModel:
    def __init__(self, model: Model, device: str = "cpu", dtype=None, trust_remote_code: bool = False):
        import torch
        import transformers
        self.anatomy = model
        src = model.root
        if dirty(model):
            src = model.save(Path(tempfile.mkdtemp(prefix="bh-live-")) / "model", force=True)
        self.path = Path(src)
        kw = {"dtype": dtype or "auto", "trust_remote_code": trust_remote_code}
        try:
            mod = transformers.AutoModelForCausalLM.from_pretrained(src, **kw)
        except (ValueError, KeyError):
            mod = transformers.AutoModelForImageTextToText.from_pretrained(src, **kw)
        self.module = mod.to(device).eval()
        self.device = device
        self.params = dict(self.module.named_parameters())
        self._masks: dict[str, "torch.Tensor"] = {}
        self._hooks = {}
        self._tok = None

    # ------------------------------------------------------------------ mapping
    def param_for(self, view: View):
        """(parameter name, index or None) holding the weights of an anatomy view."""
        name = view.name
        for cand in (name, name.replace("model.language_model.", "model."),
                     name.replace("model.", "model.language_model.", 1)):
            if cand in self.params:
                return cand, view.index
        if ".experts." in name:          # per-expert checkpoint key, fused parameter in torch
            pre, rest = name.split(".experts.", 1)
            j, proj, *_ = rest.split(".")
            j = int(j)
            role = {"gate_proj": "gate", "w1": "gate", "up_proj": "up", "w3": "up", "down_proj": "down",
                    "w2": "down"}.get(proj)
            for p in (pre, pre.replace("model.language_model.", "model.")):
                gu, dn = f"{p}.experts.gate_up_proj", f"{p}.experts.down_proj"
                if role in ("gate", "up") and gu in self.params:
                    half = self.params[gu].shape[1] // 2
                    return gu, (j, slice(0, half) if role == "gate" else slice(half, 2 * half))
                if role == "down" and dn in self.params:
                    return dn, (j,)
        raise KeyError(f"no parameter holds {name}")

    def _views(self, what) -> list[View]:
        if isinstance(what, str):
            what = self.anatomy.select(what)
        if isinstance(what, View):
            return [what]
        if isinstance(what, Selection) or isinstance(what, list):
            return [v for p in what for v in (p.views if hasattr(p, "views") else [p])]
        return list(what.views)

    def module_of(self, part):
        """The torch module of a part (a layer, attention, MoE block, router, ...), by path."""
        name = self.param_for(part.views[0])[0].rsplit(".", 1)[0]
        if part.kind in ("layer", "attention", "mixer", "mlp", "moe"):
            depth = {"layer": 0, "attention": 1, "mixer": 1, "mlp": 1, "moe": 1}[part.kind]
            parts = name.split(".")
            i = parts.index("layers")
            name = ".".join(parts[:i + 2 + depth])
        return self.module.get_submodule(name)

    # ------------------------------------------------------------------ training masks
    def _set(self, views: Iterable[View], flag: bool) -> int:
        import torch
        n = 0
        for v in views:
            pname, idx = self.param_for(v)
            p = self.params[pname]
            mask = self._masks.get(pname)
            if mask is None:
                mask = torch.full_like(p, 1.0 if p.requires_grad else 0.0, dtype=torch.float32)
                self._masks[pname] = mask
            if idx is None:
                mask.fill_(1.0 if flag else 0.0)
            else:
                mask[idx] = 1.0 if flag else 0.0
            p.requires_grad_(bool(mask.any()))
            if pname not in self._hooks and p.requires_grad:
                self._hooks[pname] = p.register_hook(lambda g, _m=mask: g * _m.to(g.dtype))
            n += 1
        return n

    def freeze(self, what) -> int:
        return self._set(self._views(what), False)

    def train(self, what) -> int:
        return self._set(self._views(what), True)

    def train_only(self, what) -> int:
        """Freeze everything, then make `what` trainable."""
        for p in self.params.values():
            p.requires_grad_(False)
        for pname in list(self._masks):
            self._masks[pname].zero_()
        return self.train(what)

    def apply_manifest(self) -> int:
        """The anatomy model's freeze()/train() marks, applied to the parameters."""
        n = 0
        for (name, row), flag in self.anatomy.trainable.items():
            n += self._set([View(self.anatomy, name, None if row is None else (row,))], flag)
        return n

    def trainable_params(self) -> int:
        return int(sum(float(self._masks[n].sum()) if n in self._masks else (p.numel() if p.requires_grad else 0)
                       for n, p in self.params.items()))

    # ------------------------------------------------------------------ running
    @property
    def tokenizer(self):
        if self._tok is None:
            from transformers import AutoTokenizer
            self._tok = AutoTokenizer.from_pretrained(self.path)
        return self._tok

    def _batches(self, data, max_seq: int):
        import torch
        for x in data:
            ids = self.tokenizer(x, return_tensors="pt").input_ids[:, :max_seq] if isinstance(x, str) \
                else torch.as_tensor(x).reshape(1, -1)[:, :max_seq]
            yield ids.to(self.device)

    def logits(self, data, max_seq: int = 2048) -> list:
        import torch
        out = []
        with torch.no_grad():
            for ids in self._batches(data, max_seq):
                out.append(self.module(input_ids=ids).logits[0].float().cpu())
        return out

    def kl(self, other, data, max_seq: int = 2048) -> dict:
        """Mean KL(self || other) per token over the full vocabulary, and top-1 agreement:
        the measure every recipe in this project is judged by. `other` is a LiveModel or a Model."""
        import torch
        if isinstance(other, Model):
            other = other.live(device=self.device)
        data = list(data)
        kls, agree, n = 0.0, 0, 0
        for a, b in zip(self.logits(data, max_seq), other.logits(data, max_seq)):
            V = min(a.shape[-1], b.shape[-1])
            la, lb = a[:, :V].log_softmax(-1), b[:, :V].log_softmax(-1)
            kls += float((la.exp() * (la - lb)).sum())
            agree += int((a[:, :V].argmax(-1) == b[:, :V].argmax(-1)).sum())
            n += a.shape[0]
        return {"kl": kls / max(n, 1), "top1": agree / max(n, 1), "tokens": n}

    def reap_scores(self, data, max_seq: int = 2048) -> dict:
        """REAP saliency of every expert (router-weighted expert output norms over the tokens of
        `data`), written onto the anatomy model's experts (score, freq, rank)."""
        import torch
        try:
            from reaper_pipeline.moe import Saliency
        except ImportError as e:
            raise ImportError("REAP scoring uses reaper_pipeline (pip install -e 'reaper[pipeline]')") from e
        sal = Saliency(self.module)
        try:
            with torch.no_grad():
                for ids in self._batches(data, max_seq):
                    self.module(input_ids=ids)
        finally:
            sal.remove()
        res = sal.results()
        by_layer = {b.layer: b for b in sal.blocks}
        for L, r in res.items():
            tot = sum(r["freq"]) or 1.0
            if L in self.anatomy.expert_attrs:
                self.anatomy.set_scores(L, r["saliency"], [f / tot for f in r["freq"]])
        self.anatomy.log.append({"op": "reap_scores", "layers": len(res)})
        return {L: {"module": by_layer[L].name, **r} for L, r in res.items()}

    def neuron_scores(self, data, max_seq: int = 2048, select: str = "layers[*].mlp") -> dict:
        """Activation-scored importance of every intermediate channel of the matched MLPs:
        mean |h| over the tokens of `data` times the norm of the channel's down_proj column."""
        import torch
        parts = self.anatomy.select(select)
        sums, hooks, count = {}, [], {}
        for p in parts:
            down = self.module.get_submodule(self.param_for(p.roles["down"])[0].rsplit(".", 1)[0])
            L = p.attrs["layer"]

            def hook(_m, args, _L=L):
                h = args[0].detach().float().reshape(-1, args[0].shape[-1])
                sums[_L] = sums.get(_L, 0) + h.abs().sum(0).cpu()
                count[_L] = count.get(_L, 0) + h.shape[0]
            hooks.append(down.register_forward_pre_hook(hook))
        try:
            with torch.no_grad():
                for ids in self._batches(data, max_seq):
                    self.module(input_ids=ids)
        finally:
            for h in hooks:
                h.remove()
        out = {}
        for p in parts:
            L = p.attrs["layer"]
            col = p.roles["down"].norms(axis=0)
            out[L] = (sums[L].numpy() / max(count[L], 1)) * col
        return out

    def to_anatomy(self) -> Model:
        """Write the live weights back into the anatomy model (after training): every
        parameter that maps to a checkpoint tensor becomes a weight write."""
        m = self.anatomy
        for name in list(m._t):
            try:
                pname, idx = self.param_for(View(m, name))
            except KeyError:
                continue
            t = self.params[pname].detach().float().cpu().numpy()
            val = t if idx is None else t[idx]
            if tuple(val.shape) == tuple(m._t[name].shape):
                m.tensor(name).set(np.ascontiguousarray(val))
        return m


def _expert_hessians(self, data, max_seq: int = 2048, layers: Iterable[int] | None = None) -> dict:
    """GPTQ inputs for HEX: per (layer, expert) the Hessians sum x x^T of the expert's gate_up
    input (the tokens routed to it) and of its down input (act(gate) * up), plus the token
    count. Works on fused experts (transformers 5) and ModuleList experts."""
    import torch
    import torch.nn.functional as F
    from blackhole_dev.layout import ROLE
    m = self.anatomy
    want = set(layers) if layers is not None else {L.index for L in m.layers if L.moe}
    stats: dict = {}
    hooks = []
    act = None
    try:
        from transformers.activations import ACT2FN
        act = ACT2FN[m.tc.get("hidden_act", "silu")]
    except Exception:  # noqa: BLE001
        act = F.silu

    def add(key, role, x):
        x = x.reshape(-1, x.shape[-1]).float()
        d = stats.setdefault(key, {"tokens": 0})
        d[role] = d.get(role, 0) + (x.T @ x).double().cpu().numpy()
        if role == "gate_up":
            d["tokens"] += x.shape[0]

    for L in m.layers:
        if L.moe is None or L.index not in want:
            continue
        ex = self.module_of(L.moe).experts
        li = L.index
        if isinstance(ex, torch.nn.ModuleList):
            for j, e in enumerate(ex):
                first = next((getattr(e, n) for n in ("gate_proj", "w1", "gate_up_proj") if hasattr(e, n)), None)
                down = next((getattr(e, n) for n in ("down_proj", "w2") if hasattr(e, n)), None)
                if first is not None:
                    hooks.append(first.register_forward_pre_hook(lambda _m, a, _k=(li, j): add(_k, "gate_up", a[0])))
                if down is not None:
                    hooks.append(down.register_forward_pre_hook(lambda _m, a, _k=(li, j): add(_k, "down", a[0])))
            continue
        gu = getattr(ex, "gate_up_proj", None)
        gate, up = getattr(ex, "gate_proj", None), getattr(ex, "up_proj", None)

        def hook(_m, args, kwargs, _li=li, _gu=gu, _gate=gate, _up=up):
            ts = [t for t in list(args) + list(kwargs.values()) if isinstance(t, torch.Tensor)]
            x = next(t for t in ts if t.is_floating_point())
            idx = next((t for t in ts if not t.is_floating_point() and t.dim() >= 2), None)
            x = x.reshape(-1, x.shape[-1])
            if idx is None:
                return
            idx = idx.reshape(x.shape[0], -1)
            for j in torch.unique(idx).tolist():
                tok = torch.where((idx == j).any(-1))[0]
                xj = x[tok]
                add((_li, j), "gate_up", xj)
                with torch.no_grad():
                    if _gu is not None:
                        W = _gu[j]
                        h = xj.float() @ (W.float().T if W.shape[-1] == xj.shape[-1] else W.float())
                        g, u = h.chunk(2, dim=-1)
                        if getattr(_m, "alpha", None) is not None:          # gpt-oss interleaves gate/up
                            g, u = h[..., ::2], h[..., 1::2]
                    else:
                        g = xj.float() @ _gate[j].float().T
                        u = xj.float() @ _up[j].float().T
                    add((_li, j), "down", act(g) * u)
        hooks.append(ex.register_forward_pre_hook(hook, with_kwargs=True))
    try:
        with torch.no_grad():
            for ids in self._batches(data, max_seq):
                self.module(input_ids=ids)
    finally:
        for h in hooks:
            h.remove()
    return stats


LiveModel.expert_hessians = _expert_hessians
