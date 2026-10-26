"""Write the preset recipes (recipes/*.py) from the pipeline's TUI catalog presets, as plain
recipe files made only of named functions (blackhole_dev/functions_src).

    python scripts/make_presets.py              # every preset the installed pipeline can run
    python scripts/make_presets.py qwen-mac-qhex

Each pipeline knob a preset sets becomes a parameter of the function that runs the stage that
reads it (KNOBS), so a preset recipe runs exactly the job the preset runs, and a developer can
fork any of its functions. tests/test_presets.py checks that equivalence for every preset.
"""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# pipeline stage -> the job function that runs it
STAGE_FN = {"detect": "calibrate", "plan": "calibrate", "weights": "calibrate", "calibrate": "calibrate",
            "score": "reap-gpu", "prune": "reap-gpu", "reap": "reap-gpu", "eval": "reap-gpu", "heal": "distil",
            "gptq": "gptq", "reaq": "reaq-codebook", "mlx": "mlx-export", "qheal": "qheal", "bench": "bench",
            "quant": "fp8-experts", "package": "package"}
ORDER = ["calibrate", "reap-gpu", "distil", "gptq", "reaq-codebook", "mlx-export", "qheal", "bench", "fp8-experts",
         "package"]

# pipeline knob -> (function, parameter)
KNOBS = {"prune": ("reap-gpu", "ratio"), "calib": ("calibrate", "calib"), "purpose": ("calibrate", "purpose"),
         "calib_samples": ("calibrate", "samples"), "max_seq": ("calibrate", "max_seq"),
         "gptq_calib": ("gptq", "calib"), "layer_chunk": ("gptq", "layer_chunk"),
         "reaq_top": ("reaq-codebook", "top"), "reaq_block": ("reaq-codebook", "block"),
         "heal_select": ("distil", "keep_weights"), "qheal_minutes": ("qheal", "minutes"),
         "bench": ("bench", "release"), "bench_models": ("bench", "models"), "bench_limit": ("bench", "limit"),
         "bench_max_tokens": ("bench", "max_tokens"), "bench_budgets": ("bench", "budgets"),
         "bench_file": ("bench", "file")}


def knob_target(knob: str) -> tuple[str, str]:
    if knob in KNOBS:
        return KNOBS[knob]
    from blackhole_pipeline import DEFAULTS
    if knob.startswith("heal_") and knob in DEFAULTS:
        return "distil", knob[5:]
    if knob.startswith("mlx_") and knob in DEFAULTS:
        return "mlx-export", knob[4:]
    raise KeyError(f"no function takes the pipeline knob {knob!r}: add it to KNOBS")


def knob_value(knob: str, value):
    return value.split("-")[-1] if knob == "bench" and str(value).startswith("lcb") else value


def runnable(schema) -> str:
    """"" when the installed pipeline runs every stage and knob of the preset, else why not."""
    order = list(schema.stage_list) if schema.stage_list else schema.stages()
    missing = [s for s in order if s not in STAGE_FN] + [s.kind for s in schema.steps if s.kind not in STAGE_FN]
    if missing:
        return f"stages the pipeline does not have yet ({', '.join(dict.fromkeys(missing))})"
    try:
        plan(schema)
    except KeyError as e:
        return e.args[0]
    return ""


def plan(schema) -> list[tuple[str, dict, str]]:
    """[(function, params, comment)] in run order for a catalog preset."""
    order = list(schema.stage_list) if schema.stage_list else schema.stages()
    fns = [f for f in ORDER if f in {STAGE_FN[s] for s in order}]
    params: dict[str, dict] = {f: {} for f in fns}
    notes: dict[str, str] = {}
    for st in schema.steps:
        notes.setdefault(STAGE_FN[st.kind], st.what)
        for k, v in st.params.items():
            fn, p = knob_target(k)
            if fn not in params:     # a knob for a stage this preset does not run: set it on the job anyway
                params.setdefault(fn, {})
                fns.append(fn)
            params[fn][p] = knob_value(k, v)
    return [(f, params[f], notes.get(f, "")) for f in sorted(fns, key=ORDER.index)]


def _py(v) -> str:
    return json.dumps(v) if isinstance(v, (str, list, dict)) else repr(v)


def source(schema) -> str:
    desc = textwrap.wrap(schema.summary, 96)
    lines = [f"# {schema.name}: the BlackHole preset {schema.id!r} as a recipe of named functions.",
             "# Every step is a built-in function (blackhole_dev/functions_src): fork any of them to change",
             "# what that step does; a fork with the same name replaces the built-in in this recipe.",
             "# Written by scripts/make_presets.py from the pipeline's catalog; edit freely once copied.", "",
             "from blackhole_dev.recipe import Recipe", "", "",
             "recipe = Recipe(", f'    "blackhole/{schema.id}",', '    "1.0.0",', f"    title={_py(schema.name)},",
             "    description=("] + [f"        {_py(x + (' ' if i < len(desc) - 1 else ''))}"
                                     for i, x in enumerate(desc)] + [
             "    ),", '    author="BlackHole-Harness",', f"    tags={_py(list(schema.tags))},",
             f"    meta={_py({'quant': schema.quant, 'preset': schema.id})},", ")", ""]
    for fn, params, note in plan(schema):
        if note:
            lines.append(f"# {note}")
        args = [f"{k}={_py(v)}" for k, v in params.items()]
        one = f"recipe.fn({_py(fn)}" + "".join(f", {a}" for a in args) + ")"
        if len(one) <= 110:
            lines.append(one)
        else:
            lines.append(f'recipe.fn("{fn}",')
            lines += [f"          {a}," for a in args]
            lines[-1] = lines[-1][:-1] + ")"
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    from blackhole_tui.catalog import SCHEMAS
    out = ROOT / "recipes"
    out.mkdir(exist_ok=True)
    for sc in SCHEMAS:
        if argv and sc.id not in argv:
            continue
        why = runnable(sc)
        if why:
            print(f"skip {sc.id}: {why}")
            continue
        p = out / f"{sc.id.replace('-', '_')}.py"
        p.write_text(source(sc))
        print(f"wrote {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
