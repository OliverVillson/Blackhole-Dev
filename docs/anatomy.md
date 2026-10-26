# BlackHole dev training harness: `blackhole_dev`

`blackhole_dev` (the BlackHole dev training harness) opens any Hugging Face checkpoint, local or on the Hub, and gives you its
parts as objects: layers, attention blocks and heads, linear-attention mixers, dense MLPs and
their neurons, MoE blocks with routers, experts and shared experts, embeddings, the LM head,
and every tensor and weight inside them. You inspect, select, measure and edit those parts,
see what the result would cost before anything is written, and save a checkpoint with a
receipt. Everything works the same on dense and MoE models.

Nothing is loaded when you open a model: the safetensors headers are read (a few KB per
shard), weights come off the disk, or over HTTP range requests from the Hub, only when you
touch them. Edits are recorded, not executed, until `save()`, which copies untouched tensors
and kept expert rows byte for byte (fp8 / MXFP4 blocks survive) and computes only what changed.

```python
import blackhole_dev as anatomy

m = anatomy.open("Qwen/Qwen3-30B-A3B")           # a Hub id (headers only) or a folder
print(m.summary())
```

```
Qwen/Qwen3-30B-A3B  qwen3_moe  moe  30.5B params, 128 experts top-8
  embed        311,164,928  model.embed_tokens.weight BF16[151936, 2048]
  head         311,164,928  lm_head.weight BF16[151936, 2048]
  norm               2,048  model.norm.weight BF16[2048]
  layers.0   full_attention    623,837,184  attn k_norm/k/o/q_norm/q/v 32h/4kv x128, moe 128e
  ... 47 more like it
```

## Parts and queries

| Part | How to get it | Children / verbs |
|---|---|---|
| `Model` | `anatomy.open(...)` | `layers`, `mtp`, `embed`, `head`, `norm`, `tensor(name)`, `select(q)` / `m[q]` |
| `Layer` | `m.layers[i]` | `attn`, `mixer`, `mlp`, `moe`, `norms`; `drop()`, `duplicate()`, `replace_with(other_layer)` |
| `Attention` | `layer.attn` | `q k v o` views (`roles`), `heads` |
| `Head` | `attn.heads[h]` | one head's rows of q, k, v and columns of o |
| `Mixer` | `layer.mixer` | linear attention / DeltaNet / Mamba tensors |
| `MLP` | `layer.mlp`, `moe.shared` | `gate up down`, `neurons`, `neuron_scores()`, `prune_neurons()` |
| `MoE` | `layer.moe` | `router`, `experts`, `shared`; `keep() drop() reorder() merge() duplicate()` |
| `Router` | `moe.router` | `weight`, `logits(x)`, `scale()`, `temperature()`, `bias()`, `set_row()` |
| `Expert` | `moe.experts[j]` | `roles` (gate/up/down views), `score freq rank` after scores; `drop()`, `duplicate()` |
| `Embedding`, `LMHead`, `Norm` | `m.embed`, `m.head`, `m.norm` | `head.trim(ids)` |
| `View` | `part.views`, `expert.roles["down"]`, `m.tensor(name)` | one tensor or a slice of one |

Queries select parts by path, with filters on their attributes:

```python
m["layers[0:4].attn"]                   # attention of the first four layers
m["layers[kind==mixer]"]                # every linear-attention layer (Qwen3-Next, Qwen3.6)
m["experts[rank<0.25]"]                 # bottom quarter of every layer's experts by REAP score
m["experts[score<0.01 & layer>=10]"]
m["layers[3].attn.heads[0,5,7]"]
m["moe.router"]; m["moe.shared"]; m["embed"]; m["head"]
```

A `Selection` is a list of parts with the same verbs (`stats()`, `measure()`, `apply()`,
`quant()`, `freeze()`, `train()`, `drop()`, `merge()`) and a `table()` for printing.

## Weights

A `View` is one tensor, or one expert's slice of a fused `[E, ...]` tensor, or one head's rows.
Reading goes through a memory map, so one weight of a 2 GB tensor reads one page.

```python
v = m.layers[12].moe.experts[5].roles["down"]
v[3, 17]                     # one weight
v[0, :8]                     # a row slice (float32 numpy)
v.numpy()                    # the whole matrix
v.stats()                    # count, mean, std, rms, absmax, kurtosis, crest factor, zero fraction
v.measure("hex3")            # round-to-nearest error of a format on these weights
v.norms(axis=0)              # column norms

v[3, 17] = 0.0               # writes are edits: nothing on disk changes until save()
v[0] = 0.0
v.apply(lambda w: np.clip(w, -0.1, 0.1))
v.scale(0.9)
```

Repeated writes to one tensor share one overlay, so a loop setting single weights costs one
decode and one encode at save time. Writes are stored back in the tensor's own dtype (bf16,
f16, f32); fp8 tensors carry separate block scales and must be dequantized first.

## Structural edits

```python
# experts (every MoE layer must end with the same count: Hugging Face configs hold one number)
m.load_scores("job/work/saliency.json")        # REAPer / score.reap output -> score, freq, rank
m["experts[rank<0.25]"].drop()                 # REAP 25%
m.layers[7].moe.merge([3, 9], weights="freq")  # weighted average, keeps the heavier router row
m.layers[7].moe.duplicate(2)                   # append a copy (same router row until trained apart)
m.layers[7].moe.reorder("score")               # hottest first: contiguous tiers for tiered kernels
m.call("merge-similar-experts", pairs=1)       # the most similar pair per layer, by weight cosine

# layers
m.drop_layers([31])
m.duplicate_layer(12)                          # depth up-scaling, heal afterwards
m.splice_layer(12, other_model, 12)            # take a layer from another checkpoint (same hidden size)
m.move_layer(5, 9)

# dense MLPs and shared experts
m.layers[3].mlp.prune_neurons(ratio=0.125)     # lowest ||gate|| * ||up|| * ||down col|| first
m["layers[*].moe.shared"].each(lambda p: p.prune_neurons(ratio=0.25))

# routers
m.layers[7].moe.router.temperature(1.2)
m.layers[7].moe.router.scale([3, 9], 0.8)

# vocabulary
m.head.trim(token_ids)                         # output-only trim: fewer head rows, every token still readable
```

Expert and layer attributes (scores, your own annotations, origins in the base model) follow
the parts through every edit, so a query written against the base still means the same
experts after a prune. `m.problems()` lists what would make the result unloadable (uneven
expert counts, top-k above the count, a config rule that no longer matches the layers);
`save()` refuses those unless `force=True`.

## Formats, size and fit

```python
m["experts"].quant("hex3")                     # storage format per part: bf16 fp8 intN[_gG] mlxN[_gG]
m["layers[*].attn"].quant("int4")              #   mxfp4 nvfp4 q2_k..q8_0 hex3 hex4[/bB]
m.reaq(avg_bits=3.5)                           # REAQ: hex4 for the best experts by score, hex3 for the rest
print(m.plan(device="M-series-16GB", context=16384))
```

```
part            params        GB
attention   1,208,221,696    0.604
embed         311,164,928    0.622
experts    27,917,287,424   11.342
...
total      30,532,122,624   13.173   (was 61.064 GB)
active per token 1.9 GB, KV cache 0.75 GB at 16384 tokens
does NOT fit M-series-16GB: 13.92 of 12.00 GB usable
decode roughly 42 tok/s (memory-bound estimate)
```

The plan is a prediction from bits per weight; `measure()` probes a format's round-to-nearest
error on real weights so you can compare parts and formats before a quantizer runs.

## REAP, REAQ and HEX

The project's own techniques are rebuilt on this API as named functions, so a developer can
run them a step at a time, swap any step, and get the same packed output the kernels read.

```python
m = anatomy.open(path)
live = m.live()                                # the model in torch (CPU here; device="cuda" on a VM)
live.reap_scores(texts)                        # REAP saliency onto the experts (score / freq / rank)
m.call("reap-prune", ratio=0.25)               # REAP: same count dropped in every layer, never below top-k
m.call("reaq", avg_bits=3.5)                   # REAQ: table size per expert from its score
m.call("hex-quantize", calib=texts)            # HEX tables + fp8 block scales, GPTQ-rounded on the Hessians
m.save(out)                                    # loads with stock transformers / vLLM: weights are on-table
m.call("hex-pack", dst=out_packed)             # packed idx / block_scale / expert_scale / levels per tier
```

`hex-quantize` without `calib` rounds to the nearest table level; with texts it collects per-expert
input Hessians through forward hooks (fused and ModuleList experts) and rounds with GPTQ onto the
tables. `blackhole.anatomy.hex` holds the maths (`quantize`, `gptq_table`, `pack`/`unpack`) in
numpy, with a torch path for wide matrices and GPUs.

## Named functions: package a weight manipulation, call it from a schema

```python
from blackhole_dev import function
import numpy as np

@function("clip-outliers")                                     # any name you like
def clip(w: np.ndarray, sigma: float = 6.0, select: str = "layers[*].attn") -> np.ndarray:
    """Clip weights beyond sigma standard deviations."""
    s = float(w.std())
    return np.clip(w, -sigma * s, sigma * s)

@function("tame-hot-experts", per="part")
def tame(expert, factor: float = 0.9):
    expert.roles["down"].scale(factor)

@function("my-recipe", per="model")
def recipe(m, ratio: float = 0.25) -> dict:
    m.call("reap-prune", ratio=ratio)
    m.reaq(avg_bits=3.5)
    return {"experts_left": m.layers[0].moe.num_experts}       # metrics go to the receipt and gates
```

A function is per `tensor` (gets a float32 array, returns one of the same shape), per `part`
(gets each matched part) or per `model`. Params are its keyword arguments with defaults and
type hints; `select` is the query it works on. `blackhole fn list` shows every function with
its params, `blackhole fn run MODEL NAME --set k=v -o OUT` runs one from the shell.

A schema calls functions through the `model.edit` op, one function per stage or several in
`steps`; `functions` names the .py files or modules that define your own, pinned by sha256 in
the receipt. `schemas/anatomy/reapq-hex.toml` is the whole REAP/Q-HEX recipe written this way:

```toml
[[stage]]
id = "hex"
kind = "model.edit"
functions = ["my_functions.py"]
steps = [
  { fn = "reap-score", calib = "${inputs.calib}" },
  { fn = "reap-prune", ratio = "${inputs.prune}" },
  { fn = "reaq", avg_bits = "${inputs.avg_bits}" },
  { fn = "hex-quantize", calib = "${inputs.calib}" },
  { fn = "clip-outliers", select = "layers[*].attn", sigma = 5 },
]
  [[stage.gates]]
  metric = "hex-quantize.rel_mse"
  op = "<="
  value = 0.2
```

## Built-ins are readable, forkable source

Every built-in is one file in `blackhole_dev/functions_src/` (shared helpers in `_helpers.py`
and `_teacher.py`), and every preset recipe is built only from them, so nothing a preset does is
out of reach. Model-level built-ins: `reap-score reap-prune drop-experts merge-similar-experts
reorder-by-score drop-layers duplicate-layers prune-neurons trim-head quant reaq hex-quantize
hex-pack freeze train router-temperature clip-outliers zero-small scale add-noise fake-quant`.

**The override rule.** Each definition sits in a layer, and for a name the highest layer wins
everywhere (recipes, `model.edit`, the CLI, the app):

| layer | where |
|---|---|
| 0 builtin | `blackhole_dev/functions_src/*.py` |
| 1 package | installed packages' `blackhole.functions` entry points |
| 2 user | `$BLACKHOLE_DEV_FUNCTIONS` (os.pathsep-separated), else `~/.blackhole-dev/functions` |
| 3 workspace | `<project>/functions/*.py` of the project open in the app |
| 4 recipe | the recipe file itself, files it names, a bundle's `functions/`, code run directly |

So a user function named like a built-in replaces it; two definitions of one name in the same
layer are an error (reported by `functions.problems()`, the registry keeps working).

**Fork.** `blackhole fn fork reaq` (or Fork in the app) copies the file of the definition that
currently wins into your functions folder. Kept under the same name it replaces the original;
`--as my-reaq` makes a separate function next to it. The copy's first line records what it was
forked from and that file's sha256, so the app can tell you when the original changed. Forking
every built-in a recipe uses, unchanged, gives byte-identical output (tested), and the receipt
pins which code ran.

```python
from blackhole_dev import functions as fns
fns.rows()                      # every function: per, params, layer, path, sha256, overrides, forked_from
fns.source("hex-quantize")      # {path, text, sha256, readonly, ...}
fns.fork("reaq")                # -> ~/.blackhole-dev/functions/reaq.py, now the one that runs
fns.fork("reap-prune", new_name="my-prune")
fns.refresh()                   # re-read the user and workspace folders after a save
```

## Job functions: the pipeline's GPU stages, forkable too

`per="job"` functions run a stage of the GPU pipeline on a `blackhole_dev.jobctx.Job` (the job
folder on the VM). A recipe step `recipe.fn("distil", ...)` compiles to a `job.fn` stage, which
the pipeline runs as `python -m blackhole_dev.jobctx --job <job> --stage <id>`; a fork in the
recipe bundle or your functions folder replaces the built-in stage.

| function | what | pipeline stage(s) |
|---|---|---|
| `calibrate` | detect, plan, download, teacher-written calibration + held-out set (reuses an earlier job's) | detect plan weights calibrate |
| `reap-gpu` | REAP scores, prune `ratio`, KL / top-1 vs the teacher | score prune eval |
| `traces` | verified shortest-trace data: teacher solves problems `samples` times, tests run, shortest pass kept (ported in full) | (heal's data) |
| `distil` | distillation heal from the teacher, or from your own `data` rows; on-policy rounds, layer / router matching | heal |
| `gptq` | GPTQ int4 W4A16 on the routed experts | gptq |
| `reaq-codebook` | REAQ per-expert 16 / 8-level tables, measured | reaq |
| `mlx-export` | MLX folder: GPTQ or HEX experts, REAQ tiers, attention / head bits | mlx |
| `qheal` | heal after quantization around the frozen low-bit experts | qheal |
| `bench` | LiveCodeBench pass@1 + thinking budgets of any models (ported in full) | bench |
| `fp8-experts` | REAPer's fp8-expert folder | quant |
| `package` | model cards, receipt, RESULTS.md | package |

```python
@function("distil-twice", per="job")
def distil_twice(job, minutes: int = 60) -> dict:
    job.call("traces", samples=4, think_budget=8192)       # a fork of traces runs if you have one
    first = job.call("distil", minutes=minutes, keep_weights="last")
    job.emit(pct=50, msg=f"round 1 KL {first['kl_after']:.3f}")
    return job.run_stage("heal", fresh=True, heal_lr=1e-6)  # any pipeline knob, any stage
```

`job.params` holds every pipeline knob, `job.set(**knobs)` changes them for the later stages
(as a schema step's params always did), `job.run_stage(name, **knobs)` runs one of the
pipeline's own stage processes with its events relayed as your stage, and `job.call(name)` runs
another job function. Every knob of `blackhole_pipeline.DEFAULTS` is a parameter of one of the
built-ins (tested); None leaves a knob as the pipeline has it. A stage exits 0 when done, 1 on
an error, 3 when one of its gates failed.

## The live model: training subsets, scores, KL

```python
live = m.live(device="cuda")
live.train_only("layers[*].moe.router")       # requires_grad + gradient masks; one expert of a fused tensor is a row mask
live.train("layers[0].moe.experts[3]")
live.trainable_params()
live.reap_scores(texts)                        # REAP saliency onto m
live.neuron_scores(texts)                      # E|h| * ||down col|| per dense FFN channel (what the dense default prunes on)
live.kl(other_live_or_model, texts)            # KL and top-1 agreement: the number every recipe is judged by
live.to_anatomy()                              # after training: weights back into m as edits, then m.save()
```

`m.freeze()` / `m.train()` marks on parts are recorded in the receipt and applied by
`live.apply_manifest()`, so a schema can say which parts a heal stage trains.

## Receipts

`save()` writes `blackhole-anatomy.json` next to the weights: every edit in order, the
functions used with their code hashes, the format and trainable marks, the experts' REAP
scores, where every layer and expert came from in the base model, and sizes per part before
and after. Scores and HEX headers (`blackhole-hex.safetensors`, the packed tables and indices)
travel with the saved model, so a later stage can prune by score or `hex-pack` without
recomputing. `blackhole-lineage.json` gets one more step, as the pipeline's stages write it.

## CLI

```
blackhole inspect MODEL                                   the tree
blackhole inspect MODEL "layers[3].moe.experts" --scores saliency.json
blackhole inspect MODEL "experts[0:8]" --stats | --measure hex3,int4
blackhole inspect MODEL --plan --device M-series-16GB --quant "experts=hex3,layers[*].attn=int4"
blackhole inspect MODEL --tensors
blackhole fn list | show NAME | source NAME
blackhole fn fork NAME [--as NEW] [--to DIR]       copy a function into your functions folder
blackhole fn run MODEL reap-prune --scores saliency.json --set ratio=0.25 -o out/
blackhole fn run MODEL hex-quantize -o out/ --pack hex
```

## Limits worth knowing

- Expert counts, dense widths and shared-expert widths must be the same in every layer when
  you save for stock loaders (`force=True` writes anyway, for your own loaders).
- Writes to fp8 / MXFP4 tensors are refused; move them (prune, reorder, splice) freely.
- Transposed expert layouts (gpt-oss stores `[in, out]`) are quantized per tensor with blocks
  along the last axis; `hex-pack` writes them under their own role names.
- `live()` saves pending edits to a temporary folder before loading; on a big model that is a
  full copy, so batch your edits before the first `live()`.
