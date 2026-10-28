"""Select parts with a path query.

    layers[0:4].attn                      attention of the first four layers
    layers[-1]                            the last layer
    layers[kind==mixer]                   every linear-attention / Mamba layer
    layers[*].moe.experts[rank<0.25]      the bottom quarter of every layer's experts by REAP score
    experts[score<0.01 & layer>=10]       shortcut: a name that is not a model child searches every layer
    layers[3].attn.heads[0,5,7]           three heads of layer 3
    moe.router                            every router;  moe.shared  every shared expert
    embed  head  norm  mtp  layers

A filter is `*`, an index, a slice `a:b`, a list `1,5,7`, or conditions on the parts'
attributes joined by `&`: key (==, !=, <, <=, >, >=) value. Attributes: index/id, layer, kind,
score, freq, rank, params. Missing attributes never match.
"""

from __future__ import annotations

import operator
import re

OPS = {"<=": operator.le, ">=": operator.ge, "==": operator.eq, "!=": operator.ne, "<": operator.lt,
       ">": operator.gt, "=": operator.eq}
SEG = re.compile(r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?:\[(?P<filter>[^\]]*)\])?$")
COND = re.compile(r"^\s*(?P<key>[A-Za-z_]+)\s*(?P<op><=|>=|==|!=|<|>|=)\s*(?P<val>.+?)\s*$")
TOP = ("layers", "embed", "head", "norm", "mtp")


class QueryError(ValueError):
    pass


def _split(q: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in q.strip():
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        if ch == "." and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _value(s: str):
    try:
        return int(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return s.strip("'\"")


def _attr(part, key: str):
    if key in ("params",):
        return part.params
    if key == "kind":
        return part.attrs.get("kind", part.kind)
    if key in ("index", "id"):
        return part.attrs.get("index", part.attrs.get("id"))
    return part.attrs.get(key)


def _filter(items: list, f: str | None) -> list:
    if f is None or f.strip() in ("", "*"):
        return list(items)
    f = f.strip()
    if re.fullmatch(r"-?\d*:-?\d*(?::-?\d+)?", f):
        parts = [int(x) if x else None for x in f.split(":")]
        return list(items[slice(*parts)])
    if re.fullmatch(r"-?\d+(\s*,\s*-?\d+)*", f):
        out = []
        for x in f.split(","):
            i = int(x)
            if -len(items) <= i < len(items):
                out.append(items[i])
        return out
    conds = []
    for term in re.split(r"\s*&\s*|\s+and\s+", f):
        m = COND.match(term)
        if not m:
            raise QueryError(f"cannot read filter {term!r}: use *, 3, 0:4, 1,5,7 or key<value (score, rank, layer, kind, ...)")
        conds.append((m["key"], OPS[m["op"]], _value(m["val"])))

    def ok(p) -> bool:
        for key, op, val in conds:
            got = _attr(p, key)
            if got is None:
                return False
            try:
                if not op(got, val):
                    return False
            except TypeError:
                return False
        return True
    return [p for p in items if ok(p)]


def select(root, query: str):
    from blackhole_dev.parts import Selection
    segs = _split(query)
    if not segs:
        raise QueryError("empty query")
    is_model = root.kind == "model"
    first = SEG.match(segs[0])
    if first is None:
        raise QueryError(f"cannot read {segs[0]!r}")
    if is_model and first["name"] not in TOP:
        segs = ["layers[*]"] + segs                   # experts[...] == layers[*].moe.experts[...]
    current = [root]
    for seg in segs:
        m = SEG.match(seg)
        if m is None:
            raise QueryError(f"cannot read {seg!r} in {query!r}")
        name, flt = m["name"], m["filter"]
        nxt = []
        for p in current:
            if name in ("experts", "router", "shared") and p.kind == "layer":   # layers[3].experts
                p = p.moe
                if p is None:
                    continue
            c = p.child(name)
            if c is None:
                continue
            if isinstance(c, list):
                nxt.extend(_filter(c, flt))
            elif flt is None or _filter([c], flt):
                nxt.append(c)
        current = nxt
    return Selection(current)
