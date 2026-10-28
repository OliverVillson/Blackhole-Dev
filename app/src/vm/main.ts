// WS5 main side: registers the vm:* handlers (I6 jobs API) with the shell.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickPython } from "../main/python";
import { pythonCloud } from "./cloud";
import type { VmMainContext } from "./ctx";
import { HostStore } from "./hosts";
import { JobsService } from "./jobs";
import { CH, type JobRef, type LaunchOptions } from "./shared";
import { OpenSsh } from "./ssh";

/** The blackhole_dev wheel the app ships (Contents/Resources/wheels), for VMs that lack it. */
function shippedWheel(): { path: string; version: string } | null {
  const dir = join(process.resourcesPath ?? "", "wheels");
  if (!existsSync(dir)) return null;
  const w = readdirSync(dir).find((f) => /^blackhole_dev-.+\.whl$/.test(f));
  const v = w && /^blackhole_dev-([^-]+)-/.exec(w)?.[1];
  return w && v ? { path: join(dir, w), version: v } : null;
}

/** Runs a python and returns its stdout; rejects with the last stderr line. */
function py(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().split("\n").pop())) : resolve(out));
  });
}

/**
 * A run from source (npm run dev) ships no wheel, and the repo may be private, so a VM cannot pip
 * install blackhole_dev from GitHub. Build one from the checkout the helper imports instead: once per
 * app session, `pip wheel --no-deps` (setuptools, a few seconds).
 */
export function checkoutWheel(python: () => string): () => Promise<{ path: string; version: string } | null> {
  let built: Promise<{ path: string; version: string } | null> | null = null;
  return () => {
    built ??= (async () => {
      const exe = python();
      const out = await py(exe, ["-c", "import blackhole_dev, os; print(blackhole_dev.__version__); print(os.path.dirname(os.path.dirname(os.path.abspath(blackhole_dev.__file__))))"], 30_000);
      const [version, root] = out.trim().split("\n");
      if (!version || !root || !existsSync(join(root, "pyproject.toml"))) return null;
      const dir = mkdtempSync(join(tmpdir(), "bhdev-wheel-"));
      await py(exe, ["-m", "pip", "wheel", "--no-deps", "--quiet", "-w", dir, root], 180_000);
      const w = readdirSync(dir).find((f) => /^blackhole_dev-.+\.whl$/.test(f));
      return w ? { path: join(dir, w), version } : null;
    })().catch(() => (built = null));
    return built;
  };
}

export async function activate(ctx: VmMainContext): Promise<{ deactivate(): void }> {
  const electron = await import("electron").catch(() => null);
  const python = () => pickPython(ctx.settings.get<string>("python.path", ""), process.resourcesPath);
  const jobs = new JobsService({
    remote: new OpenSsh(),
    hosts: new HostStore(ctx.settings),
    gate: ctx.gate,
    helper: ctx.helper,
    send: (ch, p) => ctx.send(ch, p),
    settings: ctx.settings,
    cloud: pythonCloud(() => (existsSync(python()) ? python() : "python3")),
    paths: { models: ctx.paths.models },
    devWheel: (() => {
      const fromCheckout = checkoutWheel(python);
      return () => shippedWheel() ?? fromCheckout();
    })(),
    notify: (title, body) => {
      const N = electron?.Notification;
      if (N?.isSupported()) new N({ title, body, silent: false }).show();
    },
  });

  ctx.handle(CH.hostsList, () => jobs.hosts());
  ctx.handle(CH.hostsAdd, (spec: string, label?: string, identityFile?: string) => jobs.addHost(spec, label, identityFile));
  ctx.handle(CH.hostsUpdate, (id: string, prefs: object) => jobs.updateHost(id, prefs));
  ctx.handle(CH.hostsRemove, (id: string) => jobs.removeHost(id));
  ctx.handle(CH.hostsTest, (id: string) => jobs.testHost(id));
  ctx.handle(CH.hostsForget, (id: string) => jobs.forgetHost(id));

  ctx.handle(CH.vmOffer, (spec) => jobs.offer(spec));
  ctx.handle(CH.vmUp, (spec, requestedBy?: "user" | "copilot") => jobs.vmUp(spec, requestedBy));
  ctx.handle(CH.vmDown, (hostId: string, o: { keepDisk: boolean; force?: boolean; resume?: boolean }, requestedBy?: "user" | "copilot") =>
    o.resume ? jobs.vmResume(hostId, requestedBy) : jobs.vmDown(hostId, o, requestedBy));

  ctx.handle(CH.jobPrepare, (recipePath: string, hostId: string, o?: { jobName?: string }) => jobs.prepare(recipePath, hostId, o));
  ctx.handle(CH.jobLaunch, (planId: string, o: LaunchOptions) => jobs.launch(planId, o));
  ctx.handle(CH.jobList, (hostId: string) => jobs.listJobs(hostId));
  ctx.handle(CH.jobWatch, (ref: JobRef) => jobs.watch(ref));
  ctx.handle(CH.jobUnwatch, (ref: JobRef) => jobs.unwatch(ref));
  ctx.handle(CH.jobState, (ref: JobRef) => jobs.state(ref));
  ctx.handle(CH.jobStop, (ref: JobRef) => jobs.stop(ref));
  ctx.handle(CH.jobPull, (ref: JobRef, o?: { dest?: string; requestedBy?: "user" | "copilot" }) =>
    // never let a caller claim the approval was given already
    jobs.pull(ref, { dest: o?.dest, requestedBy: o?.requestedBy }));
  ctx.handle(CH.jobExport, async (bundle: string) => {
    const dialog = electron?.dialog;
    if (!dialog) throw new Error("no file dialog");
    const r = await dialog.showSaveDialog({ defaultPath: bundle.split("/").pop(), filters: [{ name: "BlackHole recipe bundle", extensions: ["bhr"] }] });
    if (r.canceled || !r.filePath) return null;
    const { copyFile } = await import("node:fs/promises");
    await copyFile(bundle, r.filePath);
    return r.filePath;
  });
  ctx.handle(CH.terminalArgs, (hostId: string, mode: "tui" | "attach" | "shell", job?: string) => jobs.terminalArgs(hostId, mode, job));

  ctx.handle(CH.copilotUp, (a: { preset?: string; why?: string }) => jobs.copilotUp(a));
  ctx.handle(CH.copilotDown, (a: { host?: string; why?: string }) => jobs.copilotDown(a));
  ctx.handle(CH.copilotLaunch, (a: { recipe: string; host?: string; why?: string }) => jobs.copilotLaunch(a));

  jobs.resumeWatches();
  return { deactivate: () => jobs.dispose() };
}
