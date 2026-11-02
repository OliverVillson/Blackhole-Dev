"""Built-in function `hex-vllm`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork hex-vllm`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("hex-vllm", per="job")
def hex_vllm(job, bits: int = None, hot: float = None, hot_bits: int = None, calib: int = None,
             layer_chunk: int = None, reserve_gb: float = None) -> dict:
    """REAP/Q-HEX for NVIDIA: the REAP-pruned (healed, when distil ran) model with HEX routed
    experts, written as a folder `vllm serve` runs on one GPU with the BlackHole runtime (the
    HEX Triton kernel as vLLM's "blackhole-hex" quantization). Every expert matrix gets its own
    learned table of 2**bits levels (fp8 block scales over 32 inputs, GPTQ rounding with the
    expert's own Hessian); REAQ puts the `hot` share of each layer's experts with the highest REAP
    scores on 2**hot_bits levels. Attention, routers, shared experts, embeddings, vision tower
    and MTP head are copied from the pruned checkpoint unchanged, so any MoE that vLLM has a
    model for works (Qwen3.5 / 3.6, Qwen3.8-Flash-Next, Qwen3-MoE, ...); it is measured against
    the teacher (KL / top-1). `calib` = calibration sequences for the Hessians, `layer_chunk` =
    MoE layers per pass (fewer when the Hessians would not fit), `reserve_gb` = GPU memory kept
    free of weights for them. None leaves a knob as the pipeline has it (bits 3, hot 0.25,
    hot_bits 4, calib 64, layer_chunk 12, reserve_gb 48). Run reap-gpu first. The folder is
    <job>/reaper/out/<pruned>-HEX-vLLM (also linked in <job>/out/); `model="hex"` names it in
    speed-bench and external-bench."""
    from blackhole_pipeline import PROCESSES
    if not any(p[0] == "hexvllm" for p in PROCESSES):
        raise RuntimeError("this machine's BlackHole-Harness has no hexvllm stage yet: update it (on the VM: "
                           "curl -fsSL https://blackholeharness.dev/install.sh | bash) and run again")
    if not (job.pruned_dir / "config.json").exists():
        raise RuntimeError("hex-vllm needs the REAP-pruned model: run reap-gpu first")
    res = job.run_stage("hexvllm", hex_bits=bits, hex_hot=hot, hex_hot_bits=hot_bits, gptq_calib=calib,
                        layer_chunk=layer_chunk, hex_reserve_gb=reserve_gb)
    out = {k: v for k, v in res.items() if isinstance(v, (int, float))}
    if res.get("out"):
        out["out"] = res["out"]
        # where external-bench / hf-publish (model="final") look for the servable folder
        job.write("work/hex-vllm.json", {"out": str(res["out"]), **out})
    return out
