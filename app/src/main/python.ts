// Which Python runs the helper: the user's setting, else the runtime bundled in the app, else a
// venv where blackhole_dev is usually installed (the active one, ~/bhdev-venv), else python3 on PATH.
// The checks, the helper and the VM module's wheel build all use this one answer.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

/** Venvs a source checkout is set up with (README: ~/bhdev-venv), most specific first. */
export function venvCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return [
    env.VIRTUAL_ENV ? join(env.VIRTUAL_ENV, "bin", "python") : null,
    join(home, "bhdev-venv", "bin", "python"),
    join(home, ".blackhole-dev", "venv", "bin", "python"),
  ].filter((x): x is string => !!x);
}

export function pickPython(setting: string | undefined, resourcesPath: string | undefined, candidates: string[] = venvCandidates()): string {
  const s = setting?.trim();
  // a setting that names a file that is gone (a re-made venv) falls through to the next choice
  if (s && (!s.includes("/") || existsSync(s))) return s;
  if (resourcesPath) {
    const bundled = join(resourcesPath, "python", "bin", "python3");
    if (existsSync(bundled)) return bundled;
  }
  return candidates.find((c) => existsSync(c)) || s || "python3";
}

/** The Blackhole-Dev source checkout this app runs from (npm run dev), or null in a packaged app. */
export function sourceCheckout(appPath: string): string | null {
  for (const d of [dirname(appPath), appPath]) {
    try {
      if (/name\s*=\s*"blackhole-dev"/.test(readFileSync(join(d, "pyproject.toml"), "utf8"))) return d;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** What to run when blackhole_dev does not import: blackhole-dev is not on PyPI, so it is the checkout. */
export function devFix(python: string, checkout: string | null): string {
  return checkout
    ? `${python} -m pip install -e ${checkout.replace(homedir(), "~")}  (or set Settings > Python helper to the venv that has it)`
    : "Set Settings > Python helper to the venv where blackhole_dev is installed";
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
export async function runChecks(python: string, checkout: string | null = null): Promise<Check[]> {
  const py = await run(python, ["-c", "import sys; print(sys.version.split()[0])"]);
  const dev = py.ok
    ? await run(python, ["-c", "import blackhole_dev; print(getattr(blackhole_dev, '__version__', '?'))"])
    : { ok: false, out: "" };
  const ssh = await run("ssh", ["-V"]);
  const rsync = await run("rsync", ["--version"]);
  return [
    { id: "python", label: "Python", ok: py.ok, detail: py.ok ? `${python} · ${py.out}` : `${python} not found`, fix: "Set Settings > Python path, or install Python 3.11+" },
    { id: "blackhole_dev", label: "blackhole_dev package", ok: dev.ok, detail: dev.ok ? `version ${dev.out}` : dev.out.split("\n").pop() || "not importable", fix: devFix(python, checkout) },
    { id: "ssh", label: "ssh", ok: ssh.ok, detail: ssh.out.split("\n")[0] || "not found", fix: "macOS ships ssh; check PATH" },
    { id: "rsync", label: "rsync", ok: rsync.ok, detail: rsync.out.split("\n")[0] || "not found", fix: "brew install rsync" },
  ];
}
