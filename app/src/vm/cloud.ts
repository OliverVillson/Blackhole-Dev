// `blackhole up` / `blackhole down` from the app: the harness's own cloud code (blackhole.cloud,
// Nebius by default) run by the app's Python, its output streamed into the VM log. The app adds
// nothing to how VMs are rented; it only puts the human confirm gate in front.

import { spawn } from "node:child_process";
import type { VmOffer } from "./shared";

export interface CloudRunner {
  /** Runs `python -m blackhole.cloud.cli <args>`; resolves with the exit code and all output. */
  run(args: string[], onLine: (line: string) => void): Promise<{ code: number; out: string }>;
}

export function pythonCloud(python: () => string, env: () => NodeJS.ProcessEnv = () => process.env): CloudRunner {
  return {
    run(args, onLine) {
      return new Promise((resolve) => {
        const p = spawn(python(), ["-u", "-m", "blackhole.cloud.cli", ...args], {
          env: { ...env(), PYTHONUNBUFFERED: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let buf = "";
        const take = (d: string) => {
          out += d;
          buf += d;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const l of parts) onLine(l);
        };
        p.stdout.setEncoding("utf8").on("data", take);
        p.stderr.setEncoding("utf8").on("data", take);
        p.on("error", (e) => resolve({ code: 127, out: `${e.message}: is the BlackHole-Harness package installed for ${python()}?` }));
        p.on("close", (code) => {
          if (buf) onLine(buf);
          resolve({ code: code ?? 1, out });
        });
      });
    },
  };
}

export interface UpSpec { provider: string; gpu: string; spot?: boolean; disk?: number; label?: string }

function upArgs(s: UpSpec): string[] {
  return ["up", "--provider", s.provider, "--gpu", s.gpu, ...(s.spot ? ["--spot"] : []),
    ...(s.disk ? ["--disk", String(s.disk)] : []), ...(s.label ? ["--label", s.label] : [])];
}

/** The offer line `blackhole up` prints before renting (it rents nothing without --yes). */
export async function offer(cloud: CloudRunner, s: UpSpec): Promise<VmOffer> {
  const lines: string[] = [];
  const r = await cloud.run(upArgs(s), (l) => lines.push(l));
  const line = lines.find((l) => l.includes("·")) ?? "";
  if (r.code !== 0 || !line) throw new Error(lines.filter((l) => l.trim()).pop()?.replace(/^✗\s*/, "") || "no offer");
  const price = /([$€£])\s?([0-9]+(?:\.[0-9]+)?)\/h/.exec(line);
  const note = lines.find((l) => l.startsWith("  "))?.trim();
  return { line, note, usdPerHour: price ? Number(price[2]) : undefined };
}

export async function up(cloud: CloudRunner, s: UpSpec, onLine: (l: string) => void): Promise<{ name?: string }> {
  const r = await cloud.run([...upArgs(s), "--yes"], onLine);
  const name = /^(bh-[a-z0-9-]+) is up at/m.exec(r.out)?.[1];
  if (r.code !== 0) throw new Error(r.out.trim().split("\n").pop()?.replace(/^✗\s*/, "") || "blackhole up failed");
  return { name };
}

export async function resume(cloud: CloudRunner, name: string, onLine: (l: string) => void): Promise<void> {
  const r = await cloud.run(["up", "--resume", name], onLine);
  if (r.code !== 0) throw new Error(r.out.trim().split("\n").pop()?.replace(/^✗\s*/, "") || "resume failed");
}

/** Drops the record only (`blackhole down NAME --forget`); the VM, if it exists, keeps running. */
export async function forget(cloud: CloudRunner, name: string, onLine: (l: string) => void): Promise<string> {
  const r = await cloud.run(["down", name, "--forget"], onLine);
  const lines = r.out.trim().split("\n");
  if (r.code !== 0) throw new Error(lines.pop()?.replace(/^✗\s*/, "") || "blackhole down --forget failed");
  return lines[0] ?? `forgot ${name}`;
}

export interface DownResult { done: boolean; blockedBy?: string[]; message: string }

/** stop (keepDisk) or delete. A delete with models still on the VM is refused by `down` itself unless force. */
export async function down(cloud: CloudRunner, name: string, o: { keepDisk?: boolean; force?: boolean }, onLine: (l: string) => void): Promise<DownResult> {
  const r = await cloud.run(["down", name, ...(o.keepDisk ? ["--keep-disk"] : []), ...(o.force ? ["--yes"] : [])], onLine);
  const lines = r.out.trim().split("\n");
  if (r.code !== 0) throw new Error(lines.pop()?.replace(/^✗\s*/, "") || "blackhole down failed");
  const blocked = lines.findIndex((l) => l.includes("still has models"));
  if (blocked >= 0) {
    const outs = lines.slice(blocked + 1).filter((l) => l.startsWith("  ")).map((l) => l.trim());
    return { done: false, blockedBy: outs, message: lines[blocked] };
  }
  return { done: true, message: lines.pop() ?? "" };
}
