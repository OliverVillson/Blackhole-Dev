"""Built-in function `mlx-export`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork mlx-export`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it."""

from __future__ import annotations

from blackhole_dev.functions import function


@function("mlx-export", per="job")
def mlx_export(job, bits: int = None, group: int = None, hex: int = None, hot: float = None,  # noqa: A002
               hot_bits: int = None, attn_bits: int = None, attn_gptq: int = None, qo_bits: int = None,
               head_vocab: int = None, embed_bits: int = None, head_bits: int = None,
               think_budget: int = None) -> dict:
    """An MLX folder for Apple silicon from the pruned (healed) model: routed experts GPTQ'd to
    `bits` (or, with hex = 1, HEX per-expert learned tables of 2**bits levels, fp8 block scales),
    the `hot` share of each layer's experts by REAP score on `hot_bits` (REAQ tiers),
    attention / shared experts / dense MLPs at `attn_bits` (q/o at `qo_bits`), embeddings and
    LM head at their own bits. head_vocab > 0 trims the output vocab (measured on Qwen3.6: KL
    0.070 -> 0.389 for 0.2 GB; leave it 0). think_budget caps thinking at run time (newer
    pipelines). None leaves a knob as the pipeline has it (bits 3, group 64, hex 0, hot 0,
    hot_bits 4, attn_bits 4, attn_gptq 1, embed_bits 4, head_bits 6)."""
    res = job.run_stage("mlx", mlx_bits=bits, mlx_group=group, mlx_hex=hex, mlx_hot=hot, mlx_hot_bits=hot_bits,
                        mlx_attn_bits=attn_bits, mlx_attn_gptq=attn_gptq, mlx_qo_bits=qo_bits,
                        mlx_head_vocab=head_vocab, mlx_embed_bits=embed_bits, mlx_head_bits=head_bits,
                        mlx_think_budget=think_budget)
    return {k: v for k, v in res.items() if isinstance(v, (int, float))}
