// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyState, parseLine, reduce } from "../../src/vm/events";
import type { JobUpdate, LaunchPlan } from "../../src/vm/shared";
import { JobMonitor } from "../../src/vm/ui/JobMonitor";
import { RunOnVm } from "../../src/vm/ui/RunOnVm";

afterEach(cleanup);
const host = { id: "ssh:b300", label: "b300", kind: "ssh" as const, target: "u@b300", source: "ssh-config" as const, ratePerHour: 6.1, currency: "$" };
const plan: LaunchPlan = {
  id: "p1", recipePath: "/w/r.py", recipeName: "r", stages: ["detect"], bundle: "/tmp/r.bhr", sha256: "ab", bundleBytes: 1000,
  jobName: "r-1026-101803", jobDir: "/home/u/.blackhole/jobs/r-1026-101803", tmux: "bh-r", host, ok: true, estHours: 3.5,
  estCost: "$6.10/h × ~3.5 h ≈ $21.35", checks: [{ id: "lint", label: "Recipe lint", tone: "ok", detail: "0 problems" }],
  steps: [{ title: "start the pipeline in tmux", cmd: "ssh u@b300 'tmux new-session ...'" }],
};
function fakeApi(over: Record<string, unknown> = {}) {
  const noop = () => () => {};
  return {
    hosts: vi.fn(async () => [host]), prepare: vi.fn(async () => plan), launch: vi.fn(async () => ({ hostId: host.id, name: plan.jobName })),
    onHosts: noop, onLog: noop, onJob: noop, onPull: noop, addHost: vi.fn(), updateHost: vi.fn(), offer: vi.fn(), up: vi.fn(),
    exportBundle: vi.fn(), watch: vi.fn(), unwatch: vi.fn(async () => {}), stop: vi.fn(), pull: vi.fn(), ...over,
  } as any;
}

describe("Run on VM dialog", () => {
  it("shows the checks, the exact commands and the cost, then launches on click", async () => {
    const api = fakeApi();
    const launched = vi.fn();
    render(<RunOnVm api={api} recipe="/w/r.py" close={() => {}} onLaunched={launched} />);
    await screen.findByText("0 problems");
    expect(api.prepare).toHaveBeenCalledWith("/w/r.py", "ssh:b300");
    expect(screen.getByText(/≈ \$6\.10\/h × ~3\.5 h ≈ \$21\.35/)).toBeTruthy();
    expect(screen.getByText(/tmux new-session/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Run on b300 ▸")));
    expect(api.launch).toHaveBeenCalledWith("p1", { pullWhenDone: true, notify: true });
    expect(launched).toHaveBeenCalledWith({ hostId: "ssh:b300", name: plan.jobName });
  });
  it("keeps Run disabled when a check failed", async () => {
    const api = fakeApi({ prepare: vi.fn(async () => ({ ...plan, ok: false, checks: [{ id: "gpu", label: "GPU", tone: "bad", detail: "nvidia-smi sees no GPU" }] })) });
    render(<RunOnVm api={api} recipe="/w/r.py" close={() => {}} onLaunched={() => {}} />);
    await screen.findByText("nvidia-smi sees no GPU");
    expect((screen.getByText("Run on b300 ▸") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Job monitor", () => {
  it("draws stages, the KL chart and the events", async () => {
    const lines = [
      { stage: "pipeline", status: "running", ts: 100 },
      { stage: "detect", status: "done", pct: 100, ts: 101, msg: "qwen3_moe" },
      { stage: "heal", status: "running", pct: 30, ts: 102, msg: "distil step 8: held-out KL 0.0195 (start 0.0195, best 0.0195 at step 8)" },
      { stage: "heal", status: "running", pct: 60, ts: 103, msg: "distil step 16: held-out KL 0.0191 (start 0.0195, best 0.0191 at step 16)" },
    ].map((e) => parseLine(JSON.stringify(e)));
    const u: JobUpdate = { job: { hostId: "ssh:b300", name: "j" }, state: reduce(emptyState(["detect", "heal", "mlx"]), lines), link: "live" };
    const api = fakeApi({ watch: vi.fn(async () => u) });
    render(<JobMonitor api={api} tab={{ job: u.job, hostLabel: "b300" }} openTerminal={() => {}} ask={async () => true} />);
    await screen.findByText("0.0191", { selector: ".big" });
    expect(screen.getByText("heal 60%", { selector: "b" })).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Held-out KL from 0.0195 at step 8 to 0.0191 at step 16, 2 readings");
    expect(screen.getByText("Stop job")).toBeTruthy();
  });
});
