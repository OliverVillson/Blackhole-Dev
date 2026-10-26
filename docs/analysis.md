# Analysis and forks

Plots and stats over a model after it is built, as Python files you can read, fork and
write yourself; and model forks, so edits and experiments happen on a copy that remembers
its parent.

## In the app

The **Analysis** activity (bar-chart icon) lists:

- **Model**: the model folders in `~/BlackHole-Dev/models`, forks indented under their
  parent. Click one to analyse it (or type a folder or Hub id; with none chosen, the model
  open in Anatomy is used). Hover a row for **Fork** and, on a fork, **Diff** (compare with
  its parent).
- **Analyses**: the built-ins below and your own. Click one to open it in a tab: a form for
  its params, what it will read, **Run**, and the charts. Each chart has a **Table** view of
  its numbers; hovering reads values. **Source** opens the Python file; **Fork** copies a
  built-in into `~/BlackHole-Dev/analysis/`, where your copy replaces it.
- **Your scripts**: **New script** writes a starter file there and opens it; **Run the open
  file** runs whatever analysis file is in the editor (unsaved text included).

Palette commands: `Analysis: Open an analysis`, `Analysis: Compare the model with its
parent`, `Analysis: Run the open file as an analysis`, `Analysis: New analysis script`.

### Big reads ask first

Analyses read weights lazily, usually a sample of rows per matrix. A built-in says up front
how many bytes it will read; over your limit (Settings > Analysis, default 2 GB, or 256 MB
for a Hub model read in place, where every read is a download) the confirm gate asks before
it runs. A script that does not say runs under the limit as a read budget: the helper stops
it *before* the read that would pass the limit, and only then asks, and runs it again.
Linking a fork is free; a full-copy fork asks when it copies more than the limit.

## Built-in analyses (`blackhole_dev/analysis_src/`)

| name | what | reads |
|---|---|---|
| `overview` | params and GB per part and per layer, dtypes, fit and decode estimate for a device | headers only |
| `layer-stats` | one statistic (rms, std, absmax, kurtosis, crest, zero_frac, mean_abs) per layer, a line per part kind | sampled rows |
| `expert-stats` | every expert of a layer: REAP score, router share, RMS, kurtosis; score vs RMS | sampled rows |
| `reap-scores` | layer x expert heatmaps of REAP saliency and router usage; router row norms when no scores | routers at most |
| `weight-histogram` | the distribution of any query's weights, log scale, with tail stats | sampled rows |
| `quant-error` | SNR and relative error of storage formats on any query (round-to-nearest probe) | sampled rows |
| `job-results` | held-out KL per step, stage results, LiveCodeBench pass@1 from a job or pulled folder | files only |
| `compare` | two models (a fork and its parent by default): size per part, structure, config, how far each layer's weights moved | sampled rows of changed tensors |

## Writing one

```python
from blackhole_dev.analysis import analysis
from blackhole_dev.analysis.lib import cost, sampled_stats

@analysis("kurtosis-by-layer", title="Kurtosis by layer", needs="weights",
          cost=lambda m, sample=128: sum(cost(L.moe.experts, sample) for L in m.layers if L.moe))
def run(r, m, sample: int = 128):
    "Weight kurtosis of every layer's experts (heavy tails quantize badly)."
    ks = [sampled_stats(L.moe.experts, sample)["kurtosis"] for L in m.layers if L.moe]
    r.line("Kurtosis by layer", range(len(ks)), {"experts": ks}, xlabel="layer")
```

`m` is a `blackhole_dev` model (headers only, weights on demand: `m["experts[rank<0.25]"]`,
`L.moe.experts[3].roles["down"]`, `.stats()`, `.measure("hex3")`, ...). `r` collects what
the app draws: `r.tiles`, `r.line`, `r.bar`, `r.hist`, `r.heatmap`, `r.scatter`, `r.table`,
`r.text`, `r.figure(matplotlib_fig)` for anything else, and `r.progress(msg, fraction)`.
Params are the keyword arguments after `(r, m)`; the app draws a form from their defaults
and type hints. `needs` is `headers`, `weights` or `none`; `cost(m, **params)` returns bytes.

A file with no `@analysis` is a plain script: it runs top to bottom with `r`, `m`, `params`,
`open` (`blackhole_dev.open`) and `np` in scope.

From Python, without the app:

```python
from blackhole_dev import analysis
report = analysis.run("layer-stats", m, {"metric": "crest"}, budget=2e9)   # a dict of blocks
```

## Forks (`blackhole_dev.fork`)

```python
from blackhole_dev.fork import fork, lineage
f = fork("~/BlackHole-Dev/models/qwen3.6-blackhole", name="hot-x0.9")
m = blackhole_dev.open(f["path"]); m["experts[rank>0.9]"].apply(lambda w: w * 0.9); m.save(f["path"])
lineage(f["path"])      # [the fork, its parent, the parent's parent, ...]
```

A fork hard-links the weight files (symlinks across file systems), so it costs no disk or
time, and copies the small files. It writes `blackhole-fork.json` (parent path, when, and a
fingerprint of each weight file's header so a diff can tell if the parent changed later) and
adds a `fork` step to `blackhole-lineage.json`. `Model.save()` writes new files and swaps the
folder, so saving a fork never touches the parent's files; a tool that edits safetensors
files in place would, so use `mode="copy"` for that. `compare` on a fork defaults to its
parent, and tensors the fork still shares with it are known identical without reading them.
