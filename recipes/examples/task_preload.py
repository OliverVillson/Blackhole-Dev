# Task-aware preloading for a dense model, a lab recipe for the GPU VM (runs on a CPU too, slowly).
#
# 1. task-prompts    a prompt set for your task (your file, a named set, or prompts the base
#                    model writes from a one-line description) plus general prompts to compare.
# 2. task-trace      which parts of the model the task uses: per layer, every FFN neuron's
#                    contribution, every attention head's output, the residual update.
# 3. task-predictor  a ridge regression that predicts each prompt's busiest FFN blocks from its
#                    hidden state a quarter of the way in, so a runtime could preload them.
# 4. task-preload    the static plan: the task's busiest `budget` share of neurons and heads stay
#                    at hot_format, the rest goes to cold_format; neurons are reordered hot-first
#                    and the model is written with blackhole-preload.json (the preload map).
# 5. task-eval       the plan against the same budget chosen from general prompts, at random,
#                    per prompt by the predictor, and by an oracle: KL to the base model, top-1
#                    agreement and answer NLL on held-out task prompts and on general prompts,
#                    plus size, speed and memory.
#
# Each step is a built-in function, so you can fork any of them; the shared code is
# blackhole_dev/functions_src/_taskmap.py. Quantization here is round-to-nearest, which is fine
# for choosing a plan; GPTQ the cold part before you ship the model.
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/task-preload",
    "0.1.0",
    title="Task-aware tracing and preloading (dense)",
    description=("Traces which FFN neurons and attention heads a task uses, learns to predict them per prompt, "
                 "keeps the task's busiest parts at high precision (or resident) and compresses the rest, then "
                 "measures the task and general quality, size and speed against the base model."),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["dense", "task", "preload", "mixed-precision", "lab"],
    base="Qwen/Qwen3-8B",
    targets={"architectures": ["dense"]},
    meta={"stage": "lab"},
)

task = recipe.input("task", "text", default="",
                    help="Task prompts: a .jsonl/.txt path or a named set (chat, code, math, contest); "
                         "empty = the base model writes them from describe")
describe = recipe.input("describe", "text", default="Python debugging: find and fix the bug in a short function",
                        help="One-line task description, used when task is empty")
general = recipe.input("general", "text", default="mix", help="Contrast prompts: a named set or a file")
n_prompts = recipe.input("n_prompts", "int", default=256, min=8, max=4096, help="Task prompts in total")
budget = recipe.input("budget", "float", default=0.5, min=0.05, max=0.95,
                      help="Share of FFN neurons and heads kept hot in every layer")
hot_format = recipe.input("hot_format", "text", default="bf16", help="Format of the hot part (bf16, int8, int4, ...)")
cold_format = recipe.input("cold_format", "text", default="int3",
                           help="Format of the rest (int2..int8[_gG], fp8, hex3, hex4, or off to leave it out)")
allocate = recipe.input("allocate", "text", default="even", help="even, or importance (busier layers get more)")
block_size = recipe.input("block_size", "int", default=64, min=8, max=1024, help="Neurons per preload block")

recipe.fn("task-prompts", task=task, describe=describe, general=general, n=n_prompts, id="prompts")
recipe.fn("task-trace", id="trace")
recipe.fn("task-predictor", block_size=block_size, budget=budget, id="predictor")
recipe.fn("task-preload", budget=budget, hot_format=hot_format, cold_format=cold_format, allocate=allocate,
          block_size=block_size, id="preload")
recipe.fn("task-eval", id="eval", gates=[gate("task_gain_vs_random", ">=", 1.0)])
