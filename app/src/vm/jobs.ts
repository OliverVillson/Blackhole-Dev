// I6 jobs API, main side: check a recipe against a machine, send its bundle, start the pipeline
// in tmux, follow events.log, stop, and copy the finished model back. Every step that costs money
// (VM up/down, a run, a large copy) passes the shell's confirm gate here, in main, whoever asked.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as cloud from "./cloud";
import type { CloudRunner, UpSpec } from "./cloud";
import type { BundleResult, Gate, Helper, Manifest, PlanResult, Problem, Settings } from "./ctx";
import { emptyState, LineSplitter, parseLine, reduce } from "./events";
import { HostStore } from "./hosts";
import * as cmd from "./remote/commands";
import { PROBE_PY, STOP_PY } from "./remote/scripts";
import type {
  Check, Host, JobRef, JobState, JobUpdate, LaunchOptions, LaunchPlan, Probe, PullProgress, RemoteJob, VmOffer,
} from "./shared";
import { CH, jobKey } from "./shared";
import { explainSshError, type Remote, type SshTarget, type Stream } from "./ssh";

export interface JobsDeps {
  remote: Remote;
  hosts: HostStore;
  gate: Gate;
  helper: Helper;
  send(channel: string, payload: unknown): void;
  settings: Settings;
  cloud: CloudRunner;
  paths: { models: string };
  /** The blackhole_dev wheel shipped inside the app, installed on a VM that lacks it or has another version. */
  devWheel?: () => { path: string; version: string } | null;
  notify?: (title: string, body: string) => void;
  now?: () => Date;
  /** Reconnect delays for a dropped events.log tail, in ms. */
  backoff?: number[];
  flushMs?: number;
}

interface Watch {
  ref: JobRef;
  host: Host;
  dir: string;
  state: JobState;
  offset: number;
  stream?: Stream;
  split: LineSplitter;
  users: number;
  link: JobUpdate["link"];
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  retry: number;
  closed: boolean;
}

/** Jobs the app launched, kept across restarts so their watch, notification and copy-back resume. */
interface Remembered { hostId: string; name: string; dir: string; pullWhenDone: boolean; notify: boolean; stages: string[]; pulled?: boolean; finished?: boolean }

const target = (h: Host): SshTarget => ({ target: h.target, port: h.port, identityFile: h.identityFile });

export function costLine(rate: number | undefined, currency: string | undefined, hours: number | undefined): string | undefined {
  if (hours == null || !isFinite(hours)) return rate != null ? `${currency ?? "$"}${rate.toFixed(2)}/h × run time` : undefined;
  const h = hours < 10 ? hours.toFixed(1) : hours.toFixed(0);
  if (rate == null) return `[your VM hourly rate] × ~${h} h`;
  const c = currency ?? "$";
  return `${c}${rate.toFixed(2)}/h × ~${h} h ≈ ${c}${(rate * hours).toFixed(2)}`;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Overall percent from rsync --progress output: per-file byte counts, a file is finished at "xfr#". */
export class RsyncProgress {
  private doneBytes = 0;
  private cur = 0;
  constructor(private readonly total: number) {}
  line(l: string): number | null {
    const m = /^\s*([\d,.]+)\s+(\d{1,3})%/.exec(l);
    if (!m) return null;
    this.cur = Number(m[1].replace(/[,.]/g, ""));
    if (/xfr#/.test(l)) {
      this.doneBytes += this.cur;
      this.cur = 0;
    }
    return this.total > 0 ? Math.min(100, (100 * (this.doneBytes + this.cur)) / this.total) : Number(m[2]);
  }
}

export class JobsService {
  private readonly plans = new Map<string, LaunchPlan>();
  private readonly watches = new Map<string, Watch>();
  private readonly homes = new Map<string, Probe>();
  private readonly now: () => Date;

  constructor(private readonly d: JobsDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ hosts

  hosts(): Host[] {
    return this.d.hosts.list();
  }

  private pushHosts(): void {
    this.d.send(CH.evHosts, this.hosts());
  }

  addHost(spec: string, label?: string, identityFile?: string): Host {
    const h = this.d.hosts.add(spec, label, identityFile);
    this.pushHosts();
    return h;
  }

  updateHost(id: string, prefs: { ratePerHour?: number; currency?: string; venv?: string; label?: string }): Host {
    this.d.hosts.update(id, prefs);
    this.pushHosts();
    return this.d.hosts.get(id);
  }

  removeHost(id: string): void {
    this.d.hosts.remove(id);
    this.pushHosts();
  }

  async probe(hostId: string): Promise<Probe> {
    const h = this.d.hosts.get(hostId);
    if (!h.target) throw new Error(`${h.label} has no address yet (state: ${h.state ?? "unknown"})`);
    const r = await this.d.remote.exec(target(h), `python3 - ${cmd.q(h.venv ?? "")}`, { input: PROBE_PY, timeoutMs: 120_000 });
    if (r.code !== 0) {
      throw new Error(r.code === 255 ? explainSshError(r.stderr, r.code) : `probe failed on ${h.label}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    }
    const last = r.stdout.trim().split("\n").pop() ?? "";
    let p: Probe;
    try {
      p = JSON.parse(last) as Probe;
    } catch {
      throw new Error(`unexpected answer from ${h.label}: ${last.slice(0, 200)}`);
    }
    this.homes.set(hostId, p);
    return p;
  }

  async testHost(hostId: string): Promise<{ ok: boolean; latencyMs: number; probe?: Probe; error?: string }> {
    const t0 = Date.now();
    try {
      const probe = await this.probe(hostId);
      return { ok: true, latencyMs: Date.now() - t0, probe };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
    }
  }

  async listJobs(hostId: string): Promise<RemoteJob[]> {
    return (await this.probe(hostId)).jobs;
  }

  // ------------------------------------------------------------------ cloud VMs (blackhole up / down)

  private vmLog = (scope: string) => (text: string) => this.d.send(CH.evLog, { scope, text });

  offer(spec: UpSpec): Promise<VmOffer> {
    return cloud.offer(this.d.cloud, spec);
  }

  async vmUp(spec: UpSpec, requestedBy: "user" | "copilot" = "user"): Promise<{ approved: boolean; name?: string }> {
    const o = await cloud.offer(this.d.cloud, spec);
    const ok = await this.d.gate.confirm({
      action: "vm.up",
      title: `Start a ${spec.gpu.toUpperCase()} VM on ${spec.provider}`,
      why: "Rents a GPU VM in your own cloud account and installs the harness on it. Your provider bills it by the hour until you stop or delete it.",
      estCost: o.usdPerHour != null ? `$${o.usdPerHour.toFixed(2)}/h until stopped` : o.line,
      details: [{ label: "Offer", value: o.line }, ...(o.note ? [{ label: "Note", value: o.note }] : [])],
      requestedBy,
    });
    if (!ok) return { approved: false };
    const r = await cloud.up(this.d.cloud, spec, this.vmLog("vm.up"));
    this.pushHosts();
    return { approved: true, name: r.name };
  }

  async vmResume(hostId: string, requestedBy: "user" | "copilot" = "user"): Promise<{ approved: boolean }> {
    const h = this.d.hosts.get(hostId);
    const ok = await this.d.gate.confirm({
      action: "vm.up",
      title: `Start ${h.label} again`,
      why: "Starts a stopped VM; your provider bills it by the hour again.",
      estCost: h.ratePerHour != null ? `${h.currency ?? "$"}${h.ratePerHour.toFixed(2)}/h until stopped` : undefined,
      details: [{ label: "Machine", value: `${h.provider ?? ""} ${h.gpu ?? ""}`.trim() }],
      requestedBy,
    });
    if (!ok) return { approved: false };
    await cloud.resume(this.d.cloud, h.label, this.vmLog("vm.up"));
    this.pushHosts();
    return { approved: true };
  }

  async vmDown(hostId: string, o: { keepDisk: boolean; force?: boolean }, requestedBy: "user" | "copilot" = "user"): Promise<{ approved: boolean } & Partial<cloud.DownResult>> {
    const h = this.d.hosts.get(hostId);
    if (h.kind !== "vm") throw new Error(`${h.label} was not started by blackhole up; stop it in your provider's console`);
    const running = [...this.watches.values()].filter((w) => w.ref.hostId === hostId && w.state.status === "running");
    const ok = await this.d.gate.confirm({
      action: "vm.down",
      title: o.keepDisk ? `Stop ${h.label}` : `Delete ${h.label}`,
      why: o.keepDisk
        ? "Stops the VM. Its disk and the models on it stay (and the disk stays billed)."
        : o.force
          ? "Deletes the VM and its disk, including models that were not copied off. This cannot be undone."
          : "Deletes the VM and its disk. If models are still on it, the harness refuses and lists them first.",
      details: running.length ? [{ label: "Running jobs", value: running.map((w) => w.ref.name).join(", ") }] : [],
      requestedBy,
    });
    if (!ok) return { approved: false };
    const r = await cloud.down(this.d.cloud, h.label, o, this.vmLog("vm.down"));
    this.pushHosts();
    return { approved: true, ...r };
  }

  // ------------------------------------------------------------------ run on VM

  /** Every check the dialog shows, and the exact commands launch will run. Nothing is changed anywhere. */
  async prepare(recipePath: string, hostId: string, o?: { jobName?: string } | null): Promise<LaunchPlan> {
    const host = this.d.hosts.get(hostId);
    const checks: Check[] = [];
    const [lint, bundle, probe] = await Promise.allSettled([
      this.d.helper.call<{ problems: Problem[] }>("recipe.lint", { path: recipePath }),
      this.d.helper.call<BundleResult>("recipe.bundle", { path: recipePath }),
      this.probe(hostId),
    ]);

    if (lint.status === "fulfilled") {
      const errs = lint.value.problems.filter((p) => p.severity === "error");
      const warns = lint.value.problems.filter((p) => p.severity === "warning");
      checks.push({ id: "lint", label: "Recipe lint", tone: errs.length ? "bad" : warns.length ? "warn" : "ok",
        detail: errs.length ? `${errs.length} error${errs.length > 1 ? "s" : ""}: ${errs[0].message}` : warns.length ? `${warns.length} warning${warns.length > 1 ? "s" : ""}` : "0 problems" });
    } else checks.push({ id: "lint", label: "Recipe lint", tone: "bad", detail: (lint.reason as Error).message });

    let manifest: Manifest | undefined;
    let bundlePath = "";
    let sha = "";
    let bytes = 0;
    if (bundle.status === "fulfilled") {
      manifest = bundle.value.manifest;
      bundlePath = bundle.value.bundle;
      sha = bundle.value.sha256;
      try {
        bytes = statSync(bundlePath).size;
        const real = await sha256File(bundlePath);
        const n = manifest?.functions?.length ?? 0;
        checks.push(real === sha
          ? { id: "bundle", label: "Functions pinned", tone: "ok", detail: `${n} · sha256 ok · ${fmtBytes(bytes)}` }
          : { id: "bundle", label: "Functions pinned", tone: "bad", detail: "the bundle changed after it was made; check again" });
      } catch (e) {
        checks.push({ id: "bundle", label: "Functions pinned", tone: "bad", detail: (e as Error).message });
      }
    } else checks.push({ id: "bundle", label: "Bundle", tone: "bad", detail: (bundle.reason as Error).message });

    let plan: PlanResult | undefined;
    if (manifest) {
      try {
        plan = await this.d.helper.call<PlanResult>("recipe.plan", { path: recipePath, device: manifest.target });
        const tone = plan.fits === false ? "warn" : "ok";
        checks.push({ id: "plan", label: "Dry-run plan", tone,
          detail: [plan.sizeGb != null ? `${plan.sizeGb.toFixed(1)} GB` : null, plan.fits === false ? `does not fit ${manifest.target ?? "the target"}` : plan.fits ? "fits" : null].filter(Boolean).join(" · ") || "ok" });
      } catch (e) {
        checks.push({ id: "plan", label: "Dry-run plan", tone: "warn", detail: (e as Error).message });
      }
    }

    let p: Probe | undefined;
    let installDev: string | undefined;
    if (probe.status === "fulfilled") {
      p = probe.value;
      checks.push({ id: "ssh", label: "SSH", tone: "ok", detail: host.target });
      checks.push(p.pipeline
        ? { id: "pipeline", label: "Pipeline on VM", tone: "ok", detail: `blackhole_pipeline in ${p.venv}` }
        : { id: "pipeline", label: "Pipeline on VM", tone: "bad", detail: "no venv with blackhole_pipeline (~/.blackhole/venv, ~/bh-venv). Install it on the machine with `curl -fsSL https://blackholeharness.dev/install.sh | bash` (or `blackhole up --host`), or set the venv for this machine" });
      if (p.pipeline && !p.recipeFlag) {
        checks.push({ id: "recipe-flag", label: "Pipeline takes recipes", tone: "bad", detail: "the harness on this machine predates `--recipe`; update it with `curl -fsSL https://blackholeharness.dev/install.sh | bash` there and check again" });
      }
      if (!p.tmux) checks.push({ id: "pipeline", label: "tmux", tone: "bad", detail: "tmux is not installed (sudo apt install tmux)" });
      const needsDev = manifest && (manifest.runner === "core" || (manifest.functions?.length ?? 0) > 0);
      const want = manifest?.blackhole_dev_version;
      if (needsDev && want && p.blackholeDev !== want) {
        const wheel = this.d.devWheel?.();
        if (wheel && wheel.version === want && p.venv) {
          installDev = wheel.path;
          checks.push({ id: "blackhole-dev", label: "blackhole_dev on VM", tone: "info", detail: `${p.blackholeDev ?? "missing"}; installs ${want} first` });
        } else {
          checks.push({ id: "blackhole-dev", label: "blackhole_dev on VM", tone: "bad", detail: `${p.blackholeDev ?? "missing"}, the recipe needs ${want}` });
        }
      } else if (needsDev) {
        checks.push({ id: "blackhole-dev", label: "blackhole_dev on VM", tone: "ok", detail: p.blackholeDev ?? "" });
      }
      const gpu = p.gpus[0];
      const needGpu = manifest?.needs?.gpu_gb ?? undefined;
      if (!gpu) checks.push({ id: "gpu", label: "GPU", tone: "bad", detail: "nvidia-smi sees no GPU" });
      else {
        const free = gpu.memGb - gpu.usedGb;
        checks.push({
          id: "gpu", label: "GPU", tone: needGpu != null && gpu.memGb < needGpu ? "bad" : needGpu != null && free < needGpu ? "warn" : "ok",
          detail: `${p.gpus.length}× ${gpu.name} · ${gpu.memGb.toFixed(0)} GB` + (needGpu != null ? ` · needs ${needGpu.toFixed(0)} GB` : "") + (gpu.usedGb > 2 ? ` · ${gpu.usedGb.toFixed(0)} GB in use` : ""),
        });
      }
      const needDisk = manifest?.needs?.disk_gb ?? undefined;
      checks.push({ id: "disk", label: "Disk", tone: needDisk != null && p.diskFreeGb < needDisk ? "bad" : p.diskFreeGb < 100 ? "warn" : "ok",
        detail: `${p.diskFreeGb.toFixed(0)} GB free` + (needDisk != null ? ` · needs ${needDisk.toFixed(0)} GB` : "") });
      const busy = p.jobs.filter((j) => j.running);
      if (busy.length) checks.push({ id: "busy", label: "Machine busy", tone: "warn", detail: `${busy.map((j) => j.name).join(", ")} running; both would share the GPU` });
    } else {
      checks.push({ id: "ssh", label: "SSH", tone: "bad", detail: (probe.reason as Error).message });
    }
    if (manifest?.base_model) checks.push({ id: "model", label: "Base model", tone: "info", detail: `${manifest.base_model} · downloads on the VM if missing` });

    const name = o?.jobName ?? cmd.jobName(manifest?.name ?? recipePath.split("/").pop() ?? "recipe", this.now());
    if (!cmd.validJobName(name)) checks.push({ id: "lint", label: "Job name", tone: "bad", detail: `"${name}" has characters a folder name cannot` });
    const home = p?.home ?? "~/.blackhole";
    const dir = cmd.jobDir(home, name);
    const session = cmd.tmuxName(name);
    const venv = p?.venv ?? host.venv ?? "~/bh-venv";
    const steps: LaunchPlan["steps"] = [
      { title: "make the job folder", cmd: `ssh ${host.target} ${cmd.q(cmd.mkdirJob(dir))}` },
      { title: `send the bundle (recipe + pinned functions), ${fmtBytes(bytes)}`, cmd: `rsync ${bundlePath.split("/").pop() || "recipe.bhr"} ${host.target}:${dir}/recipe.bhr` },
      ...(installDev ? [{ title: `install blackhole_dev ${manifest?.blackhole_dev_version} on the VM`, cmd: `ssh ${host.target} ${cmd.q(cmd.installWheel(venv, `${home}/wheels/${installDev.split("/").pop()}`))}` }] : []),
      { title: "start the pipeline in tmux so it survives disconnects", cmd: `ssh ${host.target} ${cmd.q(cmd.tmuxLaunch({ venv, dir, session }))}` },
    ];
    const estHours = plan?.estHours;
    const lp: LaunchPlan = {
      id: randomUUID(),
      recipePath,
      recipeName: manifest?.name ?? name,
      baseModel: manifest?.base_model,
      stages: manifest?.stages ?? [],
      bundle: bundlePath,
      sha256: sha,
      bundleBytes: bytes,
      jobName: name,
      jobDir: dir,
      tmux: session,
      host,
      checks,
      ok: !checks.some((c) => c.tone === "bad"),
      estHours,
      estCost: costLine(host.ratePerHour, host.currency, estHours),
      installDev,
      steps,
    };
    this.plans.set(lp.id, lp);
    return lp;
  }

  /** Runs a prepared plan after the human click. Returns null when the click was Cancel. */
  async launch(planId: string, o: LaunchOptions): Promise<JobRef | null> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("this check is out of date; check again");
    if (!plan.ok) throw new Error("a check failed; fix it and check again");
    const host = plan.host;
    const approved = await this.d.gate.confirm({
      action: "run.launch",
      title: `Run ${plan.recipeName} on ${host.label}`,
      why: "Starts the pipeline on your machine. The GPU time is billed by your provider at your rate, and the job keeps running when the app closes.",
      estCost: plan.estCost,
      details: [
        { label: "Machine", value: `${host.label} (${host.target})` },
        { label: "Job", value: plan.jobDir },
        { label: "Bundle", value: `${plan.sha256.slice(0, 12)} · ${fmtBytes(plan.bundleBytes)}` },
        ...(plan.baseModel ? [{ label: "Base model", value: plan.baseModel }] : []),
        ...(plan.installDev ? [{ label: "Installs", value: plan.installDev.split("/").pop() ?? "" }] : []),
        { label: "When done", value: o.pullWhenDone ? `copy the result to ${join(this.d.paths.models, plan.jobName)}` : "leave the result on the VM" },
      ],
      requestedBy: o.requestedBy ?? "user",
    });
    if (!approved) return null;
    // a plan is one approval: never run it twice
    this.plans.delete(planId);
    const say = this.vmLog("launch");
    const t = target(host);
    const p = this.homes.get(host.id);
    const venv = p?.venv ?? host.venv ?? "~/bh-venv";
    const home = p?.home ?? "~/.blackhole";
    const must = async (what: string, c: string, input?: string | Buffer) => {
      const r = await this.d.remote.exec(t, c, { input, timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error(`${what} failed: ${r.code === 255 ? explainSshError(r.stderr, r.code) : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return r.stdout;
    };
    const send = async (file: string, remote: string) => {
      if (p?.rsync !== false) {
        const r = await this.d.remote.rsync(cmd.rsyncPushArgs({ target: host.target, file, remote, sshArgs: this.d.remote.sshOptions(t) }));
        if (r.code === 0) return;
        say(`rsync failed (${r.stderr.trim().split("\n").pop()}); sending over ssh instead`);
      }
      const { readFileSync } = await import("node:fs");
      await must(`sending ${file.split("/").pop()}`, cmd.writeFile(remote), readFileSync(file));
    };

    say(`${host.label}: making ${plan.jobDir}`);
    await must("making the job folder", cmd.mkdirJob(plan.jobDir));
    say(`sending ${plan.bundle.split("/").pop()} (${fmtBytes(plan.bundleBytes)})`);
    await send(plan.bundle, `${plan.jobDir}/recipe.bhr`);
    const remoteSha = (await must("checking the bundle", cmd.sha256Of(`${plan.jobDir}/recipe.bhr`))).trim().split(/\s+/)[0];
    if (remoteSha !== plan.sha256) throw new Error(`the bundle arrived damaged (sha256 ${remoteSha.slice(0, 12)}, expected ${plan.sha256.slice(0, 12)}); nothing was started`);
    if (plan.installDev) {
      const wheel = `${home}/wheels/${plan.installDev.split("/").pop()}`;
      say(`installing ${wheel.split("/").pop()}`);
      await must("making the wheels folder", `mkdir -p ${cmd.q(home + "/wheels")}`);
      await send(plan.installDev, wheel);
      await must("installing blackhole_dev", cmd.installWheel(venv, wheel));
    }
    const launchInfo = {
      recipe: plan.recipeName, recipePath: plan.recipePath, sha256: plan.sha256, stages: plan.stages,
      tmux: plan.tmux, startedAt: this.now().getTime() / 1000, estHours: plan.estHours, by: "blackhole-dev-app",
    };
    await must("writing launch.json", cmd.writeFile(`${plan.jobDir}/launch.json`), JSON.stringify(launchInfo, null, 2) + "\n");
    say(`starting the pipeline in tmux session ${plan.tmux}`);
    await must("starting tmux", cmd.tmuxLaunch({ venv, dir: plan.jobDir, session: plan.tmux }));
    const ref: JobRef = { hostId: host.id, name: plan.jobName };
    this.d.settings.set("vm.lastHost", host.id);
    this.remember({ hostId: host.id, name: plan.jobName, dir: plan.jobDir, pullWhenDone: o.pullWhenDone, notify: o.notify, stages: plan.stages });
    this.watch(ref, { dir: plan.jobDir, stages: plan.stages, background: true });
    say(`started ${plan.jobName}`);
    return ref;
  }

  // ------------------------------------------------------------------ watching a job

  private remembered(): Remembered[] {
    return this.d.settings.get<Remembered[]>("vm.jobs", []);
  }

  private remember(r: Remembered): void {
    this.d.settings.set("vm.jobs", [...this.remembered().filter((x) => !(x.hostId === r.hostId && x.name === r.name)), r].slice(-100));
  }

  private patchRemembered(ref: JobRef, patch: Partial<Remembered>): void {
    this.d.settings.set("vm.jobs", this.remembered().map((x) => (x.hostId === ref.hostId && x.name === ref.name ? { ...x, ...patch } : x)));
  }

  /** Watches again what the app launched and has not finished with (after an app restart). */
  resumeWatches(): void {
    for (const r of this.remembered()) {
      if (!r.finished && (r.notify || r.pullWhenDone)) {
        try {
          this.watch({ hostId: r.hostId, name: r.name }, { dir: r.dir, stages: r.stages, background: true });
        } catch {
          /* the host is gone */
        }
      }
    }
  }

  /** Starts (or joins) the events.log tail of a job and returns its state so far. */
  watch(ref: JobRef, o: { dir?: string; stages?: string[]; background?: boolean } = {}): JobUpdate {
    const key = jobKey(ref);
    let w = this.watches.get(key);
    if (!w) {
      const host = this.d.hosts.get(ref.hostId);
      const home = this.homes.get(ref.hostId)?.home;
      const known = this.homes.get(ref.hostId)?.jobs.find((j) => j.name === ref.name);
      const dir = o.dir ?? known?.dir ?? cmd.jobDir(home ?? "~/.blackhole", ref.name);
      w = { ref, host, dir, state: emptyState(o.stages ?? known?.stages ?? []), offset: 0, split: new LineSplitter(), users: 0, link: "reconnecting", retry: 0, closed: false };
      this.watches.set(key, w);
      this.open(w);
    }
    if (!o.background) w.users++;
    return this.update(w);
  }

  unwatch(ref: JobRef): void {
    const w = this.watches.get(jobKey(ref));
    if (!w) return;
    w.users = Math.max(0, w.users - 1);
    const r = this.remembered().find((x) => x.hostId === ref.hostId && x.name === ref.name);
    const background = r && w.state.status === "running" && (r.notify || (r.pullWhenDone && !r.pulled));
    if (w.users === 0 && !background) this.close(w);
  }

  state(ref: JobRef): JobUpdate | null {
    const w = this.watches.get(jobKey(ref));
    return w ? this.update(w) : null;
  }

  private update(w: Watch): JobUpdate {
    return { job: w.ref, state: w.state, link: w.link, error: w.error };
  }

  private open(w: Watch): void {
    const t = target(w.host);
    w.stream = this.d.remote.stream(t, cmd.tailEvents(w.dir, w.offset), (chunk) => {
      w.link = "live";
      w.retry = 0;
      w.error = undefined;
      w.offset += Buffer.byteLength(chunk, "utf8");
      const lines = w.split.push(chunk).map(parseLine);
      if (lines.length) this.fold(w, lines);
      else this.flushSoon(w);
    }, (code, stderr) => {
      if (w.closed) return;
      w.stream = undefined;
      w.link = "reconnecting";
      w.error = code === 255 ? explainSshError(stderr, code) : stderr.trim().split("\n").pop() || undefined;
      const delays = this.d.backoff ?? [2000, 4000, 8000, 16000, 30000, 60000];
      const delay = delays[Math.min(w.retry++, delays.length - 1)];
      if (w.retry > 30) w.link = "offline";
      this.flushSoon(w);
      setTimeout(() => !w.closed && this.open(w), delay);
    });
  }

  private close(w: Watch): void {
    w.closed = true;
    w.stream?.close();
    clearTimeout(w.timer);
    this.watches.delete(jobKey(w.ref));
  }

  private fold(w: Watch, lines: ReturnType<typeof parseLine>[]): void {
    const before = w.state.status;
    w.state = reduce(w.state, lines);
    for (const l of lines) {
      if (l.kind === "event" && l.ev.status === "done" && (l.ev.gate != null || l.ev.gates != null)) this.notifyJob(w, `${l.ev.stage}: gate ${l.ev.gate_passed === false || l.ev.gates_passed === false ? "failed" : "passed"}`);
    }
    const after = w.state.status;
    if (before !== after && (after === "done" || after === "error" || after === "stopped")) this.finished(w);
    this.flushSoon(w);
  }

  private flushSoon(w: Watch): void {
    if (w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = undefined;
      this.d.send(CH.evJob, this.update(w));
    }, this.d.flushMs ?? 200);
  }

  private notifyJob(w: Watch, body: string): void {
    const r = this.remembered().find((x) => x.hostId === w.ref.hostId && x.name === w.ref.name);
    if (r?.notify) this.d.notify?.(`${w.ref.name} · ${w.host.label}`, body);
  }

  private finished(w: Watch): void {
    const s = w.state;
    const seen = this.remembered().find((x) => x.hostId === w.ref.hostId && x.name === w.ref.name);
    if (!seen || seen.finished) {
      if (w.users === 0) this.close(w);
      return;
    }
    this.patchRemembered(w.ref, { finished: true });
    const failed = s.stages.find((x) => x.status === "error");
    this.notifyJob(w, s.status === "done" ? `done${s.metrics.kl != null ? ` · KL ${s.metrics.kl}` : ""}` : s.status === "stopped" ? "stopped" : `failed${failed ? ` in ${failed.name}: ${failed.msg ?? ""}` : ""}`);
    if (s.status === "done" && seen.pullWhenDone && !seen.pulled) {
      // covered by the run's approval, which listed this copy
      this.pull(w.ref, { approved: true }).catch((e) => this.d.send(CH.evPull, { job: w.ref, pct: 0, line: "", error: (e as Error).message } satisfies PullProgress));
    }
    if (w.users === 0) this.close(w);
  }

  // ------------------------------------------------------------------ stop, copy back

  async stop(ref: JobRef): Promise<string> {
    const host = this.d.hosts.get(ref.hostId);
    const w = this.watches.get(jobKey(ref));
    const p = this.homes.get(ref.hostId);
    const dir = w?.dir ?? p?.jobs.find((j) => j.name === ref.name)?.dir ?? cmd.jobDir(p?.home ?? "~/.blackhole", ref.name);
    const session = p?.jobs.find((j) => j.name === ref.name)?.tmux ?? cmd.tmuxName(ref.name);
    const r = await this.d.remote.exec(target(host), cmd.stopJob(dir, session), { input: STOP_PY, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.code === 255 ? explainSshError(r.stderr, r.code) : (r.stderr || r.stdout).trim());
    return r.stdout.trim();
  }

  /** Copies <job>/out to this Mac (models folder by default). A large copy passes the gate unless the run's approval covered it. */
  async pull(ref: JobRef, o: { dest?: string; approved?: boolean; requestedBy?: "user" | "copilot" } = {}): Promise<{ approved: boolean; dest?: string }> {
    const host = this.d.hosts.get(ref.hostId);
    const t = target(host);
    const p = this.homes.get(ref.hostId);
    const dir = this.watches.get(jobKey(ref))?.dir ?? p?.jobs.find((j) => j.name === ref.name)?.dir ?? cmd.jobDir(p?.home ?? "~/.blackhole", ref.name);
    const dest = o.dest ?? join(this.d.paths.models, ref.name);
    const du = await this.d.remote.exec(t, `du -sLb ${cmd.q(dir + "/out")} 2>/dev/null | cut -f1`, { timeoutMs: 120_000 });
    const total = Number(du.stdout.trim()) || 0;
    if (!total) throw new Error(`${ref.name} has nothing in out/ yet`);
    if (!o.approved) {
      const ok = await this.d.gate.confirm({
        action: "download",
        title: `Copy ${ref.name} to this Mac`,
        why: "Copies the finished model folder from the VM. Some providers bill outgoing traffic.",
        estCost: fmtBytes(total),
        details: [{ label: "From", value: `${host.label}:${dir}/out/` }, { label: "To", value: dest }],
        requestedBy: o.requestedBy ?? "user",
      });
      if (!ok) return { approved: false };
    }
    mkdirSync(dest, { recursive: true });
    const prog = new RsyncProgress(total);
    let last = 0;
    const r = await this.d.remote.rsync(cmd.rsyncPullArgs({ target: host.target, dir, dest, sshArgs: this.d.remote.sshOptions(t) }), (line) => {
      const pct = prog.line(line);
      const now = Date.now();
      if (now - last > 300) {
        last = now;
        this.d.send(CH.evPull, { job: ref, pct: pct ?? 0, line: line.trim() } satisfies PullProgress);
      }
    });
    if (r.code !== 0) throw new Error(`rsync failed: ${r.stderr.trim().split("\n").pop()}`);
    this.patchRemembered(ref, { pulled: true });
    this.d.send(CH.evPull, { job: ref, pct: 100, line: "", done: true, dest } satisfies PullProgress);
    return { approved: true, dest };
  }

  // ------------------------------------------------------------------ copilot tools (WS4)
  // The copilot sends one object per gated action; the gate below still needs a human click.

  /** "b300", "b300-nebius" or "nebius:b300" -> an up spec; the default is the user's usual VM. */
  upSpec(preset?: string): UpSpec {
    const def = this.d.settings.get<UpSpec>("vm.defaultUp", { provider: "nebius", gpu: "b300" });
    if (!preset) return def;
    const parts = preset.toLowerCase().split(/[-:\s]+/).filter(Boolean);
    const provider = parts.find((x) => ["nebius", "evroc", "lambda"].includes(x)) ?? def.provider;
    const gpu = parts.find((x) => x !== provider && x !== "spot") ?? def.gpu;
    return { ...def, provider, gpu, spot: parts.includes("spot") || def.spot };
  }

  /** A host by id, label or target; else the one used last; else the only one. */
  resolveHost(name?: string): Host {
    const all = this.hosts();
    if (name) {
      const h = all.find((x) => x.id === name || x.label === name || x.target === name);
      if (!h) throw new Error(`no machine "${name}"; known: ${all.map((x) => x.label).join(", ") || "none"}`);
      return h;
    }
    const last = this.d.settings.get<string>("vm.lastHost", "");
    const h = all.find((x) => x.id === last) ?? (all.length === 1 ? all[0] : undefined);
    if (!h) throw new Error(`say which machine: ${all.map((x) => x.label).join(", ") || "none added yet"}`);
    return h;
  }

  async copilotUp(a: { preset?: string; why?: string }): Promise<{ approved: boolean; machine?: string }> {
    const r = await this.vmUp(this.upSpec(a.preset), "copilot");
    return { approved: r.approved, machine: r.name };
  }

  async copilotDown(a: { host?: string; why?: string }): Promise<{ approved: boolean; done?: boolean; message?: string }> {
    const h = this.resolveHost(a.host);
    // the copilot only ever stops; deleting a disk is the user's own click in the Machines view
    const r = await this.vmDown(h.id, { keepDisk: true }, "copilot");
    return { approved: r.approved, done: r.done, message: r.message };
  }

  async copilotLaunch(a: { recipe: string; host?: string; why?: string; pullWhenDone?: boolean }): Promise<{ approved: boolean; job?: string; host?: string; failed?: string[] }> {
    const h = this.resolveHost(a.host);
    const plan = await this.prepare(a.recipe, h.id);
    if (!plan.ok) return { approved: false, host: h.label, failed: plan.checks.filter((c) => c.tone === "bad").map((c) => `${c.label}: ${c.detail}`) };
    const ref = await this.launch(plan.id, { pullWhenDone: a.pullWhenDone ?? false, notify: true, requestedBy: "copilot" });
    return ref ? { approved: true, job: ref.name, host: h.label } : { approved: false };
  }

  /** ssh arguments for the shell's terminal: the TUI, the job's tmux session, or a shell. */
  terminalArgs(hostId: string, mode: "tui" | "attach" | "shell", job?: string): { cmd: string; args: string[]; title: string } {
    const h = this.d.hosts.get(hostId);
    const p = this.homes.get(hostId);
    // interactive: let ssh ask for a passphrase or host key in the terminal itself
    const opts = this.d.remote.sshOptions(target(h)).filter((x, i, a) => x !== "BatchMode=yes" && !(x === "-o" && a[i + 1] === "BatchMode=yes"));
    const session = (job && p?.jobs.find((j) => j.name === job)?.tmux) || (job ? cmd.tmuxName(job) : "");
    const remoteCmd = mode === "tui" ? cmd.tuiCommand(p?.venv ?? h.venv ?? null) : mode === "attach" && session ? cmd.attachCommand(session) : "bash -l";
    return { cmd: "ssh", args: ["-t", ...opts, h.target, remoteCmd], title: `${h.label} · ${mode === "tui" ? "blackhole" : mode === "attach" ? session : "shell"}` };
  }

  dispose(): void {
    for (const w of [...this.watches.values()]) this.close(w);
  }
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
