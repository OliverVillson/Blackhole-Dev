# Preset recipes

The BlackHole presets as plain recipe files. Each step is a built-in named function
(`blackhole_dev/functions_src/`), so a developer can read every step and fork any of them; a fork
with the same name replaces the built-in in every recipe that calls it.

| file | preset |
|---|---|
| `qwen_mac_qhex.py` | REAP/Q-HEX Mac coder (Qwen3.6): the headline 9.8 GB build |
| `qwen_mac_qhex_short.py` | the same, trained to think shorter (budget-forced traces) |
| `mac_qhex.py` | REAP/Q-HEX Mac coder for Flint |
| `mac_16gb.py`, `mac_16gb_375.py` | Mac 16 GB coder: REAP, distil, MLX 3-bit, qheal |
| `reaq_codebook.py` | REAQ per-expert codebooks vs GPTQ int4 (lab) |
| `reap_classic.py` | REAPer's pipeline: REAP 50% + fp8 experts |
| `reapq_hex.py` | REAP/Q-HEX on the CPU from anatomy functions (`model.edit` stages) |

The pipeline presets are written by `scripts/make_presets.py` from the catalog of the pipeline
the GPU VM runs (`PYTHONPATH=<LobBot>/harness python scripts/make_presets.py` for the newest one).
`tests/test_presets.py` checks that each generated recipe sets the same knobs and runs the same
stages as its preset. Knobs only the newer pipeline has (`think_budget`, `keep_weights`) are
refused with a clear message on an older one.
