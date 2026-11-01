"""Shared code of the task-map functions (task-prompts, task-trace, task-predictor, task-preload,
task-eval): find the parts of a dense model a task actually uses, learn to predict them from the
prompt, and keep those parts at high precision (or resident in fast memory) while the rest is
compressed or left out. A fork may import it or copy it.

The workflow, on a dense decoder (Llama, Qwen2/2.5/3, Mistral, Gemma style: model.layers[i] with
a gate/up/down SwiGLU FFN and an o_proj attention output):

1. prompts:   a task set (your file, a named set, or prompts the base model writes from a
              one-line description), split into train and held-out, plus a general set to
              contrast with. The base model's own answers are added so the later steps measure
              the tokens the task really produces.
2. trace:     one forward pass per prompt with hooks. Per layer it records how much each FFN
              neuron contributes (|h_j| x ||down_proj[:, j]||, h = act(gate) * up), how much each
              attention head writes (||o_proj[:, head] x_head||), how much the layer changes the
              residual stream, and the mean hidden state of the prompt at a probe layer.
3. predictor: neurons are ranked by their mean task contribution and grouped into blocks of
              `block_size` (the preload unit). A ridge regression maps the probe-layer feature of
              a prompt to every block's (log) contribution, so a runtime can pick each prompt's
              hot blocks right after prefill reaches the probe layer. Its recall (share of the
              true top blocks' contribution it finds) is reported next to the static task
              ranking, a random pick and the oracle.
4. preload:   the static task plan: in each layer the top `budget` share of neurons (and heads)
              stays at `hot_format`, the rest goes to `cold_format` ("off" = left out). Neurons
              are permuted hot-first (an exact rewrite of the FFN), so the hot part of every layer
              is one contiguous range: the preload map a runtime loads first. Written as the
              job's model with blackhole-preload.json next to it.
5. eval:      the same budget chosen four ways (task plan, general-data plan, random, and the
              predictor per prompt, plus the oracle), all against the base model on held-out task
              prompts and on general prompts: KL, top-1 agreement, answer NLL, size, speed.

Quantization here is round-to-nearest onto the format's grid (blackhole.anatomy.formats), which
is the right tool to compare precision plans; for the model you ship, GPTQ the cold part after.
Everything works on a transformers model and numpy arrays, so it runs on any CPU (the tests use
a tiny random Qwen3 and Llama) and on the GPU VM as job functions. Files: <job>/reaper/work/taskmap/.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np

from blackhole_dev.functions_src import _smoe

load = _smoe.load
tokenizer = _smoe.tokenizer
model_path = _smoe.model_path
input_device = _smoe.input_device

SETS = ("train", "heldout", "general")
_INT = re.compile(r"^int(\d)(?:_g(\d+))?$")


def log(msg: str) -> None:
    print(f"[taskmap {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def work(job) -> Path:
    p = job.path("work", "taskmap")
    p.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------------- 1. prompts

def read_rows(path: Path) -> list[dict]:
    """{prompt, answer} rows of a .jsonl (prompt/answer, question/answer, instruction/output,
    messages, text) or a .txt (one prompt per line, or per blank-line block when it has them)."""
    path = Path(path).expanduser()
    text = path.read_text(encoding="utf-8", errors="ignore")
    if path.suffix != ".jsonl":
        parts = text.split("\n\n") if "\n\n" in text else text.splitlines()
        return [{"prompt": p.strip(), "answer": ""} for p in parts if p.strip()]
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if isinstance(r, str):
            out.append({"prompt": r, "answer": ""})
            continue
        if "messages" in r:
            msgs = r["messages"]
            p = next((m["content"] for m in msgs if m.get("role") == "user"), "")
            a = next((m["content"] for m in msgs if m.get("role") == "assistant"), "")
        else:
            p = r.get("prompt") or r.get("question") or r.get("instruction") or r.get("input") or r.get("text") or ""
            a = r.get("answer") or r.get("output") or r.get("response") or r.get("completion") or ""
        if p:
            out.append({"prompt": str(p), "answer": str(a)})
    return out


def named_rows(name: str, n: int, seed: int) -> tuple[list[dict], str]:
    """A file path, or a named set through the pipeline's loader (chat, code, math, contest, mix)."""
    p = Path(name).expanduser()
    if p.is_file():
        rows = read_rows(p)
        np.random.default_rng(seed).shuffle(rows)
        return rows[:n], f"{min(n, len(rows))} prompts from {p}"
    from reaper_pipeline.calib import load_prompts
    texts, note = load_prompts(name, n, seed=seed)
    return [{"prompt": t, "answer": ""} for t in texts], note


def chat_ids(tok, prompt: str) -> list[int]:
    if getattr(tok, "chat_template", None):
        text = tok.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False,
                                       add_generation_prompt=True)
        return tok(text, add_special_tokens=False)["input_ids"]
    return tok(prompt)["input_ids"]


def generate(hf, tok, prompts: list[str], max_new_tokens: int, sample: bool = False, seed: int = 0,
             batch_size: int = 8) -> list[str]:
    """The model's replies (greedy, or sampled at temperature 1) to chat prompts, batched."""
    import torch
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    dev = input_device(hf)
    out = []
    torch.manual_seed(seed)
    for i in range(0, len(prompts), batch_size):
        enc = [chat_ids(tok, p) for p in prompts[i:i + batch_size]]
        L = max(len(e) for e in enc)
        ids = torch.tensor([[pad] * (L - len(e)) + e for e in enc], device=dev)
        att = torch.tensor([[0] * (L - len(e)) + [1] * len(e) for e in enc], device=dev)
        kw = {"do_sample": True, "temperature": 1.0, "top_p": 0.95} if sample else {"do_sample": False}
        with torch.no_grad():
            gen = hf.generate(input_ids=ids, attention_mask=att, max_new_tokens=max_new_tokens,
                              pad_token_id=pad, **kw)
        out += [tok.decode(g[L:], skip_special_tokens=True).strip() for g in gen]
    return out


WRITE = ("Write one realistic request a user could send to an assistant about this task: {task}\n"
         "Make it specific and different from the usual examples. Reply with the request only.")


def write_prompts(hf, tok, describe: str, n: int, seed: int, max_new_tokens: int = 96) -> list[dict]:
    """Prompts the base model writes from a one-line task description (sampled, de-duplicated)."""
    seen, rows, rounds = set(), [], 0
    while len(rows) < n and rounds < 8:
        need = n - len(rows)
        for t in generate(hf, tok, [WRITE.format(task=describe)] * need, max_new_tokens, sample=True,
                          seed=seed + rounds):
            t = t.strip().strip('"').strip()
            if t and t not in seen:
                seen.add(t)
                rows.append({"prompt": t, "answer": ""})
        rounds += 1
    return rows[:n]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def load_sets(job) -> dict[str, list[dict]]:
    w = work(job)
    missing = [s for s in SETS if not (w / f"{s}.jsonl").exists()]
    if missing:
        raise RuntimeError("run task-prompts first (no " + ", ".join(f"{s}.jsonl" for s in missing) + f" in {w})")
    return {s: read_rows(w / f"{s}.jsonl") for s in SETS}


def encode(tok, row: dict, max_prompt: int = 512, max_answer: int = 256) -> tuple[list[int], int]:
    """(token ids of prompt + answer, where the answer starts)."""
    p = chat_ids(tok, row["prompt"])[-max_prompt:]
    a = tok(row["answer"], add_special_tokens=False)["input_ids"][:max_answer] if row.get("answer") else []
    return p + a, len(p)


# --------------------------------------------------------------------------- model structure

def parts(hf) -> list[tuple]:
    """[(layer index, decoder layer, mlp, attention)] of a dense SwiGLU decoder."""
    out = []
    for i, layer in enumerate(hf.model.layers):
        mlp, attn = getattr(layer, "mlp", None), getattr(layer, "self_attn", None)
        if mlp is None or not all(hasattr(mlp, a) for a in ("gate_proj", "up_proj", "down_proj")):
            raise ValueError(f"layer {i} has no gate/up/down SwiGLU FFN: task maps need a dense model "
                             "(an MoE's experts are already its blocks; use reap-score for those)")
        if attn is None or not hasattr(attn, "o_proj"):
            raise ValueError(f"layer {i} has no self_attn.o_proj")
        out.append((i, layer, mlp, attn))
    return out


def heads(hf) -> tuple[int, int, int]:
    """(attention heads H, key/value heads KV, head dim)."""
    c = hf.config
    H = int(c.num_attention_heads)
    KV = int(getattr(c, "num_key_value_heads", None) or H)
    hd = int(getattr(c, "head_dim", None) or c.hidden_size // H)
    return H, KV, hd


# --------------------------------------------------------------------------- 2. trace

class Tracer:
    """Hooks that record, for one forward pass, per layer: each FFN neuron's mean contribution,
    each head's mean output norm, the residual update, and the probe layer's mean prompt state.
    `mask` (optional, set per prompt) is applied to the FFN instead: see DynamicFFN."""

    def __init__(self, hf, probe: int):
        import torch
        self.hf, self.probe = hf, probe
        self.P = parts(hf)
        self.H, self.KV, self.hd = heads(hf)
        self.dnorm = [m.down_proj.weight.detach().float().norm(dim=0) for _, _, m, _ in self.P]       # (m,)
        self.gram = []                                                                             # (H, hd, hd)
        for _, _, _, a in self.P:
            W = a.o_proj.weight.detach().float().view(-1, self.H, self.hd)                         # (d, H, hd)
            self.gram.append(torch.einsum("dhk,dhl->hkl", W, W))
        self.start = 0
        self.rec: dict = {}
        self.handles = []

    def _ffn(self, idx):
        def hook(mod, args):
            h = args[0].detach().float()[0]                                                       # (T, m)
            self.rec["ffn"][idx] = (h.abs() * self.dnorm[idx]).mean(0)
        return hook

    def _head(self, idx):
        def hook(mod, args):
            x = args[0].detach().float()[0].view(-1, self.H, self.hd)                             # (T, H, hd)
            sq = __import__("torch").einsum("thk,hkl,thl->th", x, self.gram[idx], x).clamp_min(0)
            self.rec["heads"][idx] = sq.sqrt().mean(0)
        return hook

    def _pre(self, idx):
        def hook(mod, args, kwargs):
            hs = args[0] if args else kwargs["hidden_states"]
            self.rec["in"][idx] = hs.detach().float()[0]
        return hook

    def _post(self, idx):
        def hook(mod, args, kwargs, out):
            o = (out[0] if isinstance(out, tuple) else out).detach().float()[0]
            i = self.rec["in"].pop(idx)
            self.rec["layers"][idx] = ((o - i).norm(dim=-1) / i.norm(dim=-1).clamp_min(1e-6)).mean()
            if idx == self.probe:
                self.rec["feat"] = o[:max(self.start, 1)].mean(0)
        return hook

    def __enter__(self):
        for idx, layer, mlp, attn in self.P:
            self.handles += [mlp.down_proj.register_forward_pre_hook(self._ffn(idx)),
                             attn.o_proj.register_forward_pre_hook(self._head(idx)),
                             layer.register_forward_pre_hook(self._pre(idx), with_kwargs=True),
                             layer.register_forward_hook(self._post(idx), with_kwargs=True)]
        return self

    def __exit__(self, *exc):
        for h in self.handles:
            h.remove()
        self.handles = []

    def run(self, ids: list[int], start: int) -> dict:
        """One prompt: {"ffn": (L, m), "heads": (L, H), "layers": (L,), "feat": (d,)} numpy, and the logits."""
        import torch
        self.start = start
        self.rec = {"ffn": {}, "heads": {}, "layers": {}, "in": {}, "feat": None}
        with torch.no_grad():
            logits = self.hf(input_ids=torch.tensor([ids], device=input_device(self.hf))).logits[0]
        L = len(self.P)
        r = self.rec
        return {"ffn": torch.stack([r["ffn"][i] for i in range(L)]).cpu().numpy(),
                "heads": torch.stack([r["heads"][i] for i in range(L)]).cpu().numpy(),
                "layers": torch.stack([r["layers"][i] for i in range(L)]).cpu().numpy(),
                "feat": r["feat"].cpu().numpy(), "logits": logits}


def default_probe(n_layers: int, probe: int) -> int:
    return int(probe) if probe >= 0 else max(0, n_layers // 4 - 1)


def trace(hf, tok, rows: list[dict], probe: int, max_prompt: int = 512, max_answer: int = 256,
          on_item=None) -> dict:
    """The trace of one prompt set: ffn (P, L, m) float16, heads (P, L, H), layers (P, L),
    feats (P, d), tokens (P,)."""
    P = len(rows)
    if not P:
        raise ValueError("no prompts to trace")
    out: dict = {}
    with Tracer(hf, probe) as t:
        for k, row in enumerate(rows):
            ids, start = encode(tok, row, max_prompt, max_answer)
            r = t.run(ids, start)
            if not out:
                out = {"ffn": np.zeros((P,) + r["ffn"].shape, np.float16),
                       "heads": np.zeros((P,) + r["heads"].shape, np.float32),
                       "layers": np.zeros((P,) + r["layers"].shape, np.float32),
                       "feats": np.zeros((P,) + r["feat"].shape, np.float32),
                       "tokens": np.zeros(P, np.int64)}
            out["ffn"][k] = np.minimum(r["ffn"], 6e4)
            out["heads"][k], out["layers"][k], out["feats"][k] = r["heads"], r["layers"], r["feat"]
            out["tokens"][k] = len(ids)
            if on_item:
                on_item(k + 1, P)
    return out


def load_trace(job, name: str) -> dict:
    p = work(job) / f"trace_{name}.npz"
    if not p.exists():
        raise RuntimeError(f"run task-trace first (no {p})")
    return dict(np.load(p, allow_pickle=False))


def summary(tr: dict, gen: dict, top: float = 0.2) -> dict:
    """How concentrated the task's use of the model is, and how much it differs from general text."""
    task = tr["ffn"].astype(np.float32).mean(0)                                                    # (L, m)
    other = gen["ffn"].astype(np.float32).mean(0)
    m = task.shape[1]
    k = max(1, int(round(top * m)))
    srt = -np.sort(-task, axis=1)
    conc = float((srt[:, :k].sum(1) / np.maximum(srt.sum(1), 1e-30)).mean())
    ta, tb = np.argsort(-task, 1)[:, :k], np.argsort(-other, 1)[:, :k]
    overlap = float(np.mean([len(set(a) & set(b)) / k for a, b in zip(ta, tb)]))
    lay = tr["layers"].mean(0)
    return {"top20_share": conc, "top20_overlap_general": overlap,
            "busiest_layer": int(lay.argmax()), "quietest_layer": int(lay.argmin()),
            "head_top20_share": float(_share(tr["heads"].mean(0), top))}


def _share(x: np.ndarray, top: float) -> float:
    k = max(1, int(round(top * x.shape[-1])))
    s = -np.sort(-x, axis=-1)
    return float((s[..., :k].sum(-1) / np.maximum(s.sum(-1), 1e-30)).mean())


# --------------------------------------------------------------------------- 3. predictor

def neuron_scores(tr: dict, contrast: dict | None = None, weight: float = 0.0) -> np.ndarray:
    """(L, m) mean contribution over the set; with `weight` > 0, minus that share of the
    contrast set's (each normalised per layer), so neurons busy on everything rank lower."""
    s = tr["ffn"].astype(np.float32).mean(0)
    if contrast is not None and weight:
        c = contrast["ffn"].astype(np.float32).mean(0)
        s = s / np.maximum(s.mean(1, keepdims=True), 1e-30) - weight * c / np.maximum(c.mean(1, keepdims=True), 1e-30)
    return s


def block_order(scores: np.ndarray) -> np.ndarray:
    """(L, m) neuron order per layer, busiest first."""
    return np.argsort(-scores, axis=1, kind="stable")


def n_blocks(m: int, block_size: int) -> int:
    return -(-m // block_size)


def block_scores(ffn: np.ndarray, order: np.ndarray, block_size: int) -> np.ndarray:
    """(P, L, B) contribution of each block (neurons order[l, b*bs:(b+1)*bs]) per prompt."""
    P, L, m = ffn.shape
    B = n_blocks(m, block_size)
    pad = B * block_size - m
    out = np.zeros((P, L, B), np.float32)
    for li in range(L):
        x = ffn[:, li, order[li]].astype(np.float32)
        if pad:
            x = np.pad(x, ((0, 0), (0, pad)))
        out[:, li] = x.reshape(P, B, block_size).sum(-1)
    return out


def fit(X: np.ndarray, Y: np.ndarray, ridge: float = 1.0) -> dict:
    """Ridge regression from prompt features X (P, d) to log block contributions Y (P, L, B),
    in low-rank form (rank <= P): pred = ((X - mx) / sx) @ A @ C + my."""
    P = X.shape[0]
    shape = Y.shape[1:]
    T = np.log(np.maximum(Y.reshape(P, -1), 1e-12))
    mx, sx = X.mean(0), X.std(0) + 1e-6
    my = T.mean(0)
    Xs, Tc = (X - mx) / sx, T - my
    U, s, Vt = np.linalg.svd(Xs, full_matrices=False)
    lam = float(ridge) * max(float((s ** 2).mean()), 1e-30)
    A = Vt.T * (s / (s ** 2 + lam))                                                               # (d, r)
    C = U.T @ Tc                                                                                  # (r, K)
    return {"mx": mx.astype(np.float32), "sx": sx.astype(np.float32), "A": A.astype(np.float32),
            "C": C.astype(np.float32), "my": my.astype(np.float32), "shape": np.array(shape)}


def predict(pr: dict, X: np.ndarray) -> np.ndarray:
    X = np.atleast_2d(X)
    T = ((X - pr["mx"]) / pr["sx"]) @ pr["A"] @ pr["C"] + pr["my"]
    return T.reshape((X.shape[0],) + tuple(int(v) for v in pr["shape"]))


def topk_mask(scores: np.ndarray, k: int) -> np.ndarray:
    """Boolean mask of the k largest along the last axis."""
    idx = np.argsort(-scores, axis=-1, kind="stable")[..., :k]
    out = np.zeros(scores.shape, bool)
    np.put_along_axis(out, idx, True, axis=-1)
    return out


def recall(actual: np.ndarray, chosen: np.ndarray, k: int) -> float:
    """Share of the true top-k blocks' contribution that the chosen k blocks hold, averaged over
    prompts and layers (1 = as good as knowing the answer in advance)."""
    best = np.sort(actual, axis=-1)[..., ::-1][..., :k].sum(-1)
    got = (actual * chosen).sum(-1)
    return float((got / np.maximum(best, 1e-30)).mean())


def evaluate_predictor(pr: dict, train_blocks: np.ndarray, tr: dict, actual: np.ndarray, k: int,
                       seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    static = np.broadcast_to(np.log(np.maximum(train_blocks.mean(0), 1e-12)), actual.shape)
    pred = predict(pr, tr["feats"])
    T = np.log(np.maximum(actual.reshape(actual.shape[0], -1), 1e-12))
    Th = pred.reshape(T.shape)
    r2 = 1 - ((T - Th) ** 2).sum() / max(((T - T.mean(0)) ** 2).sum(), 1e-30)
    return {"recall_predictor": recall(actual, topk_mask(pred, k), k),
            "recall_static": recall(actual, topk_mask(static, k), k),
            "recall_random": recall(actual, topk_mask(rng.random(actual.shape), k), k),
            "r2": float(r2)}


# --------------------------------------------------------------------------- 4. plan

def allocate(n_layers: int, m: int, budget: float, how: str = "even", layer_weight: np.ndarray | None = None,
             multiple: int = 1) -> np.ndarray:
    """Hot neurons per layer. "even": the same share everywhere; "importance": proportional to
    how much each layer changes the residual stream on the task (within 0.5x to 2x of even)."""
    base = budget * m
    if how == "importance" and layer_weight is not None and layer_weight.sum() > 0:
        w = layer_weight / layer_weight.mean()
        want = np.clip(base * w, 0.5 * base, min(m, 2 * base))
        want *= base * n_layers / max(want.sum(), 1e-30)
    elif how in ("even", "importance"):
        want = np.full(n_layers, base)
    else:
        raise ValueError(f"allocate must be even or importance, not {how!r}")
    n = np.clip(np.round(want / multiple) * multiple, 0, m).astype(int)
    return n


def make_plan(scores: np.ndarray, head_scores: np.ndarray, budget: float, head_budget: float,
              how: str = "even", layer_weight: np.ndarray | None = None, block_size: int = 1) -> dict:
    """Static plan: hot (L, m) and hot_heads (L, H) boolean masks plus the neuron order."""
    L, m = scores.shape
    n = allocate(L, m, budget, how, layer_weight, block_size if how == "even" else 1)
    order = block_order(scores)
    hot = np.zeros((L, m), bool)
    for li in range(L):
        hot[li, order[li, :n[li]]] = True
    H = head_scores.shape[1]
    hh = max(0, min(H, int(round(head_budget * H))))
    hot_heads = topk_mask(head_scores, hh) if hh else np.zeros(head_scores.shape, bool)
    return {"hot": hot, "hot_heads": hot_heads, "order": order, "n_hot": n}


def random_plan(plan: dict, seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    hot = np.zeros_like(plan["hot"])
    for li, k in enumerate(plan["n_hot"]):
        hot[li, rng.permutation(hot.shape[1])[:k]] = True
    hh = np.zeros_like(plan["hot_heads"])
    for li, k in enumerate(plan["hot_heads"].sum(1)):
        hh[li, rng.permutation(hh.shape[1])[:k]] = True
    return {**plan, "hot": hot, "hot_heads": hh}


def bpw(fmt: str) -> float:
    if fmt == "off":
        return 0.0
    from blackhole.anatomy.formats import bpw as _bpw
    return float(_bpw(fmt))


def quant(W, fmt: str):
    """Round-to-nearest copy of a torch weight on `fmt`'s grid (same dtype and device); "off" = zeros."""
    import torch
    if fmt in ("bf16", "f16", "f32", "fp16", "fp32"):
        return W.clone()
    if fmt == "off":
        return torch.zeros_like(W)
    m = _INT.match(fmt)
    if m:                                         # torch twin of blackhole.anatomy.formats int grids (GPU-fast)
        bits, g = int(m[1]), int(m[2] or 128)
        x = W.float()
        pad = -x.shape[1] % g
        xp = torch.nn.functional.pad(x, (0, pad)).view(x.shape[0], -1, g)
        q = 2 ** (bits - 1) - 1
        s = (xp.abs().amax(-1, keepdim=True) / q).clamp_min(1e-30)
        y = (torch.round(xp / s).clamp(-q - 1, q) * s).view(x.shape[0], -1)[:, :x.shape[1]]
        return y.to(W.dtype)
    from blackhole.anatomy.formats import fake_quant
    return torch.from_numpy(fake_quant(W.float().cpu().numpy(), fmt)).to(W.dtype).to(W.device)


def _mix(W, hot_rows, hot_fmt: str, cold_fmt: str, dim: int = 0):
    """W with hot rows (dim 0) or columns (dim 1) at hot_fmt and the rest at cold_fmt."""
    import torch
    hot = torch.as_tensor(hot_rows, device=W.device)
    H, C = quant(W, hot_fmt), quant(W, cold_fmt)
    sel = hot.view(-1, 1) if dim == 0 else hot.view(1, -1)
    return torch.where(sel, H, C)


def apply(hf, plan: dict, hot_fmt: str = "bf16", cold_fmt: str = "int3", permute: bool = True,
          ffn: bool = True, attn: bool = True) -> dict:
    """Bake a static plan into the model in place: FFN neurons and attention heads (their q_proj
    rows and o_proj columns) at hot_fmt or cold_fmt, k/v projections always at hot_fmt (they are
    small under grouped-query attention, and a cold k/v breaks every head sharing it), and with
    `permute` the FFN neurons reordered hot-first so each layer's hot part is one row range.
    With cold_fmt "off" and the same hot count in every layer, the FFN is cut to that width."""
    import torch
    H, KV, hd = heads(hf)
    shrink = ffn and permute and cold_fmt == "off" and len(set(int(v) for v in plan["n_hot"])) == 1
    with torch.no_grad():
        for li, _, mlp, att in parts(hf):
            if ffn:
                hot = plan["hot"][li]
                g, u, d = mlp.gate_proj.weight, mlp.up_proj.weight, mlp.down_proj.weight
                g.copy_(_mix(g, hot, hot_fmt, cold_fmt, 0))
                u.copy_(_mix(u, hot, hot_fmt, cold_fmt, 0))
                d.copy_(_mix(d, hot, hot_fmt, cold_fmt, 1))
                if permute:
                    sc = plan["order"][li]
                    rank = np.empty_like(sc)
                    rank[sc] = np.arange(len(sc))
                    perm = torch.as_tensor(np.lexsort((rank, ~hot)), device=g.device)   # hot first, busiest first
                    keep = int(hot.sum()) if shrink else len(perm)
                    perm = perm[:keep]
                    for lin, dim in ((mlp.gate_proj, 0), (mlp.up_proj, 0), (mlp.down_proj, 1)):
                        w = lin.weight.data.index_select(dim, perm.to(lin.weight.device)).contiguous()
                        lin.weight = torch.nn.Parameter(w, requires_grad=False)
                        if dim == 0:
                            lin.out_features = keep
                            if lin.bias is not None:
                                lin.bias = torch.nn.Parameter(lin.bias.data[perm].contiguous(), requires_grad=False)
                        else:
                            lin.in_features = keep
            if attn:
                hh = np.repeat(plan["hot_heads"][li], hd)                                # (H*hd,)
                for lin, mask, dim in ((att.q_proj, hh, 0), (att.o_proj, hh, 1)):
                    lin.weight.copy_(_mix(lin.weight, mask, hot_fmt, cold_fmt, dim))
                if hot_fmt not in ("bf16", "f16", "f32", "fp16", "fp32"):
                    for lin in (att.k_proj, att.v_proj):
                        lin.weight.copy_(quant(lin.weight, hot_fmt))
    if shrink:
        hf.config.intermediate_size = int(plan["n_hot"][0])
    return size(hf, plan, hot_fmt, cold_fmt, ffn, attn)


def size(hf, plan: dict, hot_fmt: str, cold_fmt: str, ffn: bool = True, attn: bool = True) -> dict:
    """Weight bytes of the plan (planned weights at their formats, everything else at 16 bit),
    the 16-bit model, everything at cold_fmt, and what must stay resident when cold parts are
    fetched only on demand."""
    H, KV, hd = heads(hf)
    d = hf.config.hidden_size
    total = sum(p.numel() for p in hf.parameters())
    m = plan["hot"].shape[1]
    L = plan["hot"].shape[0]
    bh, bc = bpw(hot_fmt), bpw(cold_fmt)
    ffn_hot = 3 * d * int(plan["hot"].sum()) if ffn else 0
    ffn_all = 3 * d * m * L if ffn else 0
    a_hot = a_all = 0
    if attn:                                      # q rows + o columns per head; k/v stay at hot_fmt
        for li in range(L):
            a_hot += 2 * d * hd * int(plan["hot_heads"][li].sum()) + 2 * d * hd * KV
            a_all += 2 * d * hd * H + 2 * d * hd * KV
    rest = (total_dense(hf, plan) if ffn and cold_fmt == "off" else total) - ffn_all - a_all
    planned_hot, planned_cold = ffn_hot + a_hot, ffn_all + a_all - ffn_hot - a_hot
    gb = 1 / 8 / 1e9
    return {"size_gb": (rest * 16 + planned_hot * bh + planned_cold * bc) * gb,
            "base_gb": (rest + ffn_all + a_all) * 16 * gb,
            "cold_everywhere_gb": (rest * 16 + (ffn_all + a_all) * bc) * gb,
            "resident_gb": (rest * 16 + planned_hot * bh) * gb,
            "hot_share_ffn": ffn_hot / max(ffn_all, 1), "hot_share_heads": a_hot / max(a_all, 1),
            "avg_bits_planned": (planned_hot * bh + planned_cold * bc) / max(planned_hot + planned_cold, 1)}


def total_dense(hf, plan: dict) -> int:
    """Parameter count with every FFN at its original width (a shrunk model counts its cut rows)."""
    d = hf.config.hidden_size
    now = sum(p.numel() for p in hf.parameters())
    cur = sum(m.gate_proj.weight.shape[0] for _, _, m, _ in parts(hf))
    return now + 3 * d * (plan["hot"].shape[1] * plan["hot"].shape[0] - cur)


def save_plan(path: Path, plan: dict) -> None:
    np.savez_compressed(path, hot=plan["hot"], hot_heads=plan["hot_heads"], order=plan["order"], n_hot=plan["n_hot"])


def load_plan(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(f"run task-preload first (no {path})")
    return dict(np.load(path, allow_pickle=False))


def preload_map(plan: dict, hot_fmt: str, cold_fmt: str, block_size: int) -> dict:
    """What a runtime reads: per layer, the hot FFN rows (a range after the hot-first permutation)
    and hot heads; cold rows follow in busiest-first order, so a partial fetch takes a prefix."""
    return {"format": "blackhole-preload/1", "hot_format": hot_fmt, "cold_format": cold_fmt,
            "block_size": block_size, "permuted": True,
            "layers": [{"layer": li, "ffn_hot_rows": [0, int(plan["n_hot"][li])],
                        "heads_hot": [int(h) for h in np.flatnonzero(plan["hot_heads"][li])]}
                       for li in range(plan["hot"].shape[0])]}


# --------------------------------------------------------------------------- 5. eval

class DynamicFFN:
    """Per-prompt FFN precision on an unpermuted model: neurons in `mask` (L, m) run at full
    weights, the rest at cold_fmt ("off" = skipped), by adding the difference on top of each
    projection. Costs two extra FFN-sized weight copies while installed (fine for an eval)."""

    def __init__(self, hf, cold_fmt: str):
        import torch
        self.P = parts(hf)
        self.cold = cold_fmt
        self.mask = None
        self.handles = []
        self.q = {}
        with torch.no_grad():
            for li, _, mlp, _ in self.P:
                if cold_fmt != "off":
                    self.q[li] = (quant(mlp.gate_proj.weight, cold_fmt), quant(mlp.up_proj.weight, cold_fmt),
                                  mlp.down_proj.weight - quant(mlp.down_proj.weight, cold_fmt))

    def _proj(self, li, which):
        def hook(mod, args, out):
            import torch
            m = self.mask[li].to(out.device)
            return torch.where(m, out, torch.nn.functional.linear(args[0], self.q[li][which]))
        return hook

    def _down(self, li):
        def hook(mod, args, out):
            import torch
            h = args[0]
            m = self.mask[li].to(h.device)
            if self.cold == "off":
                return torch.nn.functional.linear(h * m, mod.weight, mod.bias)
            return out - torch.nn.functional.linear(h * (~m), self.q[li][2])
        return hook

    def __enter__(self):
        for li, _, mlp, _ in self.P:
            if self.cold != "off":
                self.handles += [mlp.gate_proj.register_forward_hook(self._proj(li, 0)),
                                 mlp.up_proj.register_forward_hook(self._proj(li, 1))]
            self.handles.append(mlp.down_proj.register_forward_hook(self._down(li)))
        return self

    def __exit__(self, *exc):
        for h in self.handles:
            h.remove()
        self.handles = []


def blocks_to_neurons(sel: np.ndarray, order: np.ndarray, block_size: int):
    """(L, B) block mask -> (L, m) torch neuron mask."""
    import torch
    L, m = order.shape
    out = np.zeros((L, m), bool)
    for li in range(L):
        idx = np.flatnonzero(sel[li])
        rows = (idx[:, None] * block_size + np.arange(block_size)).ravel()
        out[li, order[li, rows[rows < m]]] = True
    return torch.as_tensor(out)


def token_stats(ref, out, ids: list[int], start: int) -> dict:
    """KL(base || variant), top-1 agreement and the variant's NLL over the answer tokens (all
    tokens after the first when there is no answer)."""
    import torch
    a = start - 1 if start < len(ids) else 0
    ref, out = ref[a:-1].float(), out[a:-1].float()
    tgt = torch.tensor(ids[a + 1:], device=out.device)
    lp, lq = torch.log_softmax(ref, -1), torch.log_softmax(out, -1)
    return {"kl": float((lp.exp() * (lp - lq)).sum(-1).sum()),
            "top1": float((ref.argmax(-1) == out.argmax(-1)).float().sum()),
            "nll": float(-lq.gather(-1, tgt[:, None]).sum()),
            "nll_base": float(-lp.gather(-1, tgt[:, None]).sum()), "n": int(tgt.numel())}


def add(acc: dict, r: dict) -> None:
    for k, v in r.items():
        acc[k] = acc.get(k, 0) + v


def finish(acc: dict) -> dict:
    n = max(acc.get("n", 0), 1)
    return {"kl": acc.get("kl", 0) / n, "top1": acc.get("top1", 0) / n, "nll": acc.get("nll", 0) / n,
            "nll_base": acc.get("nll_base", 0) / n, "tokens": acc.get("n", 0)}


def local_speed(hf, tok, prompt: str, new_tokens: int = 32) -> dict:
    """Prefill and decode tokens per second of one prompt (transformers, this process)."""
    import torch
    ids = torch.tensor([chat_ids(tok, prompt)], device=input_device(hf))
    pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
    cuda = ids.is_cuda
    if cuda:
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
    with torch.no_grad():
        hf(input_ids=ids)                                                                       # warm-up
        t0 = time.perf_counter()
        hf(input_ids=ids)
        if cuda:
            torch.cuda.synchronize()
        t1 = time.perf_counter()
        g = hf.generate(input_ids=ids, max_new_tokens=new_tokens, min_new_tokens=new_tokens, do_sample=False,
                        pad_token_id=pad)
        if cuda:
            torch.cuda.synchronize()
        t2 = time.perf_counter()
    made = g.shape[1] - ids.shape[1]
    weights = sum(p.numel() * p.element_size() for p in hf.parameters()) / 1e9
    return {"prefill_tok_s": ids.shape[1] / max(t1 - t0, 1e-9),
            "decode_tok_s": made / max(t2 - t1 - (t1 - t0), 1e-9),
            "peak_mem_gb": (torch.cuda.max_memory_allocated() / 1e9) if cuda else weights,
            "weights_gb_loaded": weights}
