"""`model.edit`: the schema op that runs named functions from blackhole_dev.

Registered through the public package's `blackhole.ops` entry point (pyproject.toml), so the
free pipeline has no dependency on this package: install blackhole-dev and the op appears."""

from dataclasses import dataclass

from blackhole.core.ops import Op, p, register
@register
class Edit(Op):
    """Run named functions from blackhole_dev on the model so far and write the result
    as a new checkpoint with a receipt (blackhole-anatomy.json). One stage = one function
    (`fn` with its params flat on the stage) or several (`steps`, a list of {fn, ...} tables).
    Structural edits (REAP pruning, merges, layer splices) are byte copies; weight edits and
    HEX quantization compute on CPU unless the function loads the model (`device`). `scores`
    attaches REAP scores (a saliency artifact) before the functions run; `functions` names
    .py files or modules whose @function definitions the schema uses, pinned by sha256 in
    the receipt. Every function's returned metrics land in metrics.json (gates read them)."""
    name, major = "model.edit", 1
    consumes = {"model": "model", "scores": "file"}
    produces = {"model": "model", "receipt": "file"}
    ported_from = "blackhole-dev"

    @dataclass
    class Params:
        model: str = p("")
        fn: str = p("", "a named function, e.g. reap-prune, reaq, hex-quantize, or your own")
        select: str = p("", "which parts the function works on (a query), when it takes one")
        args: dict = p({}, "the function's params")
        steps: list = p([], "several functions in order: [{fn = \"reaq\", avg_bits = 3.5}, ...]")
        scores: str = p("", "REAP scores to attach first, e.g. ${score.saliency}")
        functions: list = p([], "modules or .py files (relative to the schema) defining extra functions")
        pack: str = p("", "\"hex\" writes the packed HEX layout instead of a plain checkpoint")
        force: bool = p(False, "save even if the result would not load with stock loaders")

    def run(self, ctx):
        import blackhole_dev as anatomy
        from blackhole_dev import functions as fns
        prm = ctx.params
        shas = {}
        for spec in prm.functions:
            shas[spec] = fns.load(spec, ctx.job.root)
        m = anatomy.open(prm.model)
        if prm.scores:
            m.load_scores(prm.scores)
        steps = list(prm.steps) or ([{"fn": prm.fn, **({"select": prm.select} if prm.select else {}), **prm.args}]
                                    if prm.fn else [])
        if not steps:
            raise ValueError("model.edit needs fn or steps")
        metrics = {}
        for i, step in enumerate(steps):
            step = dict(step)
            name = step.pop("fn")
            sel = step.pop("select", None)
            ctx.progress(100 * i / len(steps), f"{name}")
            out = m.call(name, sel, **step)
            if isinstance(out, dict):
                metrics.update({f"{name}.{k}": v for k, v in out.items() if isinstance(v, (int, float, str))})
        plan = m.plan()
        dst = ctx.out("model")
        if prm.pack == "hex":
            m.call("hex-pack", dst=str(dst))
        else:
            m.save(dst, force=prm.force)
        import shutil
        shutil.copy2(dst / "blackhole-anatomy.json", ctx.out("receipt"))
        ctx.metric(**metrics, size_gb=round(plan.total_gb, 4), params_b=round(plan.params_b, 4),
                   edits=len(m.log), problems=len(plan.problems))
        ctx.progress(100, f"{len(steps)} function(s), {plan.total_gb:.2f} GB")
