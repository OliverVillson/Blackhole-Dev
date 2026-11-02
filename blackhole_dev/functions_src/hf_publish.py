"""Built-in function `hf-publish`.

This file is the code the pipeline runs. Fork it (`blackhole fn fork hf-publish`, or Fork in the
app's Functions view) to get your own copy in your functions folder; a function there with the
same name replaces this one everywhere, a renamed fork sits next to it. The work itself is in
blackhole_dev/hfpub.py, which is also the command that does the upload."""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

from blackhole_dev import hfpub
from blackhole_dev.functions import function


@function("hf-publish", per="job")
def hf_publish(job, model: str = "final", repo: str = "", private: int = 1, upload: int = 0,
               license: str = "", base_model: str = "") -> dict:  # noqa: A002
    """Gets the finished model ready for the Hugging Face Hub and prints the commands that
    upload it. Put it after `package` (and after any test of the build). `model`: final (the
    receipt's model: MLX, else GPTQ int4, else healed / pruned), a model name of the job or a
    folder. The model folder is not changed: <job>/publish/<name>/ gets the weights hardlinked,
    a Hub model card (crediting BlackHole-Harness, base model, results, SWE-bench Pro score when
    external-bench ran it), a LICENSE (the base model's, else Apache-2.0), config.json without
    local paths and blackhole.json; then every shard, the index, the tokenizer and the MLX model
    files are checked. Writes <job>/publish/package.json and <job>/publish/COMMANDS.txt (the
    commands, also in the log). `repo` NAME/REPO (empty: <your Hub user>/<folder name> at upload
    time). upload = 1 also uploads, when this machine has a token (HF_TOKEN or a Hub login; the
    VM normally has neither, so leave it 0 and run the printed command)."""
    src = hfpub.job_target(job.root, model)
    base, bdir, results = hfpub.job_info(job.root)
    base_model = base_model or base
    name = hfpub.slug(src.name)
    token = hfpub.get_token() if upload else None
    if not repo:
        repo = f"{hfpub.whoami(token)}/{name}" if token else f"<your-hf-name>/{name}"
    pub = job.root / "publish"
    job.emit(pct=10, msg=f"hf-publish: preparing {src.name}")
    info = hfpub.prepare(src, pub / name, repo, base_model, license, bdir, results)
    target = f"--job {shlex.quote(str(job.root))}" + (f" --model {shlex.quote(model)}" if model not in ("", "final") else "")
    cmds = hfpub.commands(sys.executable, target, info, bool(private))
    (pub / "package.json").write_text(json.dumps({**info, "commands": cmds}, indent=2) + "\n")
    (pub / "COMMANDS.txt").write_text("\n".join(cmds) + "\n")
    for w in info["warnings"]:
        job.log(f"hf-publish warning: {w}")
    if info["errors"]:
        raise RuntimeError("the upload folder is not ready:\n" + "\n".join(f"- {e}" for e in info["errors"]))
    job.log("hf-publish: ready. To publish:\n" + "\n".join(cmds))
    uploaded = 0
    if upload:
        if not token:
            raise RuntimeError("upload = 1 but this machine has no Hugging Face token; run the commands in "
                               f"{pub / 'COMMANDS.txt'} instead")
        job.emit(pct=40, msg=f"hf-publish: uploading to {repo}")
        hfpub.upload(Path(info["folder"]), repo, token, private=bool(private))
        uploaded = 1
    job.emit(pct=100, msg=f"hf-publish: {info['size_gb']} GB ready in publish/{name}" + (" · uploaded" if uploaded else ""))
    return {"size_gb": info["size_gb"], "files": len(info["files"]), "uploaded": uploaded,
            "folder": info["folder"], "repo": repo}
