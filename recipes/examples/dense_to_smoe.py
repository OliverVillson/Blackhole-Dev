# Dense -> split-SMoE conversion (no REAP), a lab recipe for the GPU VM.
#
# Splits every dense SwiGLU FFN into N routed experts (plus an always-on shared expert on
# Qwen2-MoE targets) by co-activation, fits a linear router in closed form, keeps the layers it
# cannot route well dense, and writes a standard Hugging Face MoE checkpoint as the job's model:
# Qwen3 dense -> Qwen3-MoE, Qwen2/2.5 dense -> Qwen2-MoE. Each step is a built-in function
# (smoe-profile, smoe-partition, smoe-router, smoe-build, smoe-verify), so you can fork any of
# them; the shared code is blackhole_dev/functions_src/_smoe.py.
#
# What to expect: the same total size as the dense model, fewer weights read per token. A
# one-shot split of a SiLU FFN is lossy: on Qwen3-8B (2026-10-23) 64 experts at top-32 cost
# KL 0.53, 0.39 even with a perfect router. So this is the conversion step of "train it to
# route" (lab/dense-moefy-anneal): with topk = experts the checkpoint is exactly the dense model,
# and a heal that distils from the original while k steps down comes after it.
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/dense-to-smoe",
    "1.1.0",
    title="Dense -> split-SMoE conversion (no REAP)",
    description=("Splits each dense SwiGLU FFN into N routed experts by co-activation partitioning, fits a "
                 "linear router in closed form, keeps unreadable layers dense, and writes a standard HF MoE "
                 "checkpoint."),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["dense", "moe", "conversion", "lab"],
    base="Qwen/Qwen3-8B",
    targets={"architectures": ["dense"]},
    meta={"stage": "convert"},
)

experts = recipe.input("experts", "int", default=64, min=4, max=256,
                       help="Routed experts per layer (N); Qwen3 needs N to split the FFN into widths divisible by 8")
topk = recipe.input("topk", "int", default=4, min=1, max=256,
                    help="Experts active per token (k); set it to experts for an exact conversion to heal from")
shared_frac = recipe.input("shared_frac", "float", default=0.03, min=0.0, max=0.2,
                           help="Share of neurons in the always-on shared expert (Qwen2-MoE targets only)")
calib = recipe.input("calib", "text", default="",
                     help="Calibration text: empty = the job's calibration set; chat, code, math, contest, mix, "
                          "or a .txt/.jsonl path")
n_tokens = recipe.input("n_tokens", "int", default=100000, min=4096, max=2000000,
                        help="Calibration tokens per pass")
min_r2 = recipe.input("min_r2", "float", default=0.6, min=0.0, max=1.0,
                      help="Layers whose router R^2 is below this stay dense")
max_drop = recipe.input("max_drop", "float", default=0.15, min=0.0, max=1.0,
                        help="Layers dropping more than this share of routed FFN energy at top-k stay dense")
gate_eps = recipe.input("gate_eps", "float", default=0.001, min=0.0001, max=0.2,
                        help="Allowed deviation of the selected experts' weights from 1")

recipe.fn("calibrate")
recipe.fn("smoe-profile", calib=calib, n_tokens=n_tokens, experts=experts, id="profile")
recipe.fn("smoe-partition", experts=experts, shared_frac=shared_frac, id="partition")
recipe.fn("smoe-router", calib=calib, n_tokens=n_tokens, topk=topk, id="router")
recipe.fn("smoe-build", topk=topk, min_r2=min_r2, max_drop=max_drop, gate_eps=gate_eps, id="build",
          gates=[gate("converted_layers_frac", ">=", 0.5)])
recipe.fn("smoe-verify", calib=calib, id="verify",
          gates=[gate("equiv_rel_err", "<=", 0.05)])
