# Serve a packaged build on the GPU VM and try it out: the step after `package` in any recipe
# (add `recipe.fn("harness-test")` at the end), or on its own with "model" pointed at a folder.
#
# harness-test (built-in, forkable) finds the job's final build (a hex-vllm folder is served as it is), converts
# an MLX HEX export once to <folder>-vllm for vLLM's blackhole-hex kernel (BlackHole-Harness
# runtime), starts `vllm serve`, asks a few prompts and checks the answers, then measures decode
# tok/s, time to the first token, throughput at `concurrency`, and weights / KV-cache / GPU
# memory. The numbers land in the job monitor, every prompt and answer in work/harness-test.md.
# With keep_serving = 1 the server stays up on 127.0.0.1:8000 so you can chat with it: on the
# Mac `ssh -N -L 8000:127.0.0.1:8000 USER@VM`, then Chat settings > External server =
# http://127.0.0.1:8000/v1. Needs the BlackHole installer's vLLM venv on the VM.
from blackhole_dev.recipe import Recipe, gate

recipe = Recipe(
    "blackhole/harness-test",
    "1.0.0",
    title="Serve and test a packaged build on the VM",
    description=("vLLM on the GPU VM (HEX builds through the blackhole-hex kernel), smoke prompts with checked "
                 "answers, tok/s, memory; the server stays up to chat with."),
    author="BlackHole-Harness",
    license="Apache-2.0",
    tags=["serve", "test", "vllm", "hex", "lab"],
    base="Qwen/Qwen3-30B-A3B",
    meta={"stage": "bench"},
)

model = recipe.input("model", "text", default="final",
                     help="final (the job's last build: hex-vllm folder, HEX MLX, int4, ...), packaged, int4, "
                          "pruned, or a folder")
keep_serving = recipe.input("keep_serving", "int", default=1, min=0, max=1,
                            help="1 leaves the server up on port 8000 to chat with; 0 stops it")
min_ok = recipe.input("min_ok", "int", default=3, min=0, max=100,
                      help="Stop when fewer smoke prompts than this pass")

recipe.fn("harness-test", model=model, keep_serving=keep_serving, id="vm_test",
          gates=[gate("smoke_passed", ">=", min_ok)])
