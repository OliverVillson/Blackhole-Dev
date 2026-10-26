// Launch the built app with the fake helper, exercise the shell, save screenshots.
// Run: npm run build && xvfb-run -a node test/e2e/smoke.mjs <outdir>
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "shots");
const home = mkdtempSync(join(tmpdir(), "bhdev-home-"));
const app = await electron.launch({
  executablePath: join(here, "../../node_modules/electron/dist/electron"),
  args: [join(here, "../.."), "--no-sandbox", `--user-data-dir=${join(home, "ud")}`],
  env: { ...process.env, HOME: home, BLACKHOLE_DEV_HELPER: join(here, "../fixtures/fake_helper.py"), BLACKHOLE_DEV_NO_UPDATE: "1" },
});
const errors = [];
const win = await app.firstWindow();
win.on("pageerror", (e) => errors.push(String(e)));
win.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector(".titlebar");
await win.waitForFunction(() => document.body.innerText.includes("blackhole_dev 0.1.0-fake"), null, { timeout: 20000 });
await win.screenshot({ path: join(out, "01-welcome.png") });
await win.click("text=first-recipe.py");
await win.waitForSelector(".monaco-editor .view-lines");
await win.keyboard.press("Control+Shift+P").catch(() => {});
await win.evaluate(() => window.__shell.executeCommand("recipe.plan"));
await win.waitForSelector("text=est. VM time", { timeout: 15000 });
await win.screenshot({ path: join(out, "02-editor-plan.png") });
// I3 stream into the open recipe, with one user edit in the middle.
await win.evaluate(async () => {
  const s = window.__shell;
  const f = s.activeFile();
  const ed = s.editor.streams;
  const id = ed.streamBegin(f, { at: "end" });
  ed.streamChunk(id, "\n# copilot: add a qheal step after HEX\nrecipe.fn(\"qheal\", minutes=45)\n");
  ed.setGhost(f, 'recipe.fn("bench", suite="lcb-v6")');
});
await win.waitForSelector(".hunkbar:not(.hidden)");
await win.screenshot({ path: join(out, "03-copilot-stream.png") });
await win.evaluate(() => { const s = window.__shell; const f = s.activeFile(); for (const x of s.editor.streams.hunks(f)) s.editor.streams.acceptHunk(x.id); });
// Anatomy.
await win.evaluate(() => window.__shell.showActivity("anatomy"));
await win.fill('input[aria-label="Model to open"]', "Qwen/Qwen3-30B-A3B");
await win.click("text=Open >> nth=0");
await win.waitForSelector("text=layer 12");
await win.click("text=layer 12");
await win.waitForSelector("text=REAP rank");
await win.screenshot({ path: join(out, "04-anatomy.png") });
// Functions + fork-able built-ins.
await win.evaluate(() => window.__shell.showActivity("functions"));
await win.waitForSelector("text=hex-quantize");
await win.screenshot({ path: join(out, "05-functions.png") });
await app.close();
if (errors.length) {
  console.error("renderer errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("smoke ok");
