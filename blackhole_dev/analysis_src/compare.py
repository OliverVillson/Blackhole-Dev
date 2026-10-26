"""Built-in analysis `compare`: this model against another (by default, a fork's parent)."""

import json
from pathlib import Path

import blackhole_dev
from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import config_diff, layer_of, rel_diff, rel_diff_bytes, short, tensor_pairs
from blackhole_dev.fork import FORK_FILE, parent_changed

_open_cache = {}


def _other(m, other):
    if not other and getattr(m, "root", None) and (Path(m.root) / FORK_FILE).is_file():
        other = json.loads((Path(m.root) / FORK_FILE).read_text())["parent"]
    if not other:
        raise ValueError("give `other` (a model folder or Hub id); a fork defaults to its parent")
    key = str(Path(other).expanduser())
    if key not in _open_cache:
        _open_cache.clear()
        _open_cache[key] = blackhole_dev.open(Path(other).expanduser() if Path(other).expanduser().is_dir() else other)
    return _open_cache[key], key


def _renumbered(m, b) -> set:
    """Layers whose experts were dropped, merged or added: expert N is not the same expert in
    both models there, so comparing their tensors by name would be meaningless."""
    out = set()
    for La, Lb in zip(m.layers, b.layers):
        if (La.moe is None) != (Lb.moe is None) or (La.moe and La.moe.num_experts != Lb.moe.num_experts):
            out.add(La.index)
    return out


def _comparable(m, b, pairs) -> tuple[list, list]:
    skip = _renumbered(m, b)
    keep, left = [], []
    for n in pairs["same_shape"]:
        L = layer_of(n)
        (left if L in skip and ".experts" in n else keep).append(n)
    return keep, left


def _cost(m, other="", sample=64):
    b, _ = _other(m, other)
    keep, _ = _comparable(m, b, tensor_pairs(m, b))
    return sum(rel_diff_bytes(m._t[n], b._t[n], sample) for n in keep)


@analysis("compare", title="Compare two models", needs="weights", cost=_cost, group="forks")
def run(r, m, other: str = "", sample: int = 64):
    """Size per part, structure (layers, experts, tensors added or removed, dtypes, config)
    and how far every shared weight moved (relative difference and cosine on `sample` rows
    per tensor, 0 = all rows). Tensors a fork still shares with its parent are known to be
    identical without reading them."""
    b, path = _other(m, other)
    pa, pb = m.plan(), b.plan()
    pairs = tensor_pairs(m, b)
    keep, renumbered = _comparable(m, b, pairs)
    diffs = {}
    same = 0
    for k, n in enumerate(keep):
        if k % 64 == 0:
            r.progress(f"comparing {n}", k / max(len(keep), 1))
        d = rel_diff(m._t[n], b._t[n], sample)
        diffs[n] = d
        same += d["identical"] or d["rel_diff"] == 0.0
    changed = {n: d for n, d in diffs.items() if d["rel_diff"] > 0}
    r.title(f"{Path(str(m.id)).name} vs {Path(path).name}")
    r.tiles([("This model", round(pa.total_gb, 3), "GB"), ("Other", round(pb.total_gb, 3), "GB"),
             ("Tensors changed", len(changed), f"of {len(keep)} compared"),
             ("Unchanged", same), ("Only here", len(pairs["only_a"])), ("Only there", len(pairs["only_b"])),
             *([("Parent changed since fork", "yes", "its files differ from the forked ones", "warn")]
               if not other and getattr(m, "root", None) and parent_changed(Path(m.root)) else [])])
    if renumbered:
        r.text(f"Experts were dropped, merged or added in layer{'s' if len(_renumbered(m, b)) > 1 else ''} "
               f"{', '.join(map(str, sorted(_renumbered(m, b))))}, so expert N is a different expert in each model "
               f"there: those {len(renumbered)} expert tensors are left out of the weight comparison.")
    gs = sorted(set(pa.groups) | set(pb.groups))
    r.bar("Size by part (GB)", gs, {"this model": [round(pa.groups.get(g, {}).get("gb", 0), 4) for g in gs],
                                    "other": [round(pb.groups.get(g, {}).get("gb", 0), 4) for g in gs]}, ylabel="GB")
    per_layer: dict = {}
    for n, d in diffs.items():
        L = layer_of(n)
        if L is not None:
            per_layer.setdefault(L, []).append(d)
    if per_layer:
        xs = sorted(per_layer)
        r.line("Weight change by layer", xs, {"mean rel. difference": [sum(d["rel_diff"] for d in per_layer[i]) / len(per_layer[i]) for i in xs]},
               xlabel="layer", ylabel="‖a−b‖ / ‖a‖")
        r.line("Cosine to the other model by layer", xs, {"min cosine": [min(d["cosine"] for d in per_layer[i]) for i in xs]},
               xlabel="layer", ylabel="cosine")
    struct = [["layers", len(m.layers), len(b.layers)]]
    for La, Lb in zip(m.layers, b.layers):
        ea = La.moe.num_experts if La.moe else None
        eb = Lb.moe.num_experts if Lb.moe else None
        if ea != eb:
            struct.append([f"experts in layer {La.index}", ea, eb])
    for n in pairs["reshaped"][:50]:
        struct.append([n, str(list(m._t[n].shape)), str(list(b._t[n].shape))])
    for n in pairs["same_shape"]:
        if m._t[n].dtype != b._t[n].dtype:
            struct.append([f"{n} dtype", m._t[n].dtype, b._t[n].dtype])
    r.table("Structure", ["what", "this model", "other"], struct)
    top = sorted(changed.items(), key=lambda kv: -kv[1]["rel_diff"])[:40]
    if top:
        r.table("Most changed tensors", ["tensor", "rel. difference", "cosine"],
                [[n, d["rel_diff"], d["cosine"]] for n, d in top])
    if pairs["only_a"] or pairs["only_b"]:
        r.table("Tensors in one model only", ["tensor", "in"],
                [[n, "this model"] for n in pairs["only_a"][:60]] + [[n, "other"] for n in pairs["only_b"][:60]])
    cd = config_diff(m.config, b.config)
    if cd:
        r.table("config.json differences", ["key", "this model", "other"], [[k, short(x), short(y)] for k, x, y in cd[:80]])
