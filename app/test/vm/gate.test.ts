// The confirm gate sits in main, in front of every action that costs money, whoever calls.
import { describe, expect, it } from "vitest";
import type { ConfirmRequest } from "../../src/vm/ctx";
import { HostStore } from "../../src/vm/hosts";
import { JobsService } from "../../src/vm/jobs";
import type { Remote } from "../../src/vm/ssh";

function make(approve: boolean) {
  const store = new Map<string, unknown>();
  const settings = { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k: string, v: unknown) => void store.set(k, v) };
  const cloudCalls: string[][] = [];
  const execs: string[] = [];
  const asked: ConfirmRequest[] = [];
  const remote: Remote = {
    exec: async (_t, c) => (execs.push(c), { code: 0, stdout: "123456\n", stderr: "" }),
    stream: () => ({ close() {} }),
    rsync: async () => ({ code: 0, stdout: "", stderr: "" }),
    sshOptions: () => [],
  };
  const jobs = new JobsService({
    remote,
    hosts: new HostStore(settings, {
      ssh: () => [{ id: "ssh:box", label: "box", kind: "ssh", target: "u@box", source: "ssh-config" }],
      vms: () => [{ id: "vm:bh-1", label: "bh-1", kind: "vm", target: "u@1.2.3.4", source: "blackhole-up", state: "running", ratePerHour: 8.5 }],
    }),
    gate: { confirm: async (r) => (asked.push(r), approve) },
    helper: { call: async () => { throw new Error("unused"); } },
    send: () => {},
    settings,
    cloud: {
      run: async (args, on) => {
        cloudCalls.push(args);
        const out = args[0] === "up" && !args.includes("--yes") ? "nebius · 1x B300 (x) · us-central1 · $8.50/h on-demand" : "bh-1 stopped";
        on(out);
        return { code: 0, out };
      },
    },
    paths: { models: "/tmp/m" },
  });
  return { jobs, cloudCalls, execs, asked };
}

describe("the confirm gate", () => {
  it("rents nothing when vm.up is declined, and shows the price it asked about", async () => {
    const s = make(false);
    expect(await s.jobs.vmUp({ provider: "nebius", gpu: "b300" })).toEqual({ approved: false });
    expect(s.cloudCalls.every((a) => !a.includes("--yes"))).toBe(true);
    expect(s.asked[0]).toMatchObject({ action: "vm.up", estCost: "$8.50/h until stopped", requestedBy: "user" });
  });
  it("stops nothing when vm.down is declined", async () => {
    const s = make(false);
    expect((await s.jobs.vmDown("vm:bh-1", { keepDisk: true })).approved).toBe(false);
    expect(s.cloudCalls.filter((a) => a[0] === "down")).toEqual([]);
  });
  it("lets the copilot only stop a VM, never delete it", async () => {
    const s = make(true);
    await s.jobs.copilotDown({ host: "bh-1", keepDisk: false } as { host: string });
    expect(s.cloudCalls.at(-1)).toEqual(["down", "bh-1", "--keep-disk"]);
    expect(s.asked[0].requestedBy).toBe("copilot");
  });
  it("copies nothing back when the download is declined", async () => {
    const s = make(false);
    expect(await s.jobs.pull({ hostId: "ssh:box", name: "j" })).toEqual({ approved: false });
    expect(s.asked[0]).toMatchObject({ action: "download", estCost: "123 KB" });
  });
  it("refuses down on a host blackhole up did not make", async () => {
    await expect(make(true).jobs.vmDown("ssh:box", { keepDisk: true })).rejects.toThrow(/not started by blackhole up/);
  });
});
