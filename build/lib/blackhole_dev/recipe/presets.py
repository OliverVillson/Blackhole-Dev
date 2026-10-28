"""The preset recipes as files: recipes/*.py next to the package (an editable install, which is
how the app runs it) and recipes/examples/*.py (recipes written from scratch). The app lists
them in "Start from a preset" and copies the one picked into the user's recipes folder."""

from __future__ import annotations

import ast
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "recipes"


def _meta(path: Path) -> dict:
    """id, title and description from the Recipe(...) call, read without running the file."""
    out: dict = {}
    try:
        tree = ast.parse(path.read_text())
    except (OSError, SyntaxError):
        return out
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Recipe":
            if node.args and isinstance(node.args[0], ast.Constant):
                out["recipe"] = node.args[0].value
            for kw in node.keywords:
                if kw.arg in ("title", "description", "base"):
                    try:
                        out[kw.arg] = ast.literal_eval(kw.value)
                    except ValueError:
                        pass
            break
    if "description" not in out:
        lines = [x[1:].strip() for x in path.read_text().splitlines()[:6] if x.startswith("#")]
        if lines:
            out["description"] = " ".join(lines)
    return out


def files(root: Path | None = None) -> list[dict]:
    """[{id, file, group, title, description, base}] for every preset recipe file."""
    root = root or ROOT
    rows = []
    for group, d in (("preset", root), ("from scratch", root / "examples")):
        for f in sorted(d.glob("*.py")) if d.is_dir() else []:
            if f.name.startswith("_"):
                continue
            m = _meta(f)
            rows.append({"id": f.stem.replace("_", "-"), "file": str(f), "group": group,
                         "title": m.get("title") or f.stem, "description": m.get("description", ""),
                         "base": m.get("base")})
    return rows


def copy(src: str | Path, dst: Path) -> str:
    """Copy a preset file to `dst` (the caller picks a free name); returns its text."""
    src = Path(src)
    if src.resolve().parent not in (ROOT.resolve(), (ROOT / "examples").resolve()):
        raise ValueError(f"{src} is not a preset recipe")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return dst.read_text()
