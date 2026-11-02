"""The copilot's system prompt (app/src/copilot/prompt.ts) teaches whole-run recipes by example:
every function it names must exist and every argument it shows must be one that function takes,
or the copilot writes recipes that fail lint."""
from __future__ import annotations

import ast
import re
from pathlib import Path

from blackhole_dev import functions as fns

PROMPT = Path(__file__).resolve().parents[1] / "app" / "src" / "copilot" / "prompt.ts"
JOB_ONLY = {"id", "gates", "when", "always", "select", "pack", "scores", "functions"}


def calls() -> list[tuple[str, dict]]:
    text = PROMPT.read_text().replace("\\`", "`")
    out = []
    for m in re.finditer(r'recipe\.fn\(("[a-z0-9-]+")((?:[^()]|\([^()]*\)|\[[^\]]*\])*)\)', text):
        args = {}
        for part in re.finditer(r"(\w+)=", m.group(2)):
            args[part.group(1)] = True
        out.append((ast.literal_eval(m.group(1)), args))
    return out


def test_prompt_functions_exist_with_their_arguments():
    found = calls()
    names = {n for n, _ in found}
    assert {"calibrate", "reap-gpu", "external-bench", "package", "harness-test", "hf-publish"} <= names
    reg = fns.registry()
    for name, args in found:
        assert name in reg, f"the copilot prompt calls {name!r}, which is not a function"
        known = set(reg[name].params)
        bad = set(args) - known - JOB_ONLY
        assert not bad, f"the copilot prompt passes {sorted(bad)} to {name!r}, which takes {sorted(known)}"
