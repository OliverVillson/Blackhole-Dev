// Makes sure the Electron binary is really there, and says loudly why when it is not.
// Runs after `npm install`, before `npm run dev`, and as `npm run doctor`.
//
// electron's own postinstall (node_modules/electron/install.js) exits 0 without a word when
// ELECTRON_SKIP_BINARY_DOWNLOAD is set, when it thinks a matching binary is installed, or
// (on npm 12+) when install scripts are not allowed, which leaves electron-vite with
// "Electron uninstall".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const doctor = process.argv.includes("--doctor");

function electronDir() {
  try {
    return dirname(require.resolve("electron/package.json"));
  } catch {
    return null;
  }
}

function binary(dir) {
  try {
    const rel = readFileSync(join(dir, "path.txt"), "utf8").trim();
    const p = process.env.ELECTRON_OVERRIDE_DIST_PATH ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, rel) : join(dir, "dist", rel);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const dir = electronDir();
if (!dir) {
  console.error("✕ electron is not in node_modules. Run `npm install` in app/ first.");
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
let bin = binary(dir);

if (!bin) {
  console.log(`Electron ${version}: binary missing, running its installer (downloads ~110 MB once)…`);
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const r = spawnSync(process.execPath, [join(dir, "install.js")], { cwd: dir, env, stdio: "inherit" });
  if (r.status !== 0) console.error(`electron install.js exited with ${r.status}`);
  bin = binary(dir);
}

if (bin) {
  console.log(`✓ Electron ${version}: ${bin}`);
  if (!doctor) process.exit(0);
} else {
  const cache = process.env.electron_config_cache || (process.platform === "darwin" ? join(homedir(), "Library/Caches/electron") : join(homedir(), ".cache/electron"));
  const show = (k) => `  ${k}=${process.env[k] ?? "(unset)"}`;
  console.error(`
✕ The Electron ${version} binary is still missing, so the app cannot start.

Environment that changes what electron's installer does:
${["ELECTRON_SKIP_BINARY_DOWNLOAD", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_MIRROR", "electron_config_cache", "npm_config_arch", "npm_config_platform", "HTTPS_PROXY", "https_proxy"].map(show).join("\n")}
  arch=${process.arch} platform=${process.platform} node=${process.version}
Download cache ${cache}: ${existsSync(cache) ? readdirSync(cache).join(", ") || "(empty)" : "(none)"}

Fix, in app/:
  unset ELECTRON_SKIP_BINARY_DOWNLOAD ELECTRON_OVERRIDE_DIST_PATH
  rm -rf "${cache}" node_modules/electron
  npm install
  npm run doctor
`);
  process.exit(1);
}

// --doctor: the rest of what the app needs.
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const node = Number(process.versions.node.split(".")[0]);
console.log(`${node >= 22 ? "✓" : "✕"} Node ${process.version}${node >= 22 ? "" : " (need 22+)"}`);
let pty = "missing (terminal falls back to plain pipes)";
try {
  require.resolve("node-pty");
  pty = "installed";
} catch {}
console.log(`${pty === "installed" ? "✓" : "⚠"} node-pty ${pty}`);
const py = process.env.BLACKHOLE_DEV_PYTHON || "python3";
const helper = run(py, ["-c", "import blackhole_dev, sys; print(blackhole_dev.__version__, sys.version.split()[0])"]);
console.log(helper.status === 0
  ? `✓ ${py}: blackhole_dev ${helper.stdout.trim()}`
  : `✕ ${py} cannot import blackhole_dev (activate ~/bhdev-venv, or set BLACKHOLE_DEV_PYTHON to its python)`);
for (const [cmd, args] of [["ssh", ["-V"]], ["rsync", ["--version"]]]) {
  const r = run(cmd, args);
  console.log(`${r.status === 0 ? "✓" : "⚠"} ${cmd}${r.status === 0 ? "" : " not found (needed to run recipes on a VM)"}`);
}
