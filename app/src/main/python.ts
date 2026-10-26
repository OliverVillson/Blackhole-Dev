// Which Python runs the helper: the user's setting, else the runtime bundled in the app,
// else python3 on PATH.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

export function pickPython(setting: string | undefined, resourcesPath: string | undefined): string {
  if (setting && setting.trim()) return setting.trim();
  if (resourcesPath) {
    const bundled = join(resourcesPath, "python", "bin", "python3");
    if (existsSync(bundled)) return bundled;
  }
  return "python3";
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function run(cmd: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || (err ? err.message : "")).toString().trim() });
    });
  });
}

/** First-run checks shown in the OUTPUT panel and on the Welcome tab. */
export async function runChecks(python: string): Promise<Check[]> {
  const py = await run(python, ["-c", "import sys; print(sys.version.split()[0])"]);
  const dev = py.ok
    ? await run(python, ["-c", "import blackhole_dev; print(getattr(blackhole_dev, '__version__', '?'))"])
    : { ok: false, out: "" };
  const ssh = await run("ssh", ["-V"]);
  const rsync = await run("rsync", ["--version"]);
  return [
    { id: "python", label: "Python", ok: py.ok, detail: py.ok ? `${python} · ${py.out}` : `${python} not found`, fix: "Set Settings > Python path, or install Python 3.11+" },
    { id: "blackhole_dev", label: "blackhole_dev package", ok: dev.ok, detail: dev.ok ? `version ${dev.out}` : dev.out.split("\n").pop() || "not importable", fix: `${python} -m pip install blackhole-dev` },
    { id: "ssh", label: "ssh", ok: ssh.ok, detail: ssh.out.split("\n")[0] || "not found", fix: "macOS ships ssh; check PATH" },
    { id: "rsync", label: "rsync", ok: rsync.ok, detail: rsync.out.split("\n")[0] || "not found", fix: "brew install rsync" },
  ];
}
