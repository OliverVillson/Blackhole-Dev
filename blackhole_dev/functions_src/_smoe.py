"""Shared code of the dense-to-SMoE functions (smoe-profile, smoe-partition, smoe-router,
smoe-build, smoe-verify): split every dense SwiGLU FFN into N routed experts (plus an always-on
shared expert on Qwen2-MoE targets) by co-activation, fit a linear router in closed form, and
write a standard Hugging Face MoE checkpoint. A fork may import it or copy it.

Every step works on a transformers model and plain arrays, so it runs on the CPU of any machine
(the tests use a tiny Qwen3 and Qwen2) and on the GPU VM as a job function. The job functions
keep their files in <job>/reaper/work/smoe/ and write the MoE as the job's model
(<job>/reaper/out/<name>), so the stages after them (kd, distil, package, ...) pick it up.

The written router is "flattened": its logits are scaled so that every expert's softmax weight is
1/N within gate_eps, and the x N is folded into each expert's down_proj. With norm_topk_prob off,
each selected expert then counts with weight 1 +- gate_eps, which is the hard-gate split of the
dense FFN; at k = N the MoE reproduces the dense model (smoe-verify checks it). Before training
the router (a route-anneal heal), scale gate.weight back up: flat logits get almost no gradient.
"""

from __future__ import annotations

import inspect
import json
import time
from dataclasses import fields, is_dataclass
from pathlib import Path

import numpy as np

FAMILIES = {
    "qwen3": {"moe_type": "qwen3_moe", "shared": False},
    "qwen2": {"moe_type": "qwen2_moe", "shared": True},
}
ALIGN = 8   # expert width multiple of 8 (grouped-GEMM alignment)


def log(msg: str) -> None:
    print(f"[smoe {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- model and data

def family(cfg) -> str:
    mt = getattr(cfg, "model_type", "") if not isinstance(cfg, dict) else cfg.get("model_type", "")
    if mt not in FAMILIES:
        raise ValueError(f"model_type {mt!r} is not supported; dense families: {sorted(FAMILIES)} "
                         f"(Qwen3 dense -> Qwen3-MoE, Qwen2/2.5 dense -> Qwen2-MoE)")
    return mt


def ffn_layers(hf) -> list:
    """[(layer index, mlp module)] of a dense SwiGLU decoder."""
    out = []
    for idx, layer in enumerate(hf.model.layers):
        mlp = getattr(layer, "mlp", None)
        if mlp is None or not all(hasattr(mlp, a) for a in ("gate_proj", "up_proj", "down_proj")):
            raise ValueError(f"layer {idx} has no gate/up/down SwiGLU FFN; the base model is not dense")
        out.append((idx, mlp))
    return out


def dims(hf) -> tuple[int, int]:
    """(hidden size d, FFN width m)."""
    mlp = ffn_layers(hf)[0][1]
    return mlp.gate_proj.in_features, mlp.gate_proj.out_features


def input_device(hf):
    return hf.get_input_embeddings().weight.device


def _dtype_kw(dtype) -> dict:
    import transformers
    return {("dtype" if int(transformers.__version__.split(".")[0]) >= 5 else "torch_dtype"): dtype}


def load(path, dtype=None, device: str | None = None):
    """A causal LM from a folder: bf16 spread over the GPUs when there are any, else fp32 on the CPU."""
    import torch
    from transformers import AutoModelForCausalLM
    cuda = torch.cuda.is_available() and device != "cpu"
    kw = _dtype_kw(dtype or (torch.bfloat16 if cuda else torch.float32))
    if cuda:
        kw["device_map"] = device or "auto"
    hf = AutoModelForCausalLM.from_pretrained(str(path), **kw).eval()
    for q in hf.parameters():
        q.requires_grad_(False)
    return hf


def tokenizer(path):
    from transformers import AutoTokenizer
    return AutoTokenizer.from_pretrained(str(path))


def read_texts(path: Path) -> list[str]:
    """Documents of a .jsonl (text / content / code / prompt + answer) or .txt (one per blank-line block)."""
    if path.suffix == ".jsonl":
        out = []
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if isinstance(r, str):
                out.append(r)
            elif isinstance(r, dict):
                t = r.get("text") or r.get("content") or r.get("code") or \
                    "\n".join(x for x in (r.get("prompt"), r.get("answer")) if x)
                if t:
                    out.append(t)
        return out
    return [x for x in path.read_text(encoding="utf-8", errors="ignore").split("\n\n") if x.strip()]


def calib_texts(calib: str, n_tokens: int, seed: int = 0, job_calib: Path | None = None,
                default: str = "mix") -> tuple[list[str], str]:
    """(documents, note): a .txt/.jsonl path; else a named set (chat, code, math, contest, mix)
    through the pipeline's loader; with calib empty, the job's calibration set (prompts and the
    teacher's answers) when there is one, else `default`."""
    if calib:
        p = Path(calib).expanduser()
        if p.is_file():
            return read_texts(p), f"documents from {p}"
    elif job_calib is not None and job_calib.is_file():
        texts = read_texts(job_calib)
        if texts:
            return texts, f"the job's calibration set ({job_calib.name})"
    from reaper_pipeline.calib import load_prompts
    texts, note = load_prompts(calib or default, max(64, n_tokens // 64), seed=seed)
    return texts, note


def batches(texts: list, tok, n_tokens: int, seq_len: int = 2048, batch_size: int = 8, seed: int = 0):
    """Yields (batch, seq_len) LongTensors of packed documents until n_tokens were produced,
    cycling through the documents when they run out. Token lists are taken as they are."""
    import torch
    if not texts:
        raise ValueError("no calibration documents")
    eos = tok.eos_token_id if tok.eos_token_id is not None else 0
    rng = np.random.default_rng(seed)
    per = batch_size * seq_len
    stream: list[int] = []
    produced, rounds = 0, 0
    while produced < n_tokens:
        added = 0
        for i in rng.permutation(len(texts)):
            item = texts[i]
            ids = list(item) if isinstance(item, (list, tuple)) else \
                tok(item, add_special_tokens=False, truncation=True, max_length=8192)["input_ids"]
            stream.extend(ids + [eos])
            added += len(ids) + 1
            while len(stream) >= per and produced < n_tokens:
                rows = min(batch_size, -(-(n_tokens - produced) // seq_len))
                chunk = torch.tensor(stream[:rows * seq_len], dtype=torch.long).view(rows, seq_len)
                stream = stream[rows * seq_len:]
                produced += chunk.numel()
                yield chunk
            if produced >= n_tokens:
                return
        rounds += 1
        if rounds > 1000 or added == 0:
            raise ValueError("the calibration documents are empty")


def work(job) -> Path:
    """<job>/reaper/work/smoe: the profile, partition, router and reports."""
    p = job.path("work", "smoe")
    p.mkdir(parents=True, exist_ok=True)
    return p


def model_path(job) -> Path:
    """The dense base model on disk (the weights stage downloads it; this does when it has not run)."""
    p = job.model_dir
    if not (p / "config.json").exists():
        from huggingface_hub import snapshot_download
        job.emit(pct=None, msg=f"downloading {job.rj.config.model}")
        snapshot_download(job.rj.config.model, local_dir=str(p))
    return p


def _save_npz(path: Path, **arrays) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **arrays)
    return path


# --------------------------------------------------------------------------- 1. profile

def omega_for(m: int, q: int, seed: int) -> np.ndarray:
    """The Gaussian test matrix of the sketch, the same in every process (CPU generator)."""
    import torch
    gen = torch.Generator().manual_seed(int(seed))
    return torch.randn(m, q, generator=gen, dtype=torch.float32).numpy()


def profile(hf, data, experts: int = 64, oversample: int = 4, seed: int = 0, chunk: int = 4096,
            on_batch=None) -> dict:
    """One pass: per FFN layer a sketch Y = M Omega of the magnitude co-activation matrix
    M[j, l] = E[e_j e_l], e_j = |h_j| * ||down_proj[:, j]||, plus E[e_j] and E[e_j^2]."""
    import torch
    layers = ffn_layers(hf)
    d, m = dims(hf)
    q = min(m, int(oversample) * int(experts))
    omega_cpu = torch.from_numpy(omega_for(m, q, seed))
    state = {}
    for idx, mlp in layers:
        dev = mlp.down_proj.weight.device
        state[idx] = {"Y": torch.zeros(m, q, device=dev), "e2": torch.zeros(m, device=dev, dtype=torch.float64),
                      "e1": torch.zeros(m, device=dev, dtype=torch.float64), "n": 0,
                      "wd": mlp.down_proj.weight.detach().float().norm(dim=0), "omega": omega_cpu.to(dev)}

    def make_hook(idx):
        def hook(module, inputs, output):
            s = state[idx]
            h = inputs[0].detach().reshape(-1, m)
            for a in range(0, h.shape[0], chunk):
                e = h[a:a + chunk].float().abs() * s["wd"]
                s["Y"] += e.t() @ (e @ s["omega"])
                s["e2"] += (e * e).sum(0).double()
                s["e1"] += e.sum(0).double()
                s["n"] += e.shape[0]
        return hook

    handles = [mlp.down_proj.register_forward_hook(make_hook(idx)) for idx, mlp in layers]
    seen = 0
    dev0 = input_device(hf)
    try:
        with torch.no_grad():
            for ids in data:
                hf.model(input_ids=ids.to(dev0))            # the decoder only: logits are not needed
                seen += ids.numel()
                if on_batch:
                    on_batch(seen)
    finally:
        for hd in handles:
            hd.remove()
    if not seen:
        raise ValueError("no calibration tokens")
    arrays = {"d": d, "m": m, "q": q, "seed": int(seed), "n_tokens": seen, "model_type": family(hf.config),
              "layer_ids": np.array([idx for idx, _ in layers])}
    for idx, _ in layers:
        n = max(state[idx]["n"], 1)
        arrays[f"Y_{idx}"] = (state[idx]["Y"] / n).cpu().numpy().astype(np.float32)
        arrays[f"diag_{idx}"] = (state[idx]["e2"] / n).cpu().numpy()
        arrays[f"mean_{idx}"] = (state[idx]["e1"] / n).cpu().numpy()
    return arrays


# --------------------------------------------------------------------------- 2. partition

def nystrom_embedding(Y: np.ndarray, omega: np.ndarray) -> np.ndarray:
    """Z with Z Z^T = Y W^+ Y^T ~ M from the sketch Y = M Omega (Nystrom), W = Omega^T Y."""
    W = omega.T @ Y
    W = 0.5 * (W + W.T)
    w, U = np.linalg.eigh(W)
    keep = w > max(float(w.max()), 1e-30) * 1e-8
    return Y @ U[:, keep] / np.sqrt(w[keep])[None, :]


def balanced_kmeans(X: np.ndarray, N: int, s: int, rng, iters: int = 12) -> np.ndarray:
    """k-means on the rows of X with exactly s rows per cluster (greedy capacity assignment)."""
    n = X.shape[0]
    if n != N * s:
        raise ValueError(f"{n} rows do not split into {N} clusters of {s}")
    centers = X[rng.choice(n, N, replace=False)].copy()
    labels = np.zeros(n, dtype=np.int64)
    x2 = (X * X).sum(1)
    for _ in range(iters):
        D = x2[:, None] - 2.0 * X @ centers.T + (centers * centers).sum(1)[None, :]
        rows, cols = np.unravel_index(np.argsort(D, axis=None, kind="stable"), D.shape)
        cap = np.full(N, s)
        assigned = np.zeros(n, dtype=bool)
        left = n
        for r, c in zip(rows.tolist(), cols.tolist()):
            if not assigned[r] and cap[c] > 0:
                labels[r] = c
                assigned[r] = True
                cap[c] -= 1
                left -= 1
                if left == 0:
                    break
        new = np.stack([X[labels == c].mean(0) for c in range(N)])
        if np.allclose(new, centers):
            break
        centers = new
    return labels


def within_mass(Z: np.ndarray, labels: np.ndarray, N: int) -> float:
    """sum over experts g of ||sum_{j in g} z_j||^2: the co-activation mass kept inside experts."""
    return float(sum(np.sum(Z[labels == g].sum(0) ** 2) for g in range(N)))


def refine_swaps(Z: np.ndarray, labels: np.ndarray, passes: int = 10, seed: int = 1, tries: int = 3) -> np.ndarray:
    """Greedy pair swaps (sizes stay equal) that raise within_mass. For each neuron a, the
    `tries` experts it is most drawn to (z_a . S_g against its own expert without itself) are
    searched for the partner b with the best gain."""
    labels = labels.copy()
    N = int(labels.max()) + 1
    S = np.stack([Z[labels == g].sum(0) for g in range(N)])      # (N, r) expert sums
    W = Z @ S.T                                                   # (m, N): z_j . S_g
    zz = (Z * Z).sum(1)
    rng = np.random.default_rng(seed)
    tol = 1e-12 * max(1.0, float(zz.sum()))
    for _ in range(int(passes)):
        moved = 0
        for a in rng.permutation(len(labels)):
            ga = labels[a]
            pull = W[a] - (W[a, ga] - zz[a])                     # W[a, ga] counts z_a itself
            pull[ga] = -np.inf
            best, b, gb = tol, -1, -1
            for g in np.argsort(-pull)[:min(int(tries), N - 1)]:
                cand = np.where(labels == g)[0]
                # dF/2 = W[a,gb] - W[a,ga] + W[b,ga] - W[b,gb] + |z_a|^2 + |z_b|^2 - 2 z_a.z_b
                gains = W[a, g] - W[a, ga] + (W[cand, ga] - W[cand, g]) + zz[a] + zz[cand] - 2.0 * (Z[cand] @ Z[a])
                bi = int(np.argmax(gains))
                if gains[bi] > best:
                    best, b, gb = float(gains[bi]), int(cand[bi]), int(g)
            if b >= 0:
                labels[a], labels[b] = gb, ga
                delta = Z[b] - Z[a]
                S[ga] += delta
                S[gb] -= delta
                W[:, ga] = Z @ S[ga]
                W[:, gb] = Z @ S[gb]
                moved += 1
        if moved == 0:
            break
    return labels


def widths(m: int, N: int, shared_frac: float, shared_ok: bool, fam: str = "") -> tuple[int, int]:
    """(routed expert width s, shared width s0) with N * s + s0 = m and s a multiple of ALIGN."""
    s0_target = int(round(float(shared_frac) * m)) if shared_ok else 0
    s = ((m - s0_target) // N) // ALIGN * ALIGN
    if s < ALIGN:
        raise ValueError(f"experts={N} is too many for an FFN of width {m}")
    s0 = m - N * s
    if s0 > 0 and not shared_ok:
        good = [n for n in range(4, 257) if m % n == 0 and (m // n) % ALIGN == 0]
        raise ValueError(f"{fam or 'these'} targets have no shared expert, so the FFN width {m} must split into "
                         f"experts of a width divisible by {ALIGN}; use experts in {good}")
    return s, s0


def partition(P, experts: int = 64, shared_frac: float = 0.03, refine_passes: int = 10, seed: int = 0,
              on_layer=None) -> tuple[dict, dict]:
    """Shared set = the most ubiquitous neurons (Qwen2-MoE targets), balanced spectral partition
    of the rest into N experts, swap refinement, and a Ky Fan bound per layer. Returns
    (arrays, per-layer metrics)."""
    m, q, N = int(P["m"]), int(P["q"]), int(experts)
    fam = str(P["model_type"])
    shared_ok = FAMILIES[fam]["shared"]
    layer_ids = [int(i) for i in P["layer_ids"]]
    omega = omega_for(m, q, int(P["seed"])).astype(np.float64)
    rng = np.random.default_rng(seed)
    s, s0 = widths(m, N, shared_frac, shared_ok, fam)
    arrays = {"m": m, "N": N, "s": s, "s0": s0, "model_type": fam, "layer_ids": np.array(layer_ids)}
    per_layer = {}
    for idx in layer_ids:
        Z = nystrom_embedding(P[f"Y_{idx}"].astype(np.float64), omega)          # (m, r)
        diag, mean = P[f"diag_{idx}"], P[f"mean_{idx}"]
        ubiq = (mean ** 2) / np.maximum(diag, 1e-30)                           # (E e)^2 / E e^2 in (0, 1]
        order = np.argsort(-ubiq, kind="stable")
        shared = np.sort(order[:s0]) if s0 > 0 else np.zeros(0, dtype=np.int64)
        routed = np.sort(order[s0:])
        Zr = Z[routed]
        zsum = Zr.sum(0)
        deg = np.maximum(Zr @ zsum, 1e-12)
        A = Zr / np.sqrt(deg)[:, None]                                         # rows of D^-1/2 Z
        U, _, _ = np.linalg.svd(A, full_matrices=False)
        emb = U[:, :N]
        if emb.shape[1] < N:                                                   # sketch rank below N
            emb = np.concatenate([emb, np.zeros((emb.shape[0], N - emb.shape[1]))], 1)
        emb = emb / np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-12)
        labels = balanced_kmeans(emb, N, s, rng)
        before = within_mass(Zr, labels, N)
        labels = refine_swaps(Zr, labels, passes=refine_passes, seed=seed + idx)
        within = within_mass(Zr, labels, N)
        total = float(np.sum(zsum ** 2))
        lam = np.linalg.eigvalsh(Zr.T @ Zr)[::-1]
        bound = s * float(lam[:N].sum())                                       # Ky Fan: within <= s * top-N eigs
        arrays[f"parts_{idx}"] = np.stack([routed[labels == g] for g in range(N)]).astype(np.int64)
        arrays[f"shared_{idx}"] = shared.astype(np.int64)
        per_layer[f"layer_{idx}"] = {"cut_share": 1.0 - within / max(total, 1e-30),
                                     "within_over_bound": within / max(bound, 1e-30),
                                     "swap_gain": within / max(before, 1e-30) - 1.0,
                                     "shared_mean_ubiquity": float(ubiq[shared].mean()) if s0 > 0 else 0.0}
        if on_layer:
            on_layer(idx, per_layer[f"layer_{idx}"])
    return arrays, per_layer


# --------------------------------------------------------------------------- 3. router + readiness

class ExpertNorms:
    """nu_i(x) = ||down_proj[:, S_i] h[S_i]|| from the s x s Grams of the down projection."""

    def __init__(self, mlp, parts, shared):
        import torch
        Wd = mlp.down_proj.weight.detach().float()                            # (d, m)
        self.parts = torch.as_tensor(np.asarray(parts), device=Wd.device)    # (N, s)
        self.shared = torch.as_tensor(np.asarray(shared), device=Wd.device)
        self.flat = self.parts.reshape(-1)
        N, s = self.parts.shape
        cols = Wd[:, self.flat].reshape(Wd.shape[0], N, s)
        self.G = torch.einsum("dns,dnt->nst", cols, cols)                     # (N, s, s)
        self.Wd = Wd

    def split(self, h):
        return h[:, self.flat].reshape(h.shape[0], *self.parts.shape)        # (T, N, s)

    def norms(self, h):                                                       # h: (T, m) float
        hs = self.split(h)
        return self.dot(hs).clamp_min(0).sqrt()

    def dot(self, hs):
        import torch
        return torch.einsum("bns,nst,bnt->bn", hs, self.G, hs)

    def routed_output(self, h, mask=None):
        """Sum of the routed experts' outputs, optionally only those with mask (T, N) = 1."""
        hs = self.split(h)
        if mask is not None:
            hs = hs * mask[:, :, None]
        return hs.reshape(h.shape[0], -1) @ self.Wd[:, self.flat].t()


def topk_mask(scores, k: int):
    import torch
    idx = torch.topk(scores, k, dim=1).indices
    return torch.zeros_like(scores).scatter_(1, idx, 1.0)


def fit_router(hf, Q, fit_data, eval_data, topk: int = 4, ridge: float = 1e-3, seed: int = 0, chunk: int = 4096,
               on_batch=None) -> tuple[dict, dict]:
    """Closed-form ridge router R (N x d) per layer from E[x x^T] and E[x nu^T] (nu = each
    expert's output norm) over fit_data, then readiness on eval_data (held-out tokens): router
    R^2, and the share of routed FFN energy dropped at top-k with the linear router, an oracle
    (true top-k by norm) and random picks. Returns (arrays, per-layer metrics)."""
    import torch
    layers = ffn_layers(hf)
    N, s = int(Q["N"]), int(Q["s"])
    k = max(1, min(N, int(topk)))
    d, m = dims(hf)
    ops = {idx: ExpertNorms(mlp, Q[f"parts_{idx}"], Q[f"shared_{idx}"]) for idx, mlp in layers}
    acc, ev = {}, {}
    for idx, mlp in layers:
        dev = mlp.down_proj.weight.device
        acc[idx] = {"xx": torch.zeros(d, d, device=dev, dtype=torch.float64),
                    "xn": torch.zeros(d, N, device=dev, dtype=torch.float64), "n": 0}
        ev[idx] = {"ss_res": 0.0, "drop_lin": 0.0, "drop_orc": 0.0, "drop_rnd": 0.0, "energy": 0.0,
                   "nu_sum": torch.zeros(N, device=dev, dtype=torch.float64),
                   "nu_sq": torch.zeros(N, device=dev, dtype=torch.float64), "n": 0,
                   "lo": float("inf"), "hi": float("-inf")}
    cache, routers = {}, {}
    phase = {"fit": True}
    rng = torch.Generator().manual_seed(int(seed) + 7)

    def pre_hook(idx):
        def hook(module, inputs):
            cache[idx] = inputs[0].detach().reshape(-1, d)
        return hook

    def post_hook(idx):
        def hook(module, inputs, output):
            xs = cache.pop(idx)
            hs = inputs[0].detach().reshape(-1, m)
            for a in range(0, hs.shape[0], chunk):
                x, h = xs[a:a + chunk].float(), hs[a:a + chunk].float()
                nu = ops[idx].norms(h)                                        # (T, N)
                if phase["fit"]:
                    acc[idx]["xx"] += (x.t() @ x).double()
                    acc[idx]["xn"] += (x.t() @ nu).double()
                    acc[idx]["n"] += x.shape[0]
                    continue
                e = ev[idx]
                pred = x @ routers[idx].t()                                   # (T, N)
                e["ss_res"] += float(((nu - pred) ** 2).sum())
                e["nu_sum"] += nu.sum(0).double()
                e["nu_sq"] += (nu * nu).sum(0).double()
                e["lo"] = min(e["lo"], float(pred.min()))
                e["hi"] = max(e["hi"], float(pred.max()))
                t = ops[idx].routed_output(h)
                rnd = torch.rand(nu.shape, generator=rng).to(nu.device)
                for key, scores in (("drop_lin", pred), ("drop_orc", nu), ("drop_rnd", rnd)):
                    sel = ops[idx].routed_output(h, topk_mask(scores, k))
                    e[key] += float(((t - sel) ** 2).sum())
                e["energy"] += float((t * t).sum())
                e["n"] += x.shape[0]
        return hook

    def solve():
        for idx, mlp in layers:
            n = max(acc[idx]["n"], 1)
            xx = (acc[idx]["xx"] / n).cpu()
            xn = (acc[idx]["xn"] / n).cpu()
            lam = float(ridge) * max(float(torch.trace(xx)) / d, 1e-30)
            R = torch.linalg.solve(xx + lam * torch.eye(d, dtype=torch.float64), xn).t()
            routers[idx] = R.float().to(mlp.down_proj.weight.device)          # (N, d)

    handles = []
    for idx, mlp in layers:
        handles.append(mlp.register_forward_pre_hook(pre_hook(idx)))
        handles.append(mlp.down_proj.register_forward_hook(post_hook(idx)))
    seen = 0
    dev0 = input_device(hf)

    def run(data):
        nonlocal seen
        for ids in data:
            hf.model(input_ids=ids.to(dev0))
            seen += ids.numel()
            if on_batch:
                on_batch(seen, phase["fit"])

    try:
        with torch.no_grad():
            run(fit_data)
            if not seen:
                raise ValueError("no tokens to fit the router on")
            solve()
            phase["fit"] = False
            log(f"router fitted on {seen} tokens; readiness on the held-out tokens")
            run(eval_data)
    finally:
        for hd in handles:
            hd.remove()
    if not any(ev[idx]["n"] for idx, _ in layers):
        raise ValueError("no held-out tokens: raise n_tokens or holdout")
    arrays = {"N": N, "s": s, "d": d, "k_readiness": k, "layer_ids": np.array([idx for idx, _ in layers])}
    per_layer = {}
    for idx, _ in layers:
        e = ev[idx]
        n = max(e["n"], 1)
        mean = e["nu_sum"] / n
        ss_tot = float((e["nu_sq"] - n * mean * mean).sum())
        en = max(e["energy"], 1e-30)
        row = {"router_r2": 1.0 - e["ss_res"] / max(ss_tot, 1e-30), "drop_linear": e["drop_lin"] / en,
               "drop_oracle": e["drop_orc"] / en, "drop_random": e["drop_rnd"] / en,
               "logit_range": e["hi"] - e["lo"]}
        per_layer[f"layer_{idx}"] = row
        arrays[f"R_{idx}"] = routers[idx].cpu().numpy()
        for key in ("router_r2", "drop_linear", "drop_oracle", "logit_range"):
            arrays[f"{key}_{idx}"] = row[key]
    return arrays, per_layer


# --------------------------------------------------------------------------- 4. build

def moe_config(base: dict, N: int, k: int, s: int, s0: int, dense_layers: list[int]):
    """The Qwen3-MoE / Qwen2-MoE config of the converted model, from the dense one."""
    from transformers import CONFIG_MAPPING
    fam = family(base)
    moe_type = FAMILIES[fam]["moe_type"]
    cls = CONFIG_MAPPING[moe_type]
    allowed = {f.name for f in fields(cls)} if is_dataclass(cls) else set(inspect.signature(cls.__init__).parameters)
    kw = {key: v for key, v in base.items()
          if key in allowed and key not in ("architectures", "model_type", "transformers_version")}
    kw.update(num_experts=N, num_experts_per_tok=k, moe_intermediate_size=s, norm_topk_prob=False,
              decoder_sparse_step=1, mlp_only_layers=list(dense_layers), router_aux_loss_coef=0.0,
              output_router_logits=False, intermediate_size=base["intermediate_size"])
    if FAMILIES[fam]["shared"]:
        kw["shared_expert_intermediate_size"] = s0
    if fam == "qwen2":
        kw["qkv_bias"] = True                     # Qwen2 dense attention always has q/k/v biases
    cfg = cls(**{key: v for key, v in kw.items() if key in allowed})
    cfg.architectures = ["Qwen3MoeForCausalLM" if fam == "qwen3" else "Qwen2MoeForCausalLM"]
    return cfg


def fill_experts(sd: dict, prefix: str, W_gate, W_up, W_down, parts, scale: float) -> str:
    """Writes expert tensors into the state dict under prefix, fused or per-expert layout."""
    import torch
    N, s = parts.shape
    fused_gu, fused_dn = f"{prefix}experts.gate_up_proj", f"{prefix}experts.down_proj"
    if fused_gu in sd:
        gu, dn = sd[fused_gu], sd[fused_dn]
        for e in range(N):
            S = parts[e]
            block = torch.cat([W_gate[S], W_up[S]], dim=0)                   # (2s, d), gate first
            down = W_down[:, S] * scale                                       # (d, s)
            gu[e].copy_(block if gu.shape[1] == 2 * s else block.t())
            dn[e].copy_(down if dn.shape[1] == down.shape[0] else down.t())
        return "fused"
    if f"{prefix}experts.0.gate_proj.weight" in sd:
        for e in range(N):
            S = parts[e]
            sd[f"{prefix}experts.{e}.gate_proj.weight"].copy_(W_gate[S])
            sd[f"{prefix}experts.{e}.up_proj.weight"].copy_(W_up[S])
            sd[f"{prefix}experts.{e}.down_proj.weight"].copy_(W_down[:, S] * scale)
        return "per-expert"
    keys = sorted(key for key in sd if key.startswith(prefix))
    raise ValueError(f"unknown expert layout under {prefix}: {keys[:6]}")


def decide(Rz, layer_ids, min_r2: float, max_drop: float) -> tuple[list[int], dict]:
    """(dense layers, per-layer decisions): a layer converts when its router R^2 >= min_r2 and
    the linear router drops <= max_drop of the routed FFN energy at the readiness k."""
    dense, decisions = [], {}
    for idx in layer_ids:
        r2, drop = float(Rz[f"router_r2_{idx}"]), float(Rz[f"drop_linear_{idx}"])
        ok = r2 >= float(min_r2) and drop <= float(max_drop)
        decisions[f"layer_{idx}"] = {"converted": bool(ok), "router_r2": r2, "drop_linear": drop}
        if not ok:
            dense.append(int(idx))
    return dense, decisions


def build(hf, Q, Rz, topk: int = 4, min_r2: float = 0.6, max_drop: float = 0.15, gate_eps: float = 1e-3):
    """(the MoE model, report): layers that fail the readiness gates stay dense (mlp_only_layers)."""
    import torch
    from transformers import AutoModelForCausalLM
    N, s, s0 = int(Q["N"]), int(Q["s"]), int(Q["s0"])
    k = max(1, min(N, int(topk)))
    fam = family(hf.config)
    layers = ffn_layers(hf)
    base = hf.config.to_dict()
    dense_layers, decisions = decide(Rz, [idx for idx, _ in layers], min_r2, max_drop)
    log(f"converting {len(layers) - len(dense_layers)} of {len(layers)} layers; dense: {dense_layers}")
    cfg = moe_config(base, N, k, s, s0, dense_layers)
    dtype = next(hf.parameters()).dtype
    moe = AutoModelForCausalLM.from_config(cfg, **_dtype_kw(dtype)).eval()
    sd = moe.state_dict()
    layouts = set()
    with torch.no_grad():
        for key, val in hf.state_dict().items():
            if ".mlp." in key:
                continue
            if key not in sd:
                raise ValueError(f"base tensor {key} has no counterpart in {cfg.model_type}")
            sd[key].copy_(val.to(device="cpu", dtype=sd[key].dtype))
        for idx, mlp in layers:
            prefix = f"model.layers.{idx}.mlp."
            Wg = mlp.gate_proj.weight.detach().float().cpu()
            Wu = mlp.up_proj.weight.detach().float().cpu()
            Wd = mlp.down_proj.weight.detach().float().cpu()
            if idx in dense_layers:
                for name, W in (("gate_proj", Wg), ("up_proj", Wu), ("down_proj", Wd)):
                    sd[f"{prefix}{name}.weight"].copy_(W)
                continue
            parts = torch.as_tensor(np.asarray(Q[f"parts_{idx}"]))
            layouts.add(fill_experts(sd, prefix, Wg, Wu, Wd, parts, scale=float(N)))
            # flattened softmax: every expert's weight is 1/N within gate_eps, the order kept
            R = torch.as_tensor(np.asarray(Rz[f"R_{idx}"])).float()
            beta = float(gate_eps) / max(float(Rz[f"logit_range_{idx}"]), 1e-12)
            sd[f"{prefix}gate.weight"].copy_(beta * R)
            if FAMILIES[fam]["shared"]:
                S0 = torch.as_tensor(np.asarray(Q[f"shared_{idx}"]))
                sd[f"{prefix}shared_expert.gate_proj.weight"].copy_(Wg[S0])
                sd[f"{prefix}shared_expert.up_proj.weight"].copy_(Wu[S0])
                sd[f"{prefix}shared_expert.down_proj.weight"].copy_(2.0 * Wd[:, S0])   # sigmoid(0) = 1/2
                sd[f"{prefix}shared_expert_gate.weight"].zero_()
    moe.load_state_dict(sd)
    d = dims(hf)[0]
    n_sparse = len(layers) - len(dense_layers)
    total = int(sum(p.numel() for p in moe.parameters()))
    rep = {"base": getattr(hf.config, "_name_or_path", ""), "moe_type": cfg.model_type, "experts": N, "topk": k,
           "expert_width": s, "shared_width": s0, "gate_eps": float(gate_eps), "expert_layout": sorted(layouts),
           "dense_layers": dense_layers, "decisions": decisions, "params_total": total,
           "params_active_per_token": total - n_sparse * (N - k) * 3 * d * s,
           "converted_layers_frac": n_sparse / max(len(layers), 1)}
    return moe, rep


# --------------------------------------------------------------------------- 5. verify

def set_topk(moe, k: int) -> None:
    for layer in moe.model.layers:
        for obj in (layer.mlp, getattr(layer.mlp, "gate", None)):
            if obj is not None and hasattr(obj, "top_k"):
                obj.top_k = k


def verify(dense, moe, data) -> dict:
    """Equivalence with the dense model at k = N (max logit error over the largest logit, and
    the KL), then the logit KL and MSE to the dense model at the checkpoint's k."""
    import torch
    N, k = int(moe.config.num_experts), int(moe.config.num_experts_per_tok)
    dense_layers = list(getattr(moe.config, "mlp_only_layers", None) or [])
    stats = {"max_abs": 0.0, "ref": 0.0, "kl_n": 0.0, "kl": 0.0, "mse": 0.0, "top1": 0.0, "n": 0}
    dev_d, dev_m = input_device(dense), input_device(moe)

    def kl(ref, out):
        lp, lq = torch.log_softmax(ref, -1), torch.log_softmax(out, -1)
        return float((lp.exp() * (lp - lq)).sum(-1).sum())

    try:
        with torch.no_grad():
            for ids in data:
                ref = dense(input_ids=ids.to(dev_d)).logits.float().cpu()
                set_topk(moe, N)
                full = moe(input_ids=ids.to(dev_m)).logits.float().cpu()
                set_topk(moe, k)
                out = moe(input_ids=ids.to(dev_m)).logits.float().cpu()
                stats["max_abs"] = max(stats["max_abs"], float((full - ref).abs().max()))
                stats["ref"] = max(stats["ref"], float(ref.abs().max()))
                stats["kl_n"] += kl(ref, full)
                stats["kl"] += kl(ref, out)
                stats["mse"] += float(((out - ref) ** 2).mean(-1).sum())
                stats["top1"] += float((out.argmax(-1) == ref.argmax(-1)).float().sum())
                stats["n"] += ids.numel()
    finally:
        set_topk(moe, k)
    n = max(stats["n"], 1)
    return {"equiv_max_abs": stats["max_abs"], "equiv_rel_err": stats["max_abs"] / max(stats["ref"], 1e-12),
            "kl_at_all_experts": stats["kl_n"] / n, "kl_vs_dense": stats["kl"] / n,
            "logit_mse": stats["mse"] / n, "top1_agreement": stats["top1"] / n,
            "converted_layers_frac": 1.0 - len(dense_layers) / len(moe.model.layers),
            "experts": N, "topk": k, "tokens": stats["n"]}
