"""What a host has, in one ssh round trip: `ssh HOST python3 - [VENV] < probe.py` prints one JSON object.

Runs with the machine's system python3 (no packages). Reads only; changes nothing.
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time

HOME = os.environ.get("BLACKHOLE_HOME") or os.path.expanduser("~/.blackhole")
WANT_VENV = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None


def run(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


def find_venv():
    # install.sh puts it in $BLACKHOLE_HOME/venv; the hand-made B300 setup uses ~/bh-venv
    cands = [WANT_VENV] if WANT_VENV else []
    cands += [os.path.join(HOME, "venv"), os.path.expanduser("~/bh-venv"), os.path.expanduser("~/reaper-venv")]
    for v in cands:
        py = os.path.join(os.path.expanduser(v), "bin", "python")
        if os.path.exists(py) and run([py, "-c", "import blackhole_pipeline"])[0] == 0:
            return os.path.expanduser(v)
    return None


def pipelines():
    """pid -> --job dir for every running `python ... -m blackhole_pipeline --job DIR`, read from argv itself
    (so a shell whose command line merely mentions it, or a tmux server, is never mistaken for one)."""
    found = {}
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(d + "/cmdline", "rb") as f:
                argv = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        if not argv or "python" not in os.path.basename(argv[0]):
            continue
        if "blackhole_pipeline" in argv and "-m" in argv and "--job" in argv:
            i = argv.index("--job")
            if i + 1 < len(argv):
                found[int(d[6:])] = os.path.realpath(argv[i + 1])
    return found


def last_event(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            n = f.tell()
            f.seek(max(0, n - 65536))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None, None
    last, outcome = None, None
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict) and "stage" in ev and "status" in ev:
            last = ev
            if ev["stage"] == "pipeline":
                outcome = None if ev["status"] == "running" else (ev.get("outcome") or ("done" if ev["status"] == "done" else "error"))
    return last, outcome


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def jobs():
    running = {}
    for pid, d in pipelines().items():
        running.setdefault(d, []).append(pid)
    out = []
    dirs = [d for d in glob.glob(os.path.join(HOME, "jobs", "*")) if os.path.isdir(d)]
    dirs.sort(key=lambda d: os.path.getmtime(d), reverse=True)
    for d in dirs[:60]:
        cfg = read_json(os.path.join(d, "config.json"))
        launch = read_json(os.path.join(d, "launch.json"))
        ev_path = os.path.join(d, "events.log")
        last, outcome = last_event(ev_path)
        pids = running.get(os.path.realpath(d), [])
        outd = os.path.join(d, "out")
        out.append({
            "name": os.path.basename(d),
            "dir": d,
            "model": cfg.get("model"),
            "recipe": cfg.get("schema") or launch.get("recipe"),
            "stages": cfg.get("stage_list") or launch.get("stages"),
            "running": bool(pids),
            "pids": pids,
            "tmux": launch.get("tmux"),
            "startedAt": launch.get("startedAt") or (os.path.getctime(d)),
            "estHours": launch.get("estHours"),
            "updatedAt": os.path.getmtime(ev_path) if os.path.exists(ev_path) else None,
            "last": last,
            "outcome": None if pids else outcome,
            "hasOut": os.path.isdir(outd) and bool(os.listdir(outd)),
        })
    return out


def gpus():
    rc, so, _ = run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                     "--format=csv,noheader,nounits"], timeout=20)
    res = []
    if rc == 0:
        for line in so.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 4:
                try:
                    res.append({"name": parts[0], "memGb": round(float(parts[1]) / 1024, 1),
                                "usedGb": round(float(parts[2]) / 1024, 1), "util": float(parts[3])})
                except ValueError:
                    pass
    return res


def hf_token():
    """Whether downloads here can use a Hugging Face token (gated models need one; public ones do not)."""
    if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
        return True
    hf_home = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
    try:
        with open(os.path.join(hf_home, "token")) as f:
            return bool(f.read().strip())
    except OSError:
        return False


def models():
    """Hub ids the pipeline already downloaded: REAPer keeps them in $REAPER_HOME/models/<org>--<name>."""
    root = os.path.join(os.environ.get("REAPER_HOME") or os.path.expanduser("~/.reaper"), "models")
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    return [n.replace("--", "/", 1) for n in names if os.path.exists(os.path.join(root, n, "config.json"))]


venv = find_venv()
py = os.path.join(venv, "bin", "python") if venv else None
recipe_flag, dev = False, None
if py:
    rc, so, se = run([py, "-m", "blackhole_pipeline", "--help"])
    recipe_flag = "--recipe" in so + se
    rc, so, _ = run([py, "-c", "import blackhole_dev; print(blackhole_dev.__version__)"])
    dev = so.strip().splitlines()[-1] if rc == 0 and so.strip() else None
du = shutil.disk_usage(HOME if os.path.isdir(HOME) else os.path.expanduser("~"))
print(json.dumps({
    "home": HOME,
    "venv": venv,
    "pipeline": bool(venv),
    "recipeFlag": recipe_flag,
    "blackholeDev": dev,
    "tmux": shutil.which("tmux") is not None,
    "rsync": shutil.which("rsync") is not None,
    "gpus": gpus(),
    "diskFreeGb": round(du.free / 1e9, 1),
    "diskTotalGb": round(du.total / 1e9, 1),
    "jobs": jobs(),
    "hfToken": hf_token(),
    "models": models(),
    "now": time.time(),
}))
