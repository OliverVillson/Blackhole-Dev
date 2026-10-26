// End to end over a real ssh connection: prepare, the gate, send, tmux launch, the events.log
// tail, stop and the copy back. Needs a host with a stand-in blackhole_pipeline:
//   BHD_TEST_SSH=bhtest@127.0.0.1:2222 npx vitest run src/vm
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ConfirmRequest } from "../../src/vm/ctx";
import { HostStore } from "../../src/vm/hosts";
import { JobsService, sha256File } from "../../src/vm/jobs";
import type { JobUpdate } from "../../src/vm/shared";
import { CH } from "../../src/vm/shared";
import { OpenSsh } from "../../src/vm/ssh";

const SPEC = process.env.BHD_TEST_SSH;

async function bundle(dir: string, name: string, stages: string[], speed: number) {
  const src = join(dir, name);
  mkdirSync(src, { recursive: true });
  const manifest = {
    format: "bhr/1", name, id: `blackhole/${name}`, version: "1.0.0", base_model: "Qwen/Qwen3-0.6B", target: "mac16",
    runner: "pipeline", stages, inputs: { speed }, needs: { gpu_gb: 80, disk_gb: 1 }, blackhole_dev_version: "0.1.0",
    files: {}, functions: [],
  };
  writeFileSync(join(src, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "recipe.py"), "from blackhole_dev.recipe import Recipe\n");
  const out = join(dir, `${name}.bhr`);
  execFileSync("tar", ["-czf", out, "-C", src, "manifest.json", "recipe.py"]);
  return { bundle: out, sha256: await sha256File(out), functions: [], manifest };
}

function service(approve: (r: ConfirmRequest) => boolean) {
  const store = new Map<string, unknown>();
  const settings = { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k: string, v: unknown) => void store.set(k, v) };
  const dir = mkdtempSync(join(tmpdir(), "bhd-ssh-"));
  const asked: ConfirmRequest[] = [];
  const updates: JobUpdate[] = [];
  const bundles = new Map<string, Awaited<ReturnType<typeof bundle>>>();
  const jobs = new JobsService({
    remote: new OpenSsh(),
    hosts: new HostStore(settings, { ssh: () => [], vms: () => [] }),
    gate: { confirm: async (r) => (asked.push(r), approve(r)) },
    helper: {
      call: async <T,>(method: string, p?: object): Promise<T> => {
        const path = (p as { path: string }).path;
        if (method === "recipe.lint") return { problems: [] } as T;
        if (method === "recipe.bundle") return bundles.get(path) as T;
        if (method === "recipe.plan") return { sizeGb: 9.8, fits: true, estHours: 3.5 } as T;
        throw new Error(method);
      },
    },
    send: (ch, p) => { if (ch === CH.evJob) updates.push(p as JobUpdate); if (ch === CH.evPull && (p as { error?: string }).error) console.error("pull", p); },
    settings,
    cloud: { run: async () => ({ code: 1, out: "" }) },
    paths: { models: join(dir, "models") },
    flushMs: 20,
    backoff: [200],
  });
  const host = jobs.addHost(SPEC!, "test-vm", join(process.env.HOME!, ".ssh", "id_ed25519"));
  jobs.updateHost(host.id, { ratePerHour: 4.5 });
  return { jobs, host, dir, asked, updates, bundles };
}

const until = async (what: string, ok: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!SPEC)("run on a real ssh host", () => {
  const made: JobsService[] = [];
  afterAll(() => made.forEach((j) => j.dispose()));

  it("checks, asks, runs, follows and copies back", async () => {
    const s = service(() => true);
    made.push(s.jobs);
    s.bundles.set("/w/qwen-mac-hex.py", await bundle(s.dir, "qwen-mac-hex", ["detect", "calibrate", "heal", "mlx", "package"], 0.05));
    const plan = await s.jobs.prepare("/w/qwen-mac-hex.py", s.host.id);
    expect(plan.checks.filter((c) => c.tone === "bad")).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.estCost).toBe("$4.50/h × ~3.5 h ≈ $15.75");
    expect(plan.jobDir).toMatch(/^\/home\/\w+\/\.blackhole\/jobs\/qwen-mac-hex-\d{4}-\d{6}$/);
    expect(plan.steps.map((x) => x.title)).toHaveLength(3);

    const ref = await s.jobs.launch(plan.id, { pullWhenDone: true, notify: false });
    expect(ref).not.toBeNull();
    expect(s.asked.map((a) => a.action)).toEqual(["run.launch"]);
    expect(s.asked[0].estCost).toBe(plan.estCost);
    // the same plan cannot run twice on one approval
    await expect(s.jobs.launch(plan.id, { pullWhenDone: false, notify: false })).rejects.toThrow(/out of date/);

    s.jobs.watch(ref!);
    const done = () => s.updates.filter((u) => u.job.name === ref!.name).at(-1);
    await until("job done", () => done()?.state.status === "done");
    const st = done()!.state;
    expect(st.stages.map((x) => `${x.name}:${x.status}`)).toEqual(["detect:done", "calibrate:done", "heal:done", "mlx:done", "package:done"]);
    expect(st.kl.length).toBe(8);
    expect(st.metrics.kl).toBe(0.0188);
    expect(st.model).toContain(`${ref!.name}/out`);

    // pullWhenDone: copied without a second question, covered by the run's approval
    const dest = join(s.dir, "models", ref!.name);
    await until("copy back", () => existsSync(join(dest, "model.safetensors")));
    expect(s.asked.map((a) => a.action)).toEqual(["run.launch"]);

    const listed = await s.jobs.listJobs(s.host.id);
    const mine = listed.find((j) => j.name === ref!.name)!;
    expect(mine).toMatchObject({ running: false, outcome: "done", hasOut: true, recipe: "blackhole/qwen-mac-hex" });
    expect(mine.stages).toEqual(["detect", "calibrate", "heal", "mlx", "package"]);
  }, 60000);

  it("starts nothing when the click is Cancel", async () => {
    const s = service(() => false);
    made.push(s.jobs);
    s.bundles.set("/w/r.py", await bundle(s.dir, "cancelled", ["detect"], 0.01));
    const plan = await s.jobs.prepare("/w/r.py", s.host.id);
    expect(await s.jobs.launch(plan.id, { pullWhenDone: false, notify: false })).toBeNull();
    const listed = await s.jobs.listJobs(s.host.id);
    expect(listed.find((j) => j.name === plan.jobName)).toBeUndefined();
  }, 30000);

  it("stops a running job and only that one", async () => {
    const s = service(() => true);
    made.push(s.jobs);
    s.bundles.set("/w/slow.py", await bundle(s.dir, "slow", ["detect", "heal", "mlx"], 2));
    const plan = await s.jobs.prepare("/w/slow.py", s.host.id);
    const ref = (await s.jobs.launch(plan.id, { pullWhenDone: false, notify: false }))!;
    s.jobs.watch(ref);
    const last = () => s.updates.filter((u) => u.job.name === ref.name).at(-1);
    await until("running", () => last()?.state.current === "detect");
    expect((await s.jobs.listJobs(s.host.id)).find((j) => j.name === ref.name)?.running).toBe(true);
    expect(await s.jobs.stop(ref)).toBe("stopped");
    await until("stopped event", () => last()?.state.status === "stopped");
    const j = (await s.jobs.listJobs(s.host.id)).find((x) => x.name === ref.name)!;
    expect(j).toMatchObject({ running: false, outcome: "stopped" });
  }, 60000);

  it("says why a bad check blocks the run", async () => {
    const s = service(() => true);
    made.push(s.jobs);
    const b = await bundle(s.dir, "huge", ["detect"], 0.01);
    b.manifest.needs = { gpu_gb: 1000, disk_gb: 1e6 };
    s.bundles.set("/w/huge.py", b);
    const plan = await s.jobs.prepare("/w/huge.py", s.host.id);
    expect(plan.ok).toBe(false);
    expect(plan.checks.filter((c) => c.tone === "bad").map((c) => c.id).sort()).toEqual(["disk", "gpu"]);
    await expect(s.jobs.launch(plan.id, { pullWhenDone: false, notify: false })).rejects.toThrow(/check failed/);
    expect(s.asked).toEqual([]);
  }, 30000);
});
