// I6 jobs API: the types main and renderer share, and the channel names.
// Everything here is plain data so it crosses the window.bh bridge unchanged.

/** Where to delete a VM by hand (the same list `blackhole down` prints). */
export const CONSOLES: { provider: string; url: string }[] = [
  { provider: "nebius", url: "https://console.nebius.com" },
  { provider: "evroc", url: "https://cloud.evroc.com" },
  { provider: "lambda", url: "https://cloud.lambda.ai/instances" },
];

/** What Forget did: the machine left the list, the VM itself (if any) was not touched. */
export interface ForgetResult { label: string; message: string; consoles: { provider: string; url: string }[] }

/** A machine the app can run on. */
export interface Host {
  id: string;                 // "ssh:<alias>", "app:<user@host>", "vm:<machine name>"
  label: string;
  kind: "ssh" | "vm";         // vm = rented by `blackhole up`, so the app can also stop or delete it
  target: string;             // what ssh gets: an alias from ~/.ssh/config or user@host
  port?: number;
  identityFile?: string;
  /** blackhole-host: recorded by `blackhole up --host` (set up by the harness, not rented by it). */
  source: "ssh-config" | "app" | "blackhole-up" | "blackhole-host";
  /** The user's own hourly rate for this machine (the app never bills). A VM made by `blackhole up` carries the provider's price. */
  ratePerHour?: number;
  currency?: string;
  gpu?: string;
  provider?: string;
  state?: "creating" | "running" | "stopped";
  /** Where the harness venv is; found by the probe when unset. */
  venv?: string;
}

export interface Gpu { name: string; memGb: number; usedGb: number; util: number }

/** What a host has, from one ssh round trip (remote/probe.ts). */
export interface Probe {
  home: string;               // BLACKHOLE_HOME on the machine
  venv: string | null;        // the venv blackhole_pipeline imports from
  pipeline: boolean;
  recipeFlag: boolean;        // blackhole_pipeline takes --recipe
  blackholeDev: string | null; // blackhole_dev.__version__ there, null when missing
  tmux: boolean;
  rsync: boolean;
  gpus: Gpu[];
  diskFreeGb: number;
  diskTotalGb: number;
  jobs: RemoteJob[];
  hfToken?: boolean;          // a Hugging Face token is set up for this user (HF_TOKEN or the hf login file)
  models?: string[];          // Hub ids already downloaded to the pipeline's models folder
}

export interface RemoteJob {
  name: string;
  dir: string;
  model?: string;
  recipe?: string;            // schema id or recipe name
  stages?: string[];          // config.json stage_list, so the monitor can draw stages before events arrive
  running: boolean;
  pids: number[];
  tmux?: string;              // the tmux session the app started it in
  startedAt?: number;         // s since epoch
  updatedAt?: number;
  estHours?: number;          // the plan's estimate, when the app launched it
  last?: JobEvent;            // the last JSON event in events.log
  outcome?: "done" | "error" | "stopped";
  hasOut: boolean;
}

/** One pipeline event: REAPer's progress protocol line. Extra keys (kl, top1, size_gb, lcb_*) pass through. */
export interface JobEvent {
  stage: string;
  status: "running" | "done" | "error" | "skipped";
  ts?: number;
  pct?: number;
  msg?: string;
  [extra: string]: unknown;
}

export type LogLine =
  | { kind: "event"; ev: JobEvent }
  | { kind: "text"; text: string };

export type StageStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface StageState {
  name: string;
  status: StageStatus;
  pct: number;
  msg?: string;
  startedAt?: number;
  endedAt?: number;
  /** Measurements a stage reported when done (kl, top1, size_gb, ...). */
  result?: Record<string, number | string>;
}

export interface KlPoint { step: number; kl: number; stage: string; phase?: string }

export interface JobState {
  status: "pending" | "running" | "done" | "error" | "stopped";
  stages: StageState[];
  current?: string;
  kl: KlPoint[];
  /** Latest value of each measurement any stage reported. */
  metrics: Record<string, number | string>;
  gatesPassed?: boolean;
  startedAt?: number;
  updatedAt?: number;
  model?: string;             // the finished model path the pipeline reported
  lines: LogLine[];           // newest last, capped
}

export interface JobRef { hostId: string; name: string }
export const jobKey = (j: JobRef) => `${j.hostId}::${j.name}`;

/** Row in the Run on VM dialog's checks list. */
export interface Check {
  id: "lint" | "plan" | "bundle" | "ssh" | "pipeline" | "recipe-flag" | "blackhole-dev" | "gpu" | "disk" | "busy" | "model";
  label: string;
  tone: "ok" | "warn" | "bad" | "info";
  detail: string;
}

/** What the dialog shows before anything runs, and what launch then does, step for step. */
export interface LaunchPlan {
  id: string;
  recipePath: string;
  recipeName: string;
  baseModel?: string;
  stages: string[];
  bundle: string;             // the local .bhr
  sha256: string;
  bundleBytes: number;
  jobName: string;
  jobDir: string;             // on the host
  tmux: string;
  host: Host;
  checks: Check[];
  ok: boolean;                // no "bad" check
  estHours?: number;
  estCost?: string;           // "$4.50/h x ~3.5 h ≈ $15.75" or "[your VM hourly rate] x ~3.5 h"
  installDev?: string;        // a wheel to install first, when the host lacks blackhole_dev or has another version
  steps: { title: string; cmd: string }[];   // the command preview, exactly what runs
}

export interface LaunchOptions { pullWhenDone: boolean; notify: boolean; requestedBy?: "user" | "copilot" }

/** What the job monitor gets pushed: the folded state, and the new lines since the last push. */
export interface JobUpdate { job: JobRef; state: JobState; link: "live" | "reconnecting" | "offline"; error?: string }

export interface VmOffer { line: string; note?: string; usdPerHour?: number }

export interface PullProgress { job: JobRef; pct: number; line: string; done?: boolean; error?: string; dest?: string }

/** Channels registered with ctx.handle (renderer -> main) and pushed with ctx.send (main -> renderer). */
export const CH = {
  hostsList: "vm:hosts.list",
  hostsAdd: "vm:hosts.add",
  hostsUpdate: "vm:hosts.update",
  hostsRemove: "vm:hosts.remove",
  hostsTest: "vm:hosts.test",
  hostsForget: "vm:hosts.forget",
  vmOffer: "vm:vm.offer",
  vmUp: "vm:vm.up",
  vmDown: "vm:vm.down",
  jobPrepare: "vm:job.prepare",
  jobLaunch: "vm:job.launch",
  jobList: "vm:job.list",
  jobWatch: "vm:job.watch",
  jobUnwatch: "vm:job.unwatch",
  jobState: "vm:job.state",
  jobStop: "vm:job.stop",
  jobPull: "vm:job.pull",
  jobExport: "vm:job.export",
  terminalArgs: "vm:terminal.args",
  // the copilot's gated tools (WS4): one object in, a small result out
  copilotUp: "vm:copilot.up",          // { preset?, why, requestedBy } -> { approved, machine? }
  copilotDown: "vm:copilot.down",      // { host?, keepDisk?, why, requestedBy } -> { approved, done?, message? }
  copilotLaunch: "vm:copilot.launch",  // { recipe, host?, why, requestedBy } -> { approved, job?, host?, failed? }
  // pushed to the renderer
  evJob: "vm:event.job",        // JobUpdate
  evLog: "vm:event.log",        // { scope: "vm.up" | "vm.down" | "launch", text }
  evPull: "vm:event.pull",      // PullProgress
  evHosts: "vm:event.hosts",    // Host[]
} as const;
