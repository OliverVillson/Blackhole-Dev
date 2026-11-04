"""hf-publish / blackhole_dev.hfpub on a tiny fake BlackHole MLX HEX folder: the upload folder
(hardlinks, card, LICENSE, scrubbed config), the checks that stop a broken upload, the CLI's
dry run and upload against a fake Hub client, and the job function through blackhole_dev.jobctx."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
st = pytest.importorskip("safetensors.numpy")

from blackhole_dev import hfpub  # noqa: E402


def fake_mlx(d: Path, src_path: str = "/home/user/.blackhole/jobs/x/reaper/out/tiny-healed") -> Path:
    d.mkdir(parents=True)
    a = {"language_model.model.layers.0.mlp.experts.weight": np.zeros((4, 8), np.uint8),
         "language_model.model.layers.0.mlp.experts.scales": np.ones((4, 1), np.float16)}
    b = {"language_model.lm_head.weight": np.ones((16, 8), np.float16)}
    st.save_file(a, str(d / "model-00001.safetensors"), metadata={"format": "mlx"})
    st.save_file(b, str(d / "model-00002.safetensors"), metadata={"format": "mlx"})
    wm = {**{k: "model-00001.safetensors" for k in a}, **{k: "model-00002.safetensors" for k in b}}
    (d / "model.safetensors.index.json").write_text(json.dumps({"metadata": {"total_size": 1}, "weight_map": wm}))
    (d / "config.json").write_text(json.dumps({
        "model_type": "qwen3_5_moe", "model_file": "qwen_mlx.py", "hex": {"block": 32},
        "text_config": {"num_experts": 4}, "blackhole_source": src_path,
        "quantization": {"group_size": 64, "bits": 3}}))
    (d / "tokenizer.json").write_text("{}")
    (d / "tokenizer_config.json").write_text(json.dumps({"chat_template": "{{ messages }}"}))
    (d / "qwen_mlx.py").write_text("from flint_mlx import HexLinear\n")
    (d / "flint_mlx.py").write_text("class HexLinear: pass\n")
    (d / "hex_check.py").write_text("")
    (d / "README.md").write_text(
        "# tiny-MLX-0.1GB\n\nQwen/Tiny-MoE compressed by BlackHole-Harness (schema `qwen-mac-qhex`):\n\n"
        f"- REAP 4 -> 3 routed experts\n\nSource {src_path}\n\n## Run it on a Mac\n\n```\nmlx_lm.server --model tiny\n```\n")
    return d


def test_prepare_makes_a_complete_upload_folder(tmp_path):
    src = fake_mlx(tmp_path / "out" / "tiny-MLX-0.1GB")
    before = {f.name: f.read_bytes() for f in src.iterdir()}
    info = hfpub.prepare(src, tmp_path / "publish" / "tiny", "someone/tiny-MLX-0.1GB", "Qwen/Tiny-MoE",
                         results={"mlx": {"kl": 0.07, "out": str(src)}, "swebench_pro": {"score": 0.25, "instances": 20}})
    assert info["errors"] == [], info
    assert info["kind"] == "mlx" and info["license"] == "apache-2.0"
    dst = Path(info["folder"])
    for f in ("model-00001.safetensors", "model-00002.safetensors", "model.safetensors.index.json", "tokenizer.json",
              "tokenizer_config.json", "qwen_mlx.py", "flint_mlx.py", "hex_check.py", "config.json", "README.md",
              "LICENSE", "blackhole.json"):
        assert (dst / f).exists(), f
    assert os.stat(dst / "model-00001.safetensors").st_ino == os.stat(src / "model-00001.safetensors").st_ino
    cfg = json.loads((dst / "config.json").read_text())
    assert cfg["blackhole_source"] == "Qwen/Tiny-MoE" and cfg["model_file"] == "qwen_mlx.py"
    card = (dst / "README.md").read_text()
    assert card.startswith("---\nlicense: apache-2.0\n") and "base_model:\n- Qwen/Tiny-MoE" in card
    assert "library_name: mlx" in card and "- hex" in card and "BlackHole-Harness" in card
    assert "mlx_lm.server --model someone/tiny-MLX-0.1GB --trust-remote-code" in card
    assert "SWE-bench Pro: 25.0% resolved (20 tasks)" in card
    assert "/home/" not in card and "oliver" not in card.replace("github.com/OliverVillson", "").lower()
    assert "Apache License" in (dst / "LICENSE").read_text()
    assert "/home/" not in (dst / "blackhole.json").read_text()
    assert {f.name: f.read_bytes() for f in src.iterdir()} == before     # the model folder is untouched
    again = hfpub.prepare(src, dst, "someone/tiny-MLX-0.1GB", "Qwen/Tiny-MoE")   # rerun: same result
    assert again["errors"] == [] and again["files"] == sorted(set(info["files"]) - {"blackhole.json"})


@pytest.mark.parametrize("breakage, expect", [
    ("drop_flint", "imports flint_mlx"),
    ("cut_shard", "cut off"),
    ("index_extra", "not in their shard"),
    ("no_tokenizer", "no tokenizer"),
    ("model_file", "names model_file"),
])
def test_checks_stop_a_broken_folder(tmp_path, breakage, expect):
    src = fake_mlx(tmp_path / "m")
    if breakage == "drop_flint":
        (src / "flint_mlx.py").unlink()
    elif breakage == "cut_shard":
        p = src / "model-00002.safetensors"
        p.write_bytes(p.read_bytes()[:-10])
    elif breakage == "index_extra":
        idx = json.loads((src / "model.safetensors.index.json").read_text())
        idx["weight_map"]["language_model.model.norm.weight"] = "model-00001.safetensors"
        (src / "model.safetensors.index.json").write_text(json.dumps(idx))
    elif breakage == "no_tokenizer":
        (src / "tokenizer.json").unlink()
    elif breakage == "model_file":
        cfg = json.loads((src / "config.json").read_text())
        cfg["model_file"] = "other_mlx.py"
        (src / "config.json").write_text(json.dumps(cfg))
    info = hfpub.prepare(src, tmp_path / "pub", "a/b")
    assert any(expect in e for e in info["errors"]), info["errors"]


def test_card_with_a_personal_name_is_refused(tmp_path):
    src = fake_mlx(tmp_path / "m")
    info = hfpub.prepare(src, tmp_path / "pub", "a/b")
    card = Path(info["folder"]) / "README.md"
    card.write_text(card.read_text() + "\nMade by Oliver.\n")
    assert any("names a person" in e for e in hfpub.check(Path(info["folder"]))[0])


class FakeApi:
    calls: list = []

    def __init__(self, token=None):
        assert token == "hf_test"

    def whoami(self):
        return {"name": "someone"}

    def create_repo(self, repo, repo_type, private, exist_ok):
        FakeApi.calls.append(("create", repo, private))

    def upload_large_folder(self, repo_id, folder_path, repo_type, ignore_patterns):
        files = sorted(p.name for p in Path(folder_path).iterdir())
        FakeApi.calls.append(("upload", repo_id, files))

    def update_repo_settings(self, repo, private, repo_type):
        FakeApi.calls.append(("public", repo, private))


def test_cli_dry_run_then_upload(tmp_path, monkeypatch, capsys):
    import huggingface_hub
    src = fake_mlx(tmp_path / "out" / "tiny-MLX-0.1GB")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setattr(hfpub, "get_token", lambda stdin=False: None)
    assert hfpub.main([str(src)]) == 0
    out = capsys.readouterr().out
    assert "checks passed; nothing uploaded" in out and "<your-hf-name>/tiny-MLX-0.1GB" in out
    assert hfpub.main([str(src), "--upload"]) == 2           # no token: refuses, uploads nothing

    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    monkeypatch.setattr(hfpub, "get_token", lambda stdin=False: "hf_test")
    FakeApi.calls = []
    assert hfpub.main([str(src), "--upload"]) == 0
    assert FakeApi.calls[0] == ("create", "someone/tiny-MLX-0.1GB", True)
    assert FakeApi.calls[1][0] == "upload" and "model-00001.safetensors" in FakeApi.calls[1][2]
    assert hfpub.main([str(src), "--public", "--repo", "BlackHole-Harness/tiny"]) == 0
    assert FakeApi.calls[-1] == ("public", "BlackHole-Harness/tiny", False)
    card = (tmp_path / "out" / "tiny-MLX-0.1GB.hf" / "README.md").read_text()
    assert "--model BlackHole-Harness/tiny " in card


class FolderOnlyApi:
    """huggingface_hub 2.x has no upload_large_folder: the upload falls back to upload_folder."""

    def __init__(self, token=None):
        assert token == "hf_test"

    def create_repo(self, repo, repo_type, private, exist_ok):
        FakeApi.calls.append(("create", repo, private))

    def upload_folder(self, repo_id, folder_path, repo_type, commit_message, ignore_patterns):
        FakeApi.calls.append(("upload_folder", repo_id))


def test_upload_without_upload_large_folder(tmp_path, monkeypatch):
    import huggingface_hub
    src = fake_mlx(tmp_path / "m")
    monkeypatch.setattr(huggingface_hub, "HfApi", FolderOnlyApi)
    monkeypatch.setattr(hfpub, "get_token", lambda stdin=False: "hf_test")
    FakeApi.calls = []
    assert hfpub.main([str(src), "--upload", "--repo", "a/b"]) == 0
    assert FakeApi.calls == [("create", "a/b", True), ("upload_folder", "a/b")]


def test_token_from_stdin(monkeypatch):
    import io
    monkeypatch.setattr(sys, "stdin", io.StringIO("hf_abc\n"))
    assert hfpub.get_token(stdin=True) == "hf_abc"


def test_commands_pipe_the_app_token_over_ssh(monkeypatch):
    monkeypatch.setenv("SSH_CONNECTION", "1.2.3.4 5555 203.0.113.11 22")
    info = {"folder": "/j/publish/x", "size_gb": 1.0, "files": ["a"], "kind": "mlx", "repo": "<your-hf-name>/x"}
    cmds = hfpub.commands("/home/u/.blackhole/venv/bin/python", "--job /j", info)
    text = "\n".join(cmds)
    assert "printf '%s' \"$HF_TOKEN\" | ssh" in text and "@203.0.113.11" in text
    assert "--token-stdin --upload" in text and "--repo" not in text
    assert "from huggingface_hub import login; login()" in text


def test_the_job_function(tmp_path):
    pytest.importorskip("blackhole_pipeline")
    pytest.importorskip("reaper_pipeline")
    job = tmp_path / "bh" / "job1"
    src = fake_mlx(job / "reaper" / "out" / "tiny-MLX-0.1GB")
    (job / "recipe").mkdir(parents=True)
    raw = {"id": "blackhole/test", "version": "1.0.0", "runner": "pipeline",
           "stage": [{"id": "publish", "kind": "job.fn", "fn": "hf-publish"}]}
    (job / "recipe" / "recipe.json").write_text(json.dumps({"raw": raw}))
    (job / "config.json").write_text(json.dumps({"model": "Qwen/Tiny-MoE", "schema": "blackhole/test", "target": "",
                                                 "purpose": "", "steps": [], "inputs": {}}))
    (job / "receipt.json").write_text(json.dumps({"model": str(src), "results": {"mlx": {"kl": 0.07}}}))
    (job / "reaper" / "work").mkdir(parents=True)
    (job / "reaper" / "work" / "external-swebench-pro.json").write_text(json.dumps({"score": 0.3, "instances": 20}))
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "BLACKHOLE_HOME": str(tmp_path / "bhhome"),
           "REAPER_HOME": str(tmp_path / "home"), "BLACKHOLE_DEV_FUNCTIONS": str(tmp_path / "none"),
           "SSH_CONNECTION": "1.2.3.4 5555 9.9.9.9 22"}
    env.pop("HF_TOKEN", None)
    p = subprocess.run([sys.executable, "-m", "blackhole_dev.jobctx", "--job", str(job), "--stage", "publish"],
                       env=env, cwd=tmp_path, capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stdout[-3000:] + p.stderr[-3000:]
    pkg = json.loads((job / "publish" / "package.json").read_text())
    assert pkg["errors"] == [] and pkg["source"] == str(src.resolve()) and pkg["kind"] == "mlx"
    assert Path(pkg["folder"]) == (job / "publish" / "tiny-MLX-0.1GB").resolve()
    cmds = (job / "publish" / "COMMANDS.txt").read_text()
    assert f"-m blackhole_dev.hfpub --job {job.resolve()}" in cmds and "@9.9.9.9" in cmds
    assert "SWE-bench Pro: 30.0% resolved" in (Path(pkg["folder"]) / "README.md").read_text()
    res = json.loads((job / "reaper" / "work" / "fn-publish.json").read_text())["result"]
    assert res["uploaded"] == 0 and res["files"] >= 10
