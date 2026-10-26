"""A stand-in for blackhole_pipeline: same CLI and event shape, seconds instead of hours."""
import argparse, json, os, signal, sys, tarfile, time
ap = argparse.ArgumentParser(prog="blackhole_pipeline")
ap.add_argument("--job", required=True)
ap.add_argument("--recipe")
ap.add_argument("--from", dest="start")
a = ap.parse_args()
def emit(stage, status="running", pct=None, msg="", **x):
    ev = {"stage": stage, "status": status, "ts": round(time.time(), 3)}
    if pct is not None: ev["pct"] = pct
    if msg: ev["msg"] = msg
    ev.update(x); print(json.dumps(ev), flush=True)
def stop(*_):
    emit("pipeline", "error", msg="stopped", outcome="stopped"); sys.exit(143)
signal.signal(signal.SIGTERM, stop)
job = a.job
with tarfile.open(a.recipe) as t:
    m = json.load(t.extractfile("manifest.json"))
cfg = os.path.join(job, "config.json")
if not os.path.exists(cfg):
    json.dump({"model": m["base_model"], "schema": m["id"], "stage_list": m["stages"]}, open(cfg, "w"))
speed = float(os.environ.get("FAKE_SPEED", m.get("inputs", {}).get("speed", 0.05)))
emit("pipeline", "running", 0, "started")
print(time.strftime("%H:%M:%S") + f" job {os.path.basename(job)}: {m['base_model']}", flush=True)
for st in m["stages"]:
    emit(st, "running", 0, "starting")
    if st == "heal":
        for step in range(8, 65, 8):
            time.sleep(speed)
            emit(st, pct=step / 64 * 100, msg=f"distil step {step}: held-out KL {0.0195 - step * 0.00001:.4f} (start 0.0195, best 0.019 at step {step})")
        emit(st, "done", 100, "healed", kl=0.0188, top1=0.93)
    elif st == "fail":
        emit(st, "error", msg="RuntimeError: CUDA out of memory"); emit("pipeline", "error", msg="fail failed", outcome="error"); sys.exit(1)
    else:
        for i in range(1, 4):
            time.sleep(speed); emit(st, pct=i * 33, msg=f"{st} {i}/3")
        emit(st, "done", 100, f"{st} ok")
out = os.path.join(job, "out"); os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "model.safetensors"), "wb") as f: f.write(os.urandom(300_000))
open(os.path.join(out, "config.json"), "w").write("{}")
emit("pipeline", "done", 100, out, model=out, size_gb=9.8, outcome="done", gates_passed=True)
