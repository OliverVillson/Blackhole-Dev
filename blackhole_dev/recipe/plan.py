"""Dry-run plan of a recipe: the size, KV cache, fit and rough time before anything runs.

Opens the base model's headers (a local folder, or a Hub id when online), applies each
step's size effect on the lazy anatomy model (expert drops, storage formats) and asks
`Model.plan()` for the result on a device. Nothing is downloaded or computed: REAP scores
are stand-ins, so which experts go is arbitrary, only how many is real. Steps whose
effect is not simulated say so in their detail.
"""

from __future__ import annotations

import re
from typing import Any

from blackhole_dev.recipe import pipeline as pl
from blackhole_dev.recipe.core import Recipe

REF = re.compile(r"\$\{([A-Za-z_][\w.-]*)\}")

# id, label, blackhole.hw.DEVICES key (or memory GB, bandwidth GB/s, kind)
DEVICES = [
    ("mac16", "Mac, 16 GB unified memory", "M-series-16GB"),
    ("mac32", "Mac, 32 GB unified memory", "M-series-32GB"),
    ("gpu8", "GPU, 8 GB VRAM", "8GB-VRAM"),
    ("gpu12", "GPU, 12 GB VRAM", "12GB-VRAM"),
    ("gpu16", "GPU, 16 GB VRAM", "16GB-VRAM"),
    ("gpu24", "GPU, 24 GB VRAM", "24GB-VRAM"),
    ("cpu32", "CPU, 32 GB RAM", "CPU-32GB"),
    ("b300", "NVIDIA B300, 288 GB", (288, 8000, "cuda")),
]
# functions whose size effect plan simulates on the lazy model (with stand-in REAP scores)
SIMULATED = {"reap-prune", "drop-experts", "reaq", "quant", "drop-layers", "duplicate-layers", "trim-head"}


def devices() -> list[dict]:
    from blackhole.hw import DEVICES as HW
    out = []
    for did, label, key in DEVICES:
        mem = key[0] if isinstance(key, tuple) else HW[key][0]
        out.append({"id": did, "label": label, "memGb": mem})
    return out


def _device_args(device: str | None) -> dict:
    if not device:
        return {}
    for did, _label, key in DEVICES:
        if device in (did, key if isinstance(key, str) else None):
            if isinstance(key, tuple):
                mem, bw, kind = key
                return {"budget_gb": mem * {"metal": 0.75, "cuda": 0.92, "cpu": 0.7}[kind], "bandwidth_gbs": bw}
            return {"device": key}
    from blackhole.hw import DEVICES as HW
    if device in HW:
        return {"device": device}
    raise ValueError(f"unknown device {device!r}; one of {', '.join(d[0] for d in DEVICES)}")


def _resolve(v: Any, scope: dict) -> Any:
    from blackhole.core import schema as sch
    try:
        return sch.resolve(v, scope)
    except sch.SchemaError:
        return v


def _num(v: Any) -> str:
    try:
        return f"{float(v):.4g}"
    except (TypeError, ValueError):
        return str(v)


def _gb(x: float) -> str:
    return f"{x:.2f} GB" if x >= 0.1 else f"{x * 1e3:.2f} MB" if x >= 1e-4 else f"{x * 1e6:.1f} KB"


def _detail(st, params: dict) -> str:
    op = st.op
    if op == "pipeline.reap":
        return f"REAP drops {_num(params.get('prune', 0.25))} of routed experts" + (
            f", calibrated on {params['calib']}" if params.get("calib") else "")
    if op == "pipeline.mlx":
        ex = "HEX experts" if params.get("mlx_hex") else f"{params.get('mlx_bits', 3)}-bit experts"
        return f"MLX export: {ex}, {params.get('mlx_attn_bits', 4)}-bit attention"
    if op in ("model.edit", "job.fn"):
        names = st.functions()
        return " → ".join(names) if names else op
    shown = [f"{k}={v}" for k, v in list(params.items())[:3]]
    return ", ".join(shown)


def _stand_in_scores(m) -> None:
    for L in m.layers:
        if L.moe is not None and any(e.attrs.get("score") is None for e in L.moe.experts):
            n = len(L.moe.experts)
            m.set_scores(L.index, [float(n - i) for i in range(n)])


def _try(fn, notes: list, what: str) -> bool:
    try:
        fn()
        return True
    except Exception as e:  # noqa: BLE001
        notes.append(f"{what}: {type(e).__name__}: {e}")
        return False


def _apply(m, st, params: dict, notes: list) -> str:
    """Apply one step's size effect to the lazy model. Returns how it was simulated."""
    op = st.op
    defaults = pl.DEFAULTS or {}
    if op == "pipeline.reap":
        ratio = float(params.get("prune", defaults.get("prune", 0.25)))
        def drop():
            for L in m.layers:
                if L.moe is not None:
                    n = len(L.moe.experts)
                    k = int(round(n * ratio))
                    if k:
                        m.drop_experts(L.index, list(range(n - k, n)))
        return "simulated" if _try(drop, notes, "reap") else "not simulated"
    if op == "pipeline.gptq":
        return "simulated" if _try(lambda: m["experts"].quant("int4"), notes, "gptq") else "not simulated"
    if op == "pipeline.quant":
        return "simulated" if _try(lambda: m["experts"].quant("fp8"), notes, "quant") else "not simulated"
    if op == "pipeline.mlx":
        g = int(params.get("mlx_group", defaults.get("mlx_group", 64)))
        bits = int(params.get("mlx_bits", defaults.get("mlx_bits", 3)))
        attn = int(params.get("mlx_attn_bits", defaults.get("mlx_attn_bits", 4)))
        hot = float(params.get("mlx_hot", defaults.get("mlx_hot", 0.0)))
        hot_bits = int(params.get("mlx_hot_bits", defaults.get("mlx_hot_bits", 4)))
        emb = int(params.get("mlx_embed_bits", defaults.get("mlx_embed_bits", 4)))
        head = int(params.get("mlx_head_bits", defaults.get("mlx_head_bits", 6)))
        ok = True
        if params.get("mlx_hex"):
            ok &= _try(lambda: m["experts"].quant(f"hex{bits}"), notes, "mlx experts")
            if hot:
                _stand_in_scores(m)
                ok &= _try(lambda: m[f"experts[rank<{hot}]"].quant(f"hex{max(3, min(4, hot_bits))}"), notes, "mlx hot")
        else:
            ok &= _try(lambda: m["experts"].quant(f"mlx{bits}_g{g}"), notes, "mlx experts")
            if hot:
                _stand_in_scores(m)
                ok &= _try(lambda: m[f"experts[rank<{hot}]"].quant(f"mlx{hot_bits}_g{g}"), notes, "mlx hot")
        for q in ("layers[*].attn", "layers[*].mixer", "layers[*].mlp", "layers[*].moe.shared"):
            _try(lambda q=q: m[q].quant(f"mlx{attn}_g{g}"), [], q)
        _try(lambda: m.embed.quant(f"mlx{emb}_g{g}"), [], "embed")
        if m.head is not None and not m.head.attrs.get("tied"):
            _try(lambda: m.head.quant(f"mlx{head}_g{g}"), [], "head")
        return "simulated" if ok else "partly simulated"
    if op == "model.edit":
        calls = []
        if params.get("fn"):
            a = dict(params.get("args") or {})
            calls.append((params["fn"], params.get("select"), a))
        for s in params.get("steps") or []:
            if isinstance(s, dict):
                s = dict(s)
                calls.append((s.pop("fn", ""), s.pop("select", None), s))
        how = "simulated"
        for name, sel, a in calls:
            if name not in SIMULATED:
                how = "partly simulated" if how == "simulated" and len(calls) > 1 else "not simulated"
                continue
            _stand_in_scores(m)
            if not _try(lambda: m.call(name, sel, **a), notes, name):
                how = "partly simulated"
        return how
    return "no size effect"


def _hours(r: Recipe, params_of: dict, params_b: float | None) -> float | None:
    """Rough GPU hours on a B300 for a pipeline recipe, from the 2026-10-25 Qwen3.6-35B run."""
    if r.runner != "pipeline":
        return None
    d = pl.DEFAULTS or {}
    scale = max(0.2, (params_b or 35.0) / 35.0)
    h = 0.4                                         # detect, plan, weights, calibrate
    for st in r.steps:
        p = {**d, **params_of.get(st.id, {})}
        name = st.op.split(".", 1)[1] if st.family == "pipeline" else None
        if name == "reap":
            h += 0.4
        elif name == "heal":
            h += (float(p.get("heal_minutes", 45)) + int(p.get("heal_opd_rounds", 0)) * float(p.get("heal_opd_minutes", 60))) / 60
            h += 0.5 if p.get("heal_calib") == "contest" else 0.1
        elif name == "qheal":
            h += float(p.get("qheal_minutes", 45)) / 60
        elif name == "bench":
            h += 0.0 if p.get("bench") == "none" else 0.8
        elif name in ("gptq", "reaq", "mlx"):
            h += 0.3
        elif name in ("quant", "package"):
            h += 0.1
        elif st.family == "job":
            h += 0.5
    return round(h * scale, 1)


def plan(r: Recipe, device: str | None = "mac16", model: str | None = None, inputs: dict | None = None,
         context: int = 8192) -> dict:
    """The PLAN panel's data: rows, sizeGb, fits, kvGb, estHours, problems, steps, needs."""
    from blackhole.core import schema as sch
    import blackhole_dev as anatomy
    rows: list[dict] = []
    problems: list[dict] = []
    model = model or r.fields.get("base")
    try:
        vals = sch.input_values(r.schema(), dict(inputs or {}))
    except Exception:  # noqa: BLE001  a required input without a value: plan with what there is
        vals = {k: v.get("default") for k, v in r.input_specs.items()}
    scope = {"inputs": vals, "base": {"model": model, "id": model}}
    params_of = {st.id: _resolve({k: v for k, v in st.to_raw().items() if k not in sch.RESERVED}, scope)
                 for st in r.steps}
    dev = _device_args(device)
    m = None
    gated = None
    if model:
        try:
            m = anatomy.open(model)
        except Exception as e:  # noqa: BLE001
            problems.append({"severity": "warning", "message": _open_problem(model, e),
                             "line": r.line, "code": "plan.no-model"})
        if m is not None and m.root is None:
            from blackhole_dev.model import hub_gated
            gated = hub_gated(str(model))
    else:
        problems.append({"severity": "warning", "message": "no base model: set base= on the Recipe or pick a model",
                         "line": r.line, "code": "plan.no-model"})
    before = m.plan(context=context) if m is not None else None
    steps, notes = [], []
    for st in r.steps:
        p = params_of[st.id]
        how = _apply(m, st, p, notes) if m is not None else "not simulated"
        steps.append({"name": st.id, "fn": st.fn or st.op, "kind": {"pipeline": "pipeline", "job": "job"}.get(
            st.family, "function" if st.op == "model.edit" else "op"), "detail": _detail(st, p),
            "line": st.line, "user": False, "sim": how})
    for n in notes:
        problems.append({"severity": "info", "message": f"plan: {n}", "line": r.line, "code": "plan.sim"})
    after = m.plan(context=context, **dev) if m is not None else None
    hours = _hours(r, params_of, before.params_b if before else None)
    rows.append({"label": "Base model", "value": model or "none"})
    if before and after:
        rows.append({"label": "Size before", "value": _gb(before.total_gb)})
        rows.append({"label": "Size after", "value": _gb(after.total_gb),
                     "tone": "ok" if after.total_gb < before.total_gb else None})
        rows.append({"label": "Params", "value": f"{after.params_b:.3g} B"})
        rows.append({"label": f"KV cache @ {context // 1024}k", "value": _gb(after.kv_gb)})
        if after.budget_gb is not None:
            need = after.total_gb + after.kv_gb
            rows.append({"label": f"Fits {device}", "value": f"{_gb(need)} of {after.budget_gb:.2f} GB usable",
                         "tone": "ok" if after.fits else "bad"})
            if not after.fits:
                problems.append({"severity": "warning", "message": f"does not fit {device}: {need:.2f} GB needed, "
                                 f"{after.budget_gb:.2f} GB usable", "line": r.line, "code": "plan.fit"})
        if after.tok_s:
            rows.append({"label": "Decode (estimate)", "value": f"~{after.tok_s:.0f} tok/s"})
    if hours is not None:
        rows.append({"label": "GPU time (rough, B300)", "value": f"~{hours} h", "tone": "warn" if hours > 6 else None})
    rows.append({"label": "Runner", "value": r.runner})
    rows = [{k: v for k, v in row.items() if v is not None} for row in rows]
    needs = {"gpu_gb": round(before.total_gb * 1.15 + 10, 1) if before else None,
             "disk_gb": round(before.total_gb * 3 + 50, 1) if before else None}
    return {"rows": rows, "sizeGb": round(after.total_gb, 6) if after else None,
            "fits": after.fits if after else None, "kvGb": round(after.kv_gb, 6) if after else None,
            "estHours": hours, "problems": problems, "steps": steps, "needs": needs,
            "device": device, "model": model, "gated": gated,
            "baseGb": round(before.total_gb, 6) if before else None}


def _open_problem(model: str, e: Exception) -> str:
    """Why the base model could not be read, in words a person can act on."""
    name = type(e).__name__
    if name in ("GatedRepoError",) or "401" in str(e) or "403" in str(e):
        return f"{model} is gated on Hugging Face: accept its licence there and log in (hf auth login) to plan it"
    if name in ("RepositoryNotFoundError",) or "404" in str(e):
        return f"{model} is not on Hugging Face (check the name, or point base= at a local folder)"
    if name in ("HubUnreachable", "ConnectError", "ConnectTimeout", "ReadTimeout", "LocalEntryNotFoundError",
                "OfflineModeIsEnabled") or "timed out" in str(e).lower():
        return f"cannot reach huggingface.co to read {model}'s headers ({e}); sizes and time are unknown"
    return f"cannot open {model} to plan sizes: {e}"
