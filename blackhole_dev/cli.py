"""`blackhole inspect` and `blackhole fn`: the anatomy API from the shell.

    blackhole inspect MODEL                          the tree: embed, head, layers with their blocks
    blackhole inspect MODEL "layers[3].moe.experts"  a query; --scores saliency.json adds REAP scores
    blackhole inspect MODEL --tensors                every tensor with dtype and shape
    blackhole inspect MODEL --plan [--device M-series-16GB] [--quant "experts=hex3,attn=int4"]
    blackhole inspect MODEL "experts[0:4]" --stats   weight statistics per part
    blackhole inspect MODEL "experts[0:4]" --measure hex3,int4   round-to-nearest error per format

    blackhole fn list                                named functions and their params
    blackhole fn show NAME
    blackhole fn run MODEL NAME [--select Q] [--set k=v ...] [--scores F] [--functions FILE ...] -o OUT
"""

from __future__ import annotations

import argparse
import json
import sys

COMMANDS = {"inspect", "fn"}


def add_commands(sub) -> None:
    i = sub.add_parser("inspect", help="model structure, parts, weights, size plan")
    i.add_argument("model")
    i.add_argument("query", nargs="?")
    i.add_argument("--scores", help="REAP saliency file to attach")
    i.add_argument("--tensors", action="store_true")
    i.add_argument("--plan", action="store_true")
    i.add_argument("--device")
    i.add_argument("--quant", help='formats per query, e.g. "experts=hex3,layers[*].attn=int4"')
    i.add_argument("--stats", action="store_true")
    i.add_argument("--measure", help="comma-separated formats to probe on the selected parts")
    i.add_argument("--columns", default="path,params,score,freq,rank")
    i.add_argument("--json", action="store_true")
    f = sub.add_parser("fn", help="named weight functions")
    fs = f.add_subparsers(dest="fn_cmd", required=True)
    fs.add_parser("list")
    sh = fs.add_parser("show")
    sh.add_argument("name")
    r = fs.add_parser("run")
    r.add_argument("model")
    r.add_argument("name")
    r.add_argument("--select")
    r.add_argument("--set", action="append", default=[], metavar="K=V")
    r.add_argument("--scores")
    r.add_argument("--functions", nargs="*", default=[])
    r.add_argument("-o", "--out", required=True)
    r.add_argument("--pack", choices=["hex"])
    r.add_argument("--force", action="store_true")


def _value(v: str):
    try:
        return json.loads(v)
    except json.JSONDecodeError:
        return v


def dispatch(a) -> int:
    import blackhole_dev as anatomy
    if a.cmd == "inspect":
        m = anatomy.open(a.model)
        if a.scores:
            m.load_scores(a.scores)
        if a.quant:
            for item in a.quant.split(","):
                q, _, fmt = item.partition("=")
                m.select(q.strip()).quant(fmt.strip())
        if a.tensors:
            for v in m.views:
                print(f"{v.name:<70} {v.dtype:<8} {list(v.shape)}")
            return 0
        if a.plan:
            plan = m.plan(device=a.device)
            print(json.dumps(plan.to_dict(), indent=2) if a.json else plan)
            return 0
        if not a.query:
            print(m.summary())
            return 0
        sel = m.select(a.query)
        if a.json:
            print(json.dumps([p.info() for p in sel], indent=2, default=str))
            return 0
        if a.measure:
            for p in sel:
                row = "  ".join(f"{f}: {p.measure(f)['rel_mse']:.3e}" for f in a.measure.split(","))
                print(f"{p.path:<40} {row}")
            return 0
        if a.stats:
            for p in sel:
                s = p.stats()
                print(f"{p.path:<40} rms {s['rms']:.4g}  absmax {s['absmax']:.4g}  kurtosis {s['kurtosis']:.3g}  "
                      f"zeros {s['zero_frac']:.2%}")
            return 0
        print(sel.table(*a.columns.split(",")))
        print(f"{len(sel)} parts, {sel.params:,} params")
        return 0
    if a.cmd == "fn":
        from blackhole_dev import functions as fns
        if a.fn_cmd == "list":
            for name, f in fns.registry().items():
                ps = ", ".join(f"{k}={v['default']!r}" if not v["required"] else k for k, v in f.params.items())
                print(f"{name:<24} per {f.per:<7} {f.doc.splitlines()[0] if f.doc else ''}")
                if ps:
                    print(f"{'':<24} ({ps})")
            return 0
        if a.fn_cmd == "show":
            print(json.dumps(fns.describe(a.name), indent=2, default=str))
            return 0
        for spec in a.functions:
            fns.load(spec)
        m = anatomy.open(a.model)
        if a.scores:
            m.load_scores(a.scores)
        params = {}
        for kv in a.set:
            k, _, v = kv.partition("=")
            params[k] = _value(v)
        out = m.call(a.name, a.select, **params)
        print(json.dumps(out, indent=2, default=str) if out is not None else "")
        if a.pack == "hex":
            m.call("hex-pack", dst=a.out)
        else:
            m.save(a.out, force=a.force)
        print(m.plan())
        print(f"written {a.out}")
        return 0
    return 2


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="blackhole", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    add_commands(sub)
    return dispatch(ap.parse_args(sys.argv[1:] if argv is None else argv))
