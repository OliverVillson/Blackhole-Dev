# REAP/Q-HEX for NVIDIA: any MoE model in, a folder `vllm serve` runs out. A recipe for the GPU VM.
#
# Four built-in functions, each forkable:
#   calibrate   the teacher (the original model, in vLLM; on-the-fly fp8 when bf16 does not fit
#               the GPU) answers calibration prompts; REAP is scored on its own answers
#   reap-gpu    REAP drops the `prune` share of routed experts with the lowest router-weight x
#               output-norm score in every MoE layer, writes the pruned checkpoint, measures KL
#   hex-vllm    HEX (a BlackHole-Harness original): every expert matrix gets its own learned table
#               of 8 levels (3-bit indices, fp8 block scales, GPTQ rounding); REAQ (also ours)
#               gives the `hot` share of each layer's experts with the best REAP scores 16 levels.
#               Everything else is copied unchanged. Out: <job>/reaper/out/<pruned>-HEX-vLLM
#   package     model card (with the vllm serve command), receipt.json, RESULTS.md
#
# Works on any Hugging Face MoE that transformers and vLLM know (Qwen3.8-Flash-Next, Qwen3.5 /
# 3.6, Qwen3-MoE, ...). A dense model has no experts: reap-gpu stops with a message; use a dense
# recipe (int4, neuron pruning) instead. The HEX folder needs the BlackHole runtime next to vLLM
# (the VM installer puts it there); it serves on one GPU.
#
# Qwen3.8-Flash-Next (the default base, 180B, 360 GB of bf16): on one B300 the teacher serves
# on-the-fly fp8 and the n-gram embedding (~100 GB) stays in CPU RAM; needs ~900 GB free disk
# (download, pruned copy, HEX folder) and ~250 GB of RAM. Expect ~150 GB out (the n-gram table
# and other non-expert weights stay bf16), so it serves on one B300 but not on a PC.
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/reapq-hex-vllm",
    "1.0.0",
    title="REAP/Q-HEX for vLLM (any MoE)",
    description=("REAP-prune the routed experts on the teacher's own answers, then HEX-quantize them with REAQ "
                 "tiers by REAP score, into a folder vLLM serves on one NVIDIA GPU with the BlackHole runtime."),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["moe", "reap", "reaq", "hex", "vllm", "nvidia", "blackhole-original"],
    base="Qwen/Qwen3.8-Flash-Next",
    targets={"architectures": ["moe", "hybrid"]},
    meta={"stage": "compress"},
)

calib = recipe.input("calib", "text", default="code",
                     help="Calibration prompts the teacher answers: code, chat, math, mix, or a .jsonl/.txt path")
samples = recipe.input("samples", "int", default=256, min=32, max=2048,
                       help="Calibration sequences REAP is scored on")
prune = recipe.input("prune", "float", default=0.25, min=0.0, max=0.5,
                     help="Share of routed experts REAP removes in every MoE layer (25% measured best; never past 50%)")
bits = recipe.input("bits", "int", default=3, min=3, max=4,
                    help="HEX table size for most experts: 3 = 8 levels (3.25 bpw), 4 = 16 levels (4.25 bpw)")
hot = recipe.input("hot", "float", default=0.25, min=0.0, max=1.0,
                   help="REAQ: share of each layer's experts (best REAP scores) on 16-level tables")
max_kl = recipe.input("max_kl", "float", default=0.25, min=0.0, max=10.0,
                      help="Stop after REAP when its KL to the original is above this")

recipe.fn("calibrate", calib=calib, samples=samples)
recipe.fn("reap-gpu", ratio=prune, id="reap", gates=[gate("kl", "<=", max_kl)])
recipe.fn("hex-vllm", bits=bits, hot=hot, hot_bits=4, id="hex")
recipe.fn("package")
