# BlackHole-Dev

The BlackHole **dev training harness**: the developer API for manipulating a model's structure
and weights, and for packaging those manipulations as named functions that BlackHole schemas
call. It is the paid companion of the free
[BlackHole-Harness](https://github.com/OliverVillson/BlackHole-Harness) pipeline, which it
installs on top of (`pip install -e ../BlackHole-Harness -e .`).

```python
import blackhole_dev as anatomy

m = anatomy.open("Qwen/Qwen3-30B-A3B")          # headers only; weights read on demand
m["experts[rank<0.25]"].drop()                   # after m.load_scores(...) or live.reap_scores(...)
m.layers[12].moe.experts[5].roles["down"][3, 17] = 0.0
m.reaq(avg_bits=3.5); m.call("hex-quantize", calib=texts)
print(m.plan(device="M-series-16GB")); m.save("out/")
```

Guide: [docs/anatomy.md](docs/anatomy.md). The open format code (safetensors IO, the HEX
layout and quantizer, the format table) stays in the public package as
`blackhole.anatomy.{st,hex,formats}`, so the free pipeline and the Metal / Triton kernels read
the same HEX layout this package writes.

| Path | What |
|---|---|
| `blackhole_dev/` | model, parts, query, sources, layout (structure and lazy tensors); functions (the registry: layers, override rule, fork); live (torch); op (`model.edit`); jobctx (job functions as pipeline stages); cli (`blackhole inspect`, `blackhole fn`) |
| `blackhole_dev/functions_src/` | every built-in function as one readable, forkable file: REAP / REAQ / HEX and the other model edits, and the pipeline's GPU stages (calibrate, reap-gpu, traces, distil, qheal, gptq, mlx-export, bench, ...) |
| `blackhole_dev/analysis/`, `analysis_src/`, `fork.py` | plots and stats as named, forkable scripts the app draws (overview, layer and expert stats, REAP and router heatmaps, histograms, quant error, job results, compare) with a read budget; model forks with a lineage receipt. Guide: [docs/analysis.md](docs/analysis.md) |
| `recipes/` | the presets as Python recipes made only of named functions (see recipes/README.md) |
| `schemas/reapq-hex.toml` | the REAP/Q-HEX recipe written as `model.edit` stages |
| `tests/` | numpy half on hand-written checkpoints, torch half on tiny real models; test_functions (override rule, fork, every stage and knob reachable), test_jobfns (a recipe of job functions runs the pipeline on a tiny model) |

Licence: to be set (Elastic License 2.0 with a licence key) before release; all rights reserved until then.
