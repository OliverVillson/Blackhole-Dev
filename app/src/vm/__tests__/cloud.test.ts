import { describe, expect, it } from "vitest";
import * as cloud from "../cloud";

// Output as blackhole.cloud.cli prints it (Offer.line(), up(), down())
function fake(outputs: Record<string, { code: number; out: string }>) {
  const calls: string[][] = [];
  const runner: cloud.CloudRunner = {
    async run(args, onLine) {
      calls.push(args);
      const key = args.includes("--yes") ? args[0] + "!" : args[0];
      const r = outputs[key];
      r.out.split("\n").forEach(onLine);
      return r;
    },
  };
  return { runner, calls };
}

const OFFER = "nebius · 1x B300 (gpu-b300-sxm/1gpu-20vcpu-224gb) · us-central1 · $8.50/h on-demand + 500 GB disk\n  B300 needs driver 580\nnothing rented. Add --yes to rent it.";

describe("blackhole up", () => {
  it("reads the offer without renting", async () => {
    const f = fake({ up: { code: 0, out: OFFER } });
    const o = await cloud.offer(f.runner, { provider: "nebius", gpu: "b300" });
    expect(o).toEqual({ line: OFFER.split("\n")[0], note: "B300 needs driver 580", usdPerHour: 8.5 });
    expect(f.calls[0]).not.toContain("--yes");
  });
  it("returns the new machine's name", async () => {
    const f = fake({ "up!": { code: 0, out: OFFER.split("\n")[0] + "\nbh-b300-1f2e is up at ubuntu@1.2.3.4; installing\nready." } });
    expect(await cloud.up(f.runner, { provider: "nebius", gpu: "b300" }, () => {})).toEqual({ name: "bh-b300-1f2e" });
  });
  it("passes the harness's error on", async () => {
    const f = fake({ up: { code: 1, out: "✗ no nebius CLI: install it and run `nebius profile create`" } });
    await expect(cloud.offer(f.runner, { provider: "nebius", gpu: "b300" })).rejects.toThrow("no nebius CLI");
  });
});

describe("blackhole down", () => {
  it("reports models that would be lost", async () => {
    const f = fake({ down: { code: 0, out: "bh-1 still has models that deleting would lose:\n  /home/ubuntu/.blackhole/jobs/j/out\ncopy them off first: rsync ..." } });
    const r = await cloud.down(f.runner, "bh-1", {}, () => {});
    expect(r).toMatchObject({ done: false, blockedBy: ["/home/ubuntu/.blackhole/jobs/j/out"] });
  });
  it("stops with --keep-disk", async () => {
    const f = fake({ down: { code: 0, out: "bh-1 stopped; the disk and the models on it are kept (and billed)." } });
    expect((await cloud.down(f.runner, "bh-1", { keepDisk: true }, () => {})).done).toBe(true);
    expect(f.calls[0]).toEqual(["down", "bh-1", "--keep-disk"]);
  });
});
