"""Get a finished model folder ready for the Hugging Face Hub, check it, and upload it.

    python -m blackhole_dev.hfpub --job JOB              prepare + check, print what would go up (no upload)
    python -m blackhole_dev.hfpub FOLDER                 the same for any model folder
    ... --upload                                         create the repo (private) and upload
    ... --public                                         make the repo public (after you looked at it)
    ... --repo NAME/REPO                                 default: <your HF user>/<build folder name>
    ... --token-stdin                                    read the token from stdin (else HF_TOKEN, else `hf auth login`)

Nothing leaves the machine without --upload or --public. The model folder itself is never
changed: the upload folder is <job>/publish/<repo name>/ (or FOLDER.hf/), with the weights
hardlinked (no copy), a model card with Hub metadata, a LICENSE, config.json without local
paths, and blackhole.json with what the pipeline measured. Checks before anything goes up:
config.json, every safetensors shard readable and every index entry in its shard, a tokenizer,
the MLX model files a BlackHole MLX folder loads (qwen_mlx.py / flint_mlx.py), no file over the
Hub's 50 GB limit, no local paths or personal names in the card.

The built-in job function `hf-publish` runs the same code as a recipe step and writes
<job>/publish/package.json and <job>/publish/COMMANDS.txt.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shlex
import shutil
import struct
import sys
from pathlib import Path

HUB_FILE_LIMIT = 50 * 1000 ** 3
PATH_RE = re.compile(r"(?:~|/home|/Users|/root|/mnt|/tmp|/var|/data|/workspace)/[^\s`'\")\]]+")
PERSONAL_RE = re.compile(r"oliver|villson", re.I)   # the repo URL in the credit line is the one allowed mention
SKIP_NAMES = {".DS_Store", "receipt.json"}
SKIP_SUFFIXES = (".tmp", ".lock", ".pyc", ".log")
TOKENIZER_ANY = ("tokenizer.json", "tokenizer.model", "vocab.json", "tiktoken.model")
CREDIT = "[BlackHole-Harness](https://github.com/OliverVillson/BlackHole-Harness)"
DATA = Path(__file__).resolve().parent / "data"


# --------------------------------------------------------------------------- what the folder is

def kind_of(cfg: dict, folder: Path) -> str:
    """mlx (a BlackHole / mlx-lm folder), compressed-tensors (GPTQ W4A16 for vLLM) or transformers."""
    q = cfg.get("quantization") or {}
    if (isinstance(q, dict) and "group_size" in q) or cfg.get("model_file") or (folder / "flint_mlx.py").exists():
        return "mlx"
    qc = cfg.get("quantization_config") or {}
    if isinstance(qc, dict) and qc.get("quant_method"):
        return str(qc["quant_method"])
    return "transformers"


def slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    s = re.sub(r"-{2,}", "-", s)
    return (s or "model")[:96]


def scrub(text: str) -> str:
    """Local paths -> their last part (a card must not show /home/<user>/...)."""
    return PATH_RE.sub(lambda m: Path(m.group(0).rstrip("/")).name, text)


def _scrub_json(v, base_model: str):
    if isinstance(v, dict):
        return {k: (base_model if k == "blackhole_source" else _scrub_json(x, base_model)) for k, x in v.items()}
    if isinstance(v, list):
        return [_scrub_json(x, base_model) for x in v]
    if isinstance(v, str) and PATH_RE.fullmatch(v):
        return Path(v.rstrip("/")).name
    return v


def _front_matter(text: str) -> dict:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            k, sep, v = line.partition(":")
            if sep and not line.startswith((" ", "-")):
                out[k.strip()] = v.strip().strip("'\"")
    return out


def base_license(base_dir: Path | None) -> str:
    if base_dir and (base_dir / "README.md").exists():
        return _front_matter((base_dir / "README.md").read_text(errors="ignore")).get("license", "")
    return ""


# --------------------------------------------------------------------------- checks

def safetensors_keys(path: Path) -> list[str]:
    """The tensor names of a shard, after checking its header and that the file is long enough."""
    size = path.stat().st_size
    with open(path, "rb") as f:
        head = f.read(8)
        if len(head) < 8:
            raise ValueError("shorter than a safetensors header")
        n = struct.unpack("<Q", head)[0]
        if n > min(size - 8, 100 * 1024 ** 2):
            raise ValueError("header length is wrong (not a safetensors file, or cut off)")
        meta = json.loads(f.read(n))
    end = max((v["data_offsets"][1] for k, v in meta.items() if k != "__metadata__"), default=0)
    if 8 + n + end > size:
        raise ValueError(f"cut off: {size} bytes, the header says {8 + n + end}")
    return [k for k in meta if k != "__metadata__"]


def check(folder: Path) -> tuple[list[str], list[str]]:
    """(errors, warnings) for an upload folder."""
    errors, warns = [], []
    cfg_p = folder / "config.json"
    if not cfg_p.exists():
        return [f"no config.json in {folder}"], warns
    try:
        cfg = json.loads(cfg_p.read_text())
    except json.JSONDecodeError as e:
        return [f"config.json does not parse: {e}"], warns
    shards = sorted(folder.glob("*.safetensors"))
    if not shards:
        errors.append("no .safetensors weights")
    keys: dict[str, set] = {}
    for s in shards:
        try:
            keys[s.name] = set(safetensors_keys(s))
        except (ValueError, OSError, json.JSONDecodeError) as e:
            errors.append(f"{s.name}: {e}")
    idx_p = folder / "model.safetensors.index.json"
    if idx_p.exists():
        wm = json.loads(idx_p.read_text()).get("weight_map") or {}
        missing_files = sorted({f for f in wm.values() if not (folder / f).exists()})
        if missing_files:
            errors.append(f"the index names shards that are not there: {', '.join(missing_files[:5])}")
        lost = [k for k, f in wm.items() if f in keys and k not in keys[f]]
        if lost:
            errors.append(f"{len(lost)} index entries are not in their shard (first: {lost[0]})")
        unindexed = [s for s in keys if s not in set(wm.values())]
        if unindexed:
            errors.append(f"shards the index does not name: {', '.join(unindexed[:5])}")
    elif len(shards) > 1:
        errors.append("several shards and no model.safetensors.index.json")
    if not any((folder / t).exists() for t in TOKENIZER_ANY):
        errors.append("no tokenizer (tokenizer.json / tokenizer.model / vocab.json)")
    if not (folder / "tokenizer_config.json").exists():
        warns.append("no tokenizer_config.json")
    tc = folder / "tokenizer_config.json"
    if not (folder / "chat_template.jinja").exists() and not (tc.exists() and "chat_template" in tc.read_text(errors="ignore")):
        warns.append("no chat template (chat_template.jinja or tokenizer_config.json): chat servers will not format turns")
    mf = cfg.get("model_file")
    if mf and not (folder / mf).exists():
        errors.append(f"config.json names model_file {mf}, which is not in the folder")
    for py in folder.glob("*.py"):
        for mod in re.findall(r"^\s*(?:from|import)\s+(\w+_mlx)\b", py.read_text(errors="ignore"), re.M):
            if not (folder / f"{mod}.py").exists():
                errors.append(f"{py.name} imports {mod}, which is not in the folder")
    if cfg.get("hex") and not mf:
        warns.append("HEX weights but no model_file in config.json: plain mlx-lm will not load them")
    for f in folder.iterdir():
        if f.is_file() and f.stat().st_size > HUB_FILE_LIMIT:
            errors.append(f"{f.name} is over the Hub's 50 GB per-file limit")
    card = folder / "README.md"
    if card.exists():
        text = card.read_text(errors="ignore")
        if PERSONAL_RE.search(text.replace("github.com/OliverVillson", "")):
            errors.append("the model card names a person; credit BlackHole-Harness only")
        if PATH_RE.search(text):
            errors.append("the model card shows a local path")
    else:
        errors.append("no README.md model card")
    return errors, warns


# --------------------------------------------------------------------------- the model card

def _usage(kind: str, repo: str) -> list[str]:
    if kind == "mlx":
        return ["## Run it on a Mac (Apple silicon)", "", "```",
                "pip install mlx-lm",
                f"mlx_lm.server --model {repo} --trust-remote-code --prompt-concurrency 1 --prefill-step-size 512 --prompt-cache-size 2",
                "```", "",
                "That serves an OpenAI-compatible API on port 8080 (opencode, pi, any OpenAI client). One prompt:", "",
                "```", f"mlx_lm.generate --model {repo} --trust-remote-code --prompt 'Write a binary search in Python'",
                "```", "",
                "The model code (`*_mlx.py` in this repo, HEX expert kernels for Metal) is loaded with "
                "`--trust-remote-code`; on a 16 GB Mac close other large apps first. To get the files: "
                f"`hf download {repo} --local-dir {repo.split('/')[-1]}`."]
    if kind == "compressed-tensors":
        return ["## Run it with vLLM", "", "```", "pip install vllm", f"vllm serve {repo}", "```"]
    return ["## Run it", "", "```python", "from transformers import AutoModelForCausalLM, AutoTokenizer",
            f"tok = AutoTokenizer.from_pretrained('{repo}')",
            f"model = AutoModelForCausalLM.from_pretrained('{repo}', dtype='auto', device_map='auto')", "```"]


def _results_lines(results: dict) -> list[str]:
    sb = results.get("swebench_pro") or {}
    lines = []
    if sb.get("score") is not None:
        n = sb.get("instances")
        lines.append(f"- SWE-bench Pro: {sb['score']:.1%} resolved" + (f" ({n} tasks)" if n else ""))
    return lines


def card(src: Path, name: str, repo: str, kind: str, base_model: str, license_id: str, results: dict) -> str:
    tags = ["blackhole-harness", "compressed"]
    cfg = json.loads((src / "config.json").read_text())
    if kind == "mlx":
        tags += ["mlx"]
    if cfg.get("hex"):
        tags += ["hex", "reaq"]
    if any(k in json.dumps(cfg) for k in ("num_experts", "n_routed_experts", "num_local_experts")):
        tags += ["moe", "reap"]
    fm = ["---", f"license: {license_id}"]
    if license_id == "other":
        fm.append("license_name: same-as-base-model")
    if base_model and not Path(base_model).is_absolute():
        fm += ["base_model:", f"- {base_model}", "base_model_relation: quantized"]
    fm += [f"library_name: {'mlx' if kind == 'mlx' else 'transformers'}", "pipeline_tag: text-generation", "tags:",
           *[f"- {t}" for t in dict.fromkeys(tags)], "---", ""]
    body = (src / "README.md").read_text(errors="ignore") if (src / "README.md").exists() else ""
    body = re.sub(r"^---\n.*?\n---\n", "", body, flags=re.S)
    body = scrub(body).strip()
    body_lines = body.splitlines()
    if body_lines and body_lines[0].startswith("# "):
        body_lines = body_lines[1:]
    # the package card's "Run it on a Mac" names the local folder; the Hub section below replaces it
    cut = next((i for i, ln in enumerate(body_lines) if ln.startswith("## Run it")), None)
    if cut is not None:
        body_lines = body_lines[:cut]
    res = _results_lines(results)
    out = [*fm, f"# {name}", "",
           f"Compressed with {CREDIT}" + (f" from [{base_model}](https://huggingface.co/{base_model})."
                                           if base_model and not Path(base_model).is_absolute() else "."), ""]
    if body_lines:
        out += [*body_lines, ""]
    if res:
        out += ["## Benchmarks", "", *res, ""]
    out += [*_usage(kind, repo), "", "## License", "",
            (f"Apache-2.0, the same as the base model." if license_id == "apache-2.0"
             else f"The base model's license ({license_id}) applies to these weights; see LICENSE."), ""]
    return "\n".join(out)


# --------------------------------------------------------------------------- prepare

def _link(src: Path, dst: Path) -> None:
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        os.symlink(src.resolve(), dst)


def prepare(src: Path, dst: Path, repo: str, base_model: str = "", license_id: str = "",
            base_dir: Path | None = None, results: dict | None = None) -> dict:
    """Fill dst (made fresh, except the upload's resume state in dst/.cache) from the model folder src."""
    src, dst = Path(src).resolve(), Path(dst)
    if dst.resolve() == src:
        raise ValueError("the upload folder must not be the model folder")
    cfg = json.loads((src / "config.json").read_text())
    kind = kind_of(cfg, src)
    license_id = (license_id or base_license(base_dir) or base_license(src) or "apache-2.0").lower()
    dst.mkdir(parents=True, exist_ok=True)
    for f in dst.iterdir():
        if f.name == ".cache":
            continue
        shutil.rmtree(f) if f.is_dir() and not f.is_symlink() else f.unlink()
    files = []
    for f in sorted(src.iterdir()):
        if f.is_dir() or f.name.startswith(".") or f.name in SKIP_NAMES or f.name.endswith(SKIP_SUFFIXES) \
                or f.name in ("README.md", "config.json"):
            continue
        _link(f, dst / f.name)
        files.append(f.name)
    (dst / "config.json").write_text(json.dumps(_scrub_json(cfg, base_model), indent=2) + "\n")
    if not any((dst / n).exists() for n in ("LICENSE", "LICENSE.txt", "LICENSE.md")):
        lic = next((base_dir / n for n in ("LICENSE", "LICENSE.txt") if base_dir and (base_dir / n).exists()), None)
        if lic:
            shutil.copy2(lic, dst / "LICENSE")
        elif license_id == "apache-2.0":
            shutil.copy2(DATA / "APACHE-2.0.txt", dst / "LICENSE")
    results = results or {}
    if results:
        (dst / "blackhole.json").write_text(json.dumps(_scrub_json(results, base_model), indent=2, default=str) + "\n")
    name = repo.split("/")[-1]
    (dst / "README.md").write_text(card(src, name, repo, kind, base_model, license_id, results))
    size = sum(p.stat().st_size for p in dst.iterdir() if p.is_file())
    errors, warns = check(dst)
    return {"source": str(src), "folder": str(dst), "repo": repo, "kind": kind, "license": license_id,
            "size_gb": round(size / 1024 ** 3, 2), "files": sorted(p.name for p in dst.iterdir() if p.name != ".cache"),
            "errors": errors, "warnings": warns}


# --------------------------------------------------------------------------- the Hub

def get_token(stdin: bool = False) -> str | None:
    if stdin:
        t = sys.stdin.readline().strip()
        return t or None
    t = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if t:
        return t
    try:
        from huggingface_hub import get_token as hub_token
        return hub_token()
    except Exception:  # noqa: BLE001  (old huggingface_hub, or none)
        return None


def whoami(token: str) -> str:
    from huggingface_hub import HfApi
    return HfApi(token=token).whoami()["name"]


def upload(folder: Path, repo: str, token: str, private: bool = True) -> str:
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    api.create_repo(repo, repo_type="model", private=private, exist_ok=True)
    if hasattr(api, "upload_large_folder"):   # resumable: rerun the same command after a cut
        api.upload_large_folder(repo_id=repo, folder_path=str(folder), repo_type="model",
                                ignore_patterns=[".cache/**"])
    else:
        api.upload_folder(repo_id=repo, folder_path=str(folder), repo_type="model",
                          commit_message="BlackHole-Harness build", ignore_patterns=[".cache/**"])
    return f"https://huggingface.co/{repo}"


def make_public(repo: str, token: str) -> None:
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    if hasattr(api, "update_repo_settings"):
        api.update_repo_settings(repo, private=False, repo_type="model")
    else:
        api.update_repo_visibility(repo, private=False, repo_type="model")


# --------------------------------------------------------------------------- jobs and commands

def job_target(job_dir: Path, which: str = "final") -> Path:
    """The model folder of a job: receipt.json's final model, else mlx > int4 > healed > pruned."""
    from blackhole_dev.functions_src import _bench
    from blackhole_dev.jobctx import Job
    job = Job(job_dir, "hf-publish")
    if which in ("", "final"):
        rec = job.bh.read("receipt.json") or {}
        if rec.get("model") and (Path(rec["model"]) / "config.json").exists():
            return Path(rec["model"])
        dirs = _bench.model_dirs(job)
        for n in ("mlx", "int4", "healed", "pruned"):
            if n in dirs:
                return dirs[n]
        raise RuntimeError("the job has no finished model folder yet (run the recipe through package first)")
    return _bench.resolve(job, which)[1]


def job_info(job_dir: Path) -> tuple[str, Path | None, dict]:
    """(base model id, base model folder, results) of a job, for the card."""
    from blackhole_dev.jobctx import Job
    job = Job(job_dir, "hf-publish")
    base = str(job.config.get("model", ""))
    try:
        bdir = Path(job.model_dir)
    except Exception:  # noqa: BLE001
        bdir = None
    rec = job.bh.read("receipt.json") or {}
    results = {k: v for k, v in (rec.get("results") or {}).items() if v}
    results = {k: {kk: vv for kk, vv in v.items() if isinstance(vv, (int, float, str))}
               if isinstance(v, dict) else v for k, v in results.items()}
    sb = job.read("work/external-swebench-pro.json")
    if sb:
        results["swebench_pro"] = {k: sb[k] for k in ("score", "instances", "name") if k in sb}
    return base, bdir, results


def ssh_target() -> str:
    conn = os.environ.get("SSH_CONNECTION", "").split()
    return f"{getpass.getuser()}@{conn[2]}" if len(conn) >= 3 else "USER@VM"


def commands(python: str, target: str, info: dict, private: bool = True) -> list[str]:
    """What you run: from the Mac app terminal over ssh with $HF_TOKEN, or on the VM after a login."""
    host = ssh_target()
    base = f"{shlex.quote(python)} -m blackhole_dev.hfpub {target}"
    remote = lambda extra: f"printf '%s' \"$HF_TOKEN\" | ssh {host} {shlex.quote(base + ' --token-stdin' + extra)}"  # noqa: E731
    repo_arg = "" if info["repo"].startswith("<") else f" --repo {shlex.quote(info['repo'])}"
    return [
        f"Upload folder: {info['folder']} ({info['size_gb']} GB, {len(info['files'])} files, {info['kind']})",
        f"Repo: {info['repo']} (private until you make it public)",
        "",
        "On the Mac, in BlackHole-Dev's terminal (it has your Hugging Face token from Settings):",
        "1. check (uploads nothing):",
        remote(repo_arg),
        "2. upload, private:",
        remote(repo_arg + " --upload"),
        "3. after looking at the page, make it public:",
        remote(repo_arg + " --public"),
        "",
        "Or on the VM itself, log in once (paste the token when asked), then upload:",
        f"{shlex.quote(python)} -c 'from huggingface_hub import login; login()'",
        base + repo_arg + " --upload",
        base + repo_arg + " --public",
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m blackhole_dev.hfpub", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", help="a model folder (or give --job)")
    ap.add_argument("--job", help="a pipeline job folder: publishes its final model")
    ap.add_argument("--model", default="final", help="with --job: final, mlx, int4, healed, pruned or a folder")
    ap.add_argument("--repo", default="", help="NAME/REPO on the Hub (default: <your user>/<build folder name>)")
    ap.add_argument("--base-model", default="", help="the base model's Hub id, for the card")
    ap.add_argument("--license", default="", help="Hub license id (default: the base model's, else apache-2.0)")
    ap.add_argument("--out", help="the upload folder (default: <job>/publish/<repo name>, or FOLDER.hf)")
    ap.add_argument("--upload", action="store_true", help="create the repo (private) and upload")
    ap.add_argument("--public", action="store_true", help="make the repo public")
    ap.add_argument("--token-stdin", action="store_true", help="read the Hugging Face token from stdin")
    a = ap.parse_args(argv)
    if bool(a.folder) == bool(a.job):
        ap.error("give a model folder or --job, one of the two")
    token = get_token(a.token_stdin)
    base_model, base_dir, results = a.base_model, None, {}
    if a.job:
        job_dir = Path(a.job).expanduser().resolve()
        src = job_target(job_dir, a.model)
        b, base_dir, results = job_info(job_dir)
        base_model = base_model or b
    else:
        src = Path(a.folder).expanduser().resolve()
    name = slug(src.name)
    repo = a.repo
    if not repo:
        repo = f"<your-hf-name>/{name}"
        if token:
            try:
                repo = f"{whoami(token)}/{name}"
            except Exception:  # noqa: BLE001  (offline or a bad token: fine for a check, not for an upload)
                if a.upload or a.public:
                    raise
    out = Path(a.out).expanduser() if a.out else ((Path(a.job).expanduser().resolve() / "publish" / name) if a.job
                                                    else src.with_name(src.name + ".hf"))
    info = prepare(src, out, repo, base_model, a.license, base_dir, results)
    print(f"model folder  {info['source']}")
    print(f"upload folder {info['folder']}  ({info['size_gb']} GB, {len(info['files'])} files, {info['kind']}, "
          f"license {info['license']})")
    print(f"repo          https://huggingface.co/{repo}")
    print(f"token         {'found' if token else 'none (pipe it with --token-stdin, set HF_TOKEN, or log in)'}")
    for w in info["warnings"]:
        print(f"warning: {w}")
    for e in info["errors"]:
        print(f"ERROR: {e}")
    if info["errors"]:
        print("not uploading: fix the errors above first")
        return 1
    if not (a.upload or a.public):
        print("checks passed; nothing uploaded (add --upload)")
        return 0
    if not token:
        print("ERROR: no Hugging Face token (BlackHole-Dev Settings > Hugging Face token, then run this from the "
              "app's terminal with --token-stdin; or log in on this machine)")
        return 2
    if a.upload:
        print(f"uploading to {repo} (private) ...", flush=True)
        print(f"uploaded: {upload(out, repo, token, private=True)}")
    if a.public:
        make_public(repo, token)
        print(f"public: https://huggingface.co/{repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
