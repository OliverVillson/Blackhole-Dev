import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gate, type GateUi } from "../src/main/gate";
import type { ConfirmRequest } from "../src/shared/gate";

const req: ConfirmRequest = { action: "vm.up", title: "Start b300-nebius", why: "Run qwen-mac-hex", estCost: "[your VM rate] x ~3.5 h", requestedBy: "copilot" };
const ui = (answer: (id: string) => { approved: boolean; trusted: boolean }, delay = 20): GateUi => ({
  show: (r) => new Promise((res) => setTimeout(() => res({ id: r.id, ...answer(r.id) }), delay)),
});

describe("I4 confirm gate", () => {
  it("approves only a trusted click after the arm delay, and logs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const log = join(dir, "log.jsonl");
    const g = new Gate(ui(() => ({ approved: true, trusted: true })), log, 10);
    expect(await g.confirm(req)).toBe(true);
    expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({ action: "vm.up", requestedBy: "copilot", approved: true });
  });

  it("refuses untrusted (scripted) approvals", async () => {
    const g = new Gate(ui(() => ({ approved: true, trusted: false })), null, 10);
    expect(await g.confirm(req)).toBe(false);
  });

  it("refuses answers faster than the arm delay", async () => {
    const g = new Gate(ui(() => ({ approved: true, trusted: true }), 0), null, 500);
    expect(await g.confirm(req)).toBe(false);
  });

  it("refuses an answer for another request id", async () => {
    const g = new Gate({ show: (r) => Promise.resolve({ id: r.id + "x", approved: true, trusted: true }) }, null, 0);
    expect(await g.confirm(req)).toBe(false);
  });

  it("treats a closed window as cancel and rejects unknown actions", async () => {
    const g = new Gate({ show: () => Promise.reject(new Error("closed")) }, null, 0);
    expect(await g.confirm(req)).toBe(false);
    await expect(g.confirm({ ...req, action: "rm -rf" as never })).rejects.toThrow(/unknown action/);
  });

  it("shows one request at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    const g = new Gate({ show: (r) => { open++; maxOpen = Math.max(maxOpen, open); return new Promise((res) => setTimeout(() => { open--; res({ id: r.id, approved: true, trusted: true }); }, 15)); } }, null, 0);
    await Promise.all([g.confirm(req), g.confirm(req), g.confirm(req)]);
    expect(maxOpen).toBe(1);
  });
});
