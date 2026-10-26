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
| `blackhole_dev/` | model, parts, query, sources, layout (structure and lazy tensors); functions, builtin_functions, hexops (named functions incl. REAP / REAQ / HEX); live (torch); op (`model.edit`); cli (`blackhole inspect`, `blackhole fn`) |
| `schemas/reapq-hex.toml` | the REAP/Q-HEX recipe written as `model.edit` stages |
| `tests/` | 20 tests: numpy half on hand-written checkpoints, torch half on tiny real models |

Licence: to be set (Elastic License 2.0 with a licence key) before release; all rights reserved until then.
