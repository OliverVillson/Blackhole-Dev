"""Stops one job: `ssh HOST python3 - DIR SESSION < stop.py`.

SIGTERM to that job's pipeline (it stops the running stage and frees the GPU), up to 40 s, then
SIGKILL. vLLM workers that outlive it (they used to) are killed only when no other pipeline runs on
the machine. Processes are picked by their own argv, never by a pattern over command lines, so the
shell running this and the tmux server are never hit.
"""

import glob
import os
import signal
import subprocess
import sys
import time

DIR = os.path.realpath(os.path.expanduser(sys.argv[1]))
SESSION = sys.argv[2] if len(sys.argv) > 2 else ""


def procs():
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(d + "/cmdline", "rb") as f:
                argv = f.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        yield int(d[6:]), argv


def pipeline_dirs():
    found = {}
    for pid, argv in procs():
        if argv and "python" in os.path.basename(argv[0]) and "blackhole_pipeline" in argv and "--job" in argv:
            i = argv.index("--job")
            if i + 1 < len(argv):
                found[pid] = os.path.realpath(argv[i + 1])
    return found


def kill(pids, sig):
    for p in pids:
        try:
            os.kill(p, sig)
        except OSError:
            pass


mine = [p for p, d in pipeline_dirs().items() if d == DIR]
kill(mine, signal.SIGTERM)
for _ in range(40):
    if not any(d == DIR for d in pipeline_dirs().values()):
        break
    time.sleep(1)
left = [p for p, d in pipeline_dirs().items() if d == DIR]
kill(left, signal.SIGKILL)
if not pipeline_dirs():
    # vLLM renames its engine process (VLLM::EngineCore), so match the name anywhere in argv
    strays = [p for p, argv in procs() if p not in (os.getpid(), os.getppid()) and
              any("vllm_gen" in a or "EngineCore" in a for a in argv)]
    kill(strays, signal.SIGKILL)
if SESSION:
    subprocess.run(["tmux", "kill-session", "-t", SESSION], capture_output=True)
print("stopped" if not left else "killed")
