"""Compatibility: reap-score, hex-quantize and hex-pack now live in blackhole_dev.functions_src
(one file each, forkable); the HEX layout text and helpers in functions_src._helpers."""

from blackhole_dev.functions import load_builtins
from blackhole_dev.functions_src._helpers import LAYOUT, _block_for, _Const, _levels_for, _texts  # noqa: F401

load_builtins()
