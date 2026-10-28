// prepare() without a real host: which machine the checks and commands belong to, the shared recipe
// work when the pick changes mid-check, the plan's time limit, the base model row and the dev wheel.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostStore } from "../../src/vm/hosts";
import { baseModelCheck, DEFAULT_VENV, JobsService, PLAN_TIMEOUT_MS, sha256File } from "../../src/vm/jobs";
import type { Probe } from "../../src/vm/shared";

const probe = (o: Partial<Probe> = {}): Probe => ({
  home: "/home/u/.blackhole", venv: "/home/u/.blackhole/venv", pipeline: true, recipeFlag: true, blackholeDev: "0.1.0",
  tmux: true, rsync: true, gpus: [{ name: "NVIDIA B300", memGb: 269, usedGb: 0, util: 0 } as never], diskFreeGb: 1290, diskTotalGb: 1500,
  jobs: [], hfToken: false, models: [], ...o,
});

async function service(o: { probes: Record<string, Probe | Error>; plan?: (timeoutMs?: number) => Promise<unknown>; wheel?: () => Promise<{ path: string; version: string } | null> }) {
  const dir = mkdtempSync(join(tmpdir(), "bhd-prep-"));
  const bhr = join(dir, "r.bhr");
  writeFileSync(bhr, "bundle");
  const manifest = { format: "bhr/1", name: "first-recipe", base_model: "Qwen/Qwen3-30B-A3B", target: "mac16", runner: "pipeline",
    stages: ["detect"], needs: { gpu_gb: 80, disk_gb: 233 }, blackhole_dev_version: "0.1.0", functions: [{}] };
  const store = new Map<string, unknown>();
  const settings = { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k: string, v: unknown) => void store.set(k, v) };
  const calls: string[] = [];
  const execs: string[] = [];
  const jobs = new JobsService({
    remote: {
      exec: async (t, cmd) => {
        execs.push(t.target);
        const p = o.probes[t.target];
        if (p instanceof Error) return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: JSON.stringify(p), stderr: "" };
      },
      stream: () => { throw new Error("no"); },
      rsync: async () => ({ code: 0, stdout: "", stderr: "" }),
      sshOptions: () => [],
    },
    hosts: new HostStore(settings, { ssh: () => [], vms: () => [] }),
    gate: { confirm: async () => true },
    helper: {
      call: async <T,>(method: string, _p?: object, timeoutMs?: number): Promise<T> => {
        calls.push(method);
        if (method === "recipe.lint") return { problems: [] } as T;
        if (method === "recipe.bundle") return { bundle: bhr, sha256: await sha256File(bhr), functions: [], manifest } as T;
        if (method === "recipe.plan") return (await (o.plan ?? (async () => ({ sizeGb: 12.6, fits: false, estHours: 2 })))(timeoutMs)) as T;
        throw new Error(method);
      },
    },
    send: () => {},
    settings,
    cloud: { run: async () => ({ code: 1, out: "" }) },
    paths: { models: join(dir, "models") },
    devWheel: o.wheel,
  });
  const orb = jobs.addHost("orb", "orb");
  const reaper = jobs.addHost("oliver-reaper@204.12.178.65");
  return { jobs, orb, reaper, calls, execs };
}

describe("prepare", () => {
  it("checks and commands follow the machine asked for, and a second pick shares the recipe work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = await service({ probes: { orb: new Error("down"), "oliver-reaper@204.12.178.65": probe() }, plan: async () => (await gate, { sizeGb: 12.6, fits: false, estHours: 2 }) });
    const first = s.jobs.prepare("/w/first-recipe.py", s.orb.id);
    await new Promise((r) => setTimeout(r, 20));
    const second = s.jobs.prepare("/w/first-recipe.py", s.reaper.id);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(s.calls.filter((c) => c === "recipe.plan")).toHaveLength(1);
    expect(s.calls.filter((c) => c === "recipe.bundle")).toHaveLength(1);
    expect(a.host.id).toBe(s.orb.id);
    expect(a.checks.find((c) => c.id === "ssh")?.detail).toMatch(/probe failed on orb \(orb\), exit 1: no output/);
    expect(b.host.id).toBe(s.reaper.id);
    expect(b.checks.find((c) => c.id === "ssh")).toMatchObject({ tone: "ok", detail: "oliver-reaper@204.12.178.65" });
    expect(b.steps.every((st) => st.cmd.includes("oliver-reaper@204.12.178.65") && !/\borb\b/.test(st.cmd))).toBe(true);
    expect(b.steps.at(-1)!.cmd).toContain("/home/u/.blackhole/venv/bin/activate");
    expect(b.steps.at(-1)!.cmd).toContain("$HOME/.local/bin/blackhole");
    expect(b.ok).toBe(true);
  });

  it("gives the plan a short limit and lets the run go ahead without an estimate", async () => {
    let limit: number | undefined;
    const s = await service({ probes: { "oliver-reaper@204.12.178.65": probe() }, plan: async (t) => { limit = t; throw new Error("recipe.plan timed out after 45s"); } });
    const lp = await s.jobs.prepare("/w/first-recipe.py", s.reaper.id);
    expect(limit).toBe(PLAN_TIMEOUT_MS);
    const c = lp.checks.find((x) => x.id === "plan")!;
    expect(c.tone).toBe("warn");
    expect(c.detail).toMatch(/Qwen\/Qwen3-30B-A3B's headers took over 45s.*can still go ahead/);
    expect(lp.ok).toBe(true);
    expect(lp.estHours).toBeUndefined();
  });

  it("installs blackhole_dev from a wheel built on this Mac when the VM lacks it", async () => {
    const s = await service({ probes: { "oliver-reaper@204.12.178.65": probe({ blackholeDev: null }) }, wheel: async () => ({ path: "/tmp/w/blackhole_dev-0.1.0-py3-none-any.whl", version: "0.1.0" }) });
    const lp = await s.jobs.prepare("/w/first-recipe.py", s.reaper.id);
    expect(lp.checks.find((x) => x.id === "blackhole-dev")).toMatchObject({ tone: "info", detail: "missing; installs 0.1.0 first" });
    expect(lp.installDev).toBe("/tmp/w/blackhole_dev-0.1.0-py3-none-any.whl");
    expect(lp.steps.some((st) => st.cmd.includes("pip install") && st.cmd.includes("blackhole_dev-0.1.0-py3-none-any.whl"))).toBe(true);
    const none = await service({ probes: { "oliver-reaper@204.12.178.65": probe({ blackholeDev: null }) }, wheel: async () => null });
    const bad = await none.jobs.prepare("/w/first-recipe.py", none.reaper.id);
    expect(bad.checks.find((x) => x.id === "blackhole-dev")?.tone).toBe("bad");
  });

  it("falls back to the installer's venv when the probe could not say", () => {
    expect(DEFAULT_VENV).toBe("~/.blackhole/venv");
  });
});

describe("base model row", () => {
  const m = "Qwen/Qwen3-30B-A3B";
  it("says when it is already on the VM", () => {
    expect(baseModelCheck(m, undefined, probe({ models: [m] }))).toMatchObject({ tone: "ok", detail: `${m} · already on the VM` });
  });
  it("says a public model needs no token", () => {
    expect(baseModelCheck(m, { gated: false, baseGb: 61.1 }, probe())).toMatchObject({ tone: "info", detail: `${m} · downloads on the VM (~61 GB, public, no Hugging Face token needed)` });
  });
  it("stops a gated model on a VM without a token", () => {
    const c = baseModelCheck("meta-llama/Llama-3.1-8B", { gated: true }, probe());
    expect(c.tone).toBe("bad");
    expect(c.detail).toMatch(/hf auth login/);
    expect(baseModelCheck("meta-llama/Llama-3.1-8B", { gated: true }, probe({ hfToken: true })).tone).toBe("info");
  });
  it("warns when it could not tell and the VM has no token", () => {
    expect(baseModelCheck(m, undefined, probe()).tone).toBe("warn");
    expect(baseModelCheck(m, undefined, probe({ hfToken: true })).tone).toBe("info");
  });
});
