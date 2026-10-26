# Recipes, .bhr bundles and the app helper (I1 Python side, I2)

Owner: thread "Build the recipe format and Python helper". Code: `blackhole_dev/recipe/` and `blackhole_dev/rpc.py`
in OliverVillson/BlackHole-Dev; pipeline hook `--recipe` in public BlackHole-Harness `harness/blackhole_pipeline`.
I1 shapes: WS1's section in `ws1-shell.md` is ACCEPTED as the contract, with the additions marked "WS2:" there.

## I2a. A recipe is a Python file

```python
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/qwen-mac-qhex", "1.0.0",            # id author/name, semver
    title="REAP/Q-HEX Mac coder (Qwen3.6)",
    description="...", license="Apache-2.0", tags=["mac", "moe"],
    base="Qwen/Qwen3.6-35B-A3B",                   # default base model (the run can override)
    targets={"architectures": ["moe"]},
    meta={"target": "mac16", "quant": "mlx-3bit"},  # app/pipeline metadata, NOT part of the blackhole/v1 schema
)

prune = recipe.input("prune", "float", default=0.3125, min=0.0, max=0.5, help="Share of routed experts dropped")

reap = recipe.step("pipeline.reap", prune=prune, calib="code")          # real B300 pipeline stage
recipe.step("pipeline.heal", heal_calib="contest", heal_samples=3)
recipe.step("pipeline.mlx", mlx_hex=1, mlx_bits=3)
recipe.step("pipeline.qheal", qheal_minutes=45)
recipe.step("pipeline.bench")
recipe.step("pipeline.package")
```

Or with named functions (blackhole_dev anatomy, runs through the `model.edit` op):

```python
score = recipe.fn("reap-score", calib=recipe.inputs.calib)                # = step("model.edit", fn=..., args=...)
recipe.fn("reap-prune", ratio=prune, id="prune")
hexs = recipe.edit([{"fn": "reaq", "avg_bits": 3.5}, {"fn": "hex-quantize"}], id="hex",
                   gates=[gate("hex-quantize.rel_mse", "<=", 0.2)], pack="hex")
recipe.eval(gates=[gate("hex.hex-quantize.rel_mse", "<=", 0.2)])
```

Rules
- A file defines exactly one `Recipe` at module level (call it `recipe` by convention; otherwise the only Recipe instance found).
- `recipe.step(kind, id=None, needs=None, gates=None, when=True, always=False, **params)` returns a `Step`.
  `kind` is any op in the catalog (`ns.op` or `ns.op@2`) or a `pipeline.<stage>`.
- References are objects that print as `${...}`: `recipe.inputs.prune`, `step.<artifact>`, `step.metrics.<m>`,
  `recipe.base.model`, `recipe.base.<fact>`, `recipe.hw.<field>`. Use them as values or inside f-strings.
- `@function("name")` definitions may live in the recipe file itself or in `<workspace>/functions/*.py`; a
  same-named user function overrides the built-in (WS3 owns the registry rule).
- `recipe.to_raw()` is the exact blackhole/v1 dict (what TOML parsed to), `recipe.schema()` the parsed Schema.
  Lossless: TOML -> `recipe.fromToml` -> Python -> `to_raw()` gives the same dict (tested on every schema in the repo).
- Every Step remembers its source line, so lint/plan Problems point at the right editor line.

### pipeline.* steps (the real pipeline the B300 runs today)

`pipeline.reap` (detect, plan, weights, calibrate run before it, score + prune + eval after), `pipeline.heal`,
`pipeline.gptq`, `pipeline.reaq`, `pipeline.mlx`, `pipeline.qheal`, `pipeline.bench`, `pipeline.quant`,
`pipeline.package`. Params are the keys of `blackhole_pipeline.DEFAULTS` plus REAPer Config keys (calib, max_seq, ...).
Every TUI catalog preset (qwen-mac-qhex, mac-qhex, reaq-codebook, ...) converts to one of these losslessly
(same job config, same stage list).

### job functions (WS3's `per="job"` kind: forkable pipeline stages)

`recipe.fn("distil", **params)` where `distil` is a job-kind function compiles to a stage
`{kind = "job.fn", fn = "distil", <params flat>}`. In the pipeline runner it runs in recipe order as its own process:
`python -m <module> --job <job> --stage <id>`, where `<module>` comes from the entry point group
`blackhole.jobfn` (WS3 registers `blackhole_dev.jobctx`). That process loads the function (bundle files first, then
user folder, then built-ins), calls it, emits the usual JSON events with `stage` = the stage id, and on success
touches `<job>/reaper/.done/<id>`. This is how a forked stage (distil, qheal, bench, ...) replaces a `pipeline.*` step.

A recipe is either "pipeline" (any mix of `pipeline.*` and `job.fn` stages, run in recipe order) or "core" (catalog
ops such as `model.edit`, run by blackhole.core.runner). Mixing the two is v2.

## I2b. The .bhr bundle

A `.bhr` is a gzip tar:

```
manifest.json
recipe.py                 the source as written
recipe.json               compiled: {"raw": <blackhole/v1 dict>, "meta": {...}}  (the VM needs no blackhole_dev to read it)
functions/<file>.py       every user/forked function file the recipe calls (incl. recipe.py if it defines functions)
```

manifest.json:

```json
{
  "format": "bhr/1",
  "name": "qwen-mac-qhex",            // recipe slug (id after the /)
  "id": "blackhole/qwen-mac-qhex", "version": "1.0.0",
  "base_model": "Qwen/Qwen3.6-35B-A3B",
  "target": "mac16",
  "runner": "pipeline",               // "pipeline" (blackhole_pipeline stages) | "core" (blackhole.core.runner ops)
  "stages": ["detect", "plan", "weights", "calibrate", "score", "prune", "eval", "heal", "mlx", "qheal", "bench", "package"],
  "inputs": {"prune": 0.3125},        // resolved values baked in at bundle time
  "needs": {"gpu_gb": 80.0, "disk_gb": 200.0},   // null fields when unknown
  "blackhole_dev_version": "0.1.0",
  "files": {"recipe.py": "<sha256>", "recipe.json": "<sha256>", "functions/x.py": "<sha256>"},
  "functions": [{"name": "reap-prune", "origin": "builtin", "sha256": "<module sha>"},
                {"name": "my-prune", "origin": "user", "path": "functions/my_prune.py", "sha256": "..."}],
  "created_at": "2026-10-26T10:40:00Z"
}
```

`recipe.bundle` returns `{bundle: <abs path of .bhr>, sha256: <of the .bhr>, functions, manifest}`.

## I2c. Running a bundle on the VM (public hook)

```
python -m blackhole_pipeline --job <job> --recipe <job>/recipe.bhr [--model M] [--input k=v ...] [--from STAGE]
```

- Verifies every sha256 in the manifest, extracts to `<job>/recipe/`, and when `<job>/config.json` is missing
  writes it from the bundle: `{model, schema: <id>, recipe: <bundle sha>, target, purpose, steps, stage_list, inputs}`.
  So the TUI, `--from STAGE` resume and `blackhole` keep working unchanged; reruns reuse the existing config.
- runner "pipeline": the existing stage processes run; `stage_list` decides which (no catalog lookup needed).
  runner "core": hands off to `blackhole.core.runner` (ops; `model.edit` comes from blackhole_dev via the
  `blackhole.ops` entry point). The open pipeline never imports blackhole_dev.
- Events keep today's JSON-lines shape `{stage, status, pct, msg, ts, ...}`; `stage` is the stage id.
- blackhole_dev on the VM: a wheel built with `python -m build` from the repo root is fine;
  `blackhole_dev.__version__` exists and matches `manifest.blackhole_dev_version`.
