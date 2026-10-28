// Screenshot the main screen in every theme (for reviewing themes, not run in CI).
// Run: npm run build && xvfb-run -a node test/e2e/themes.mjs <outdir> [id,id,...]
import { _electron as electron } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "themes");
const only = process.argv[3]?.split(",");
const home = mkdtempSync(join(tmpdir(), "bhdev-home-"));
const app = await electron.launch({
  executablePath: join(here, "../../node_modules/electron/dist/electron"),
  args: [join(here, "../.."), "--no-sandbox", `--user-data-dir=${join(home, "ud")}`],
  env: { ...process.env, HOME: home, BLACKHOLE_DEV_HELPER: join(here, "../fixtures/fake_helper.py"), BLACKHOLE_DEV_NO_UPDATE: "1" },
});
const win = await app.firstWindow();
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForFunction(() => document.body.innerText.includes("blackhole_dev 0.1.0-fake"), null, { timeout: 20000 });
await win.click(".rc:has-text('first-recipe.py')");
await win.waitForSelector(".monaco-editor .view-lines");
await win.evaluate(() => window.__shell.executeCommand("recipe.plan"));
await win.waitForSelector("text=est. VM time", { timeout: 15000 });
await win.evaluate(() => {
  const s = window.__shell;
  const f = s.activeFile();
  const id = s.editor.streams.streamBegin(f, { at: "end" });
  s.editor.streams.streamChunk(id, "\n# copilot: add a qheal step after HEX\nrecipe.fn(\"qheal\", minutes=45)\n");
  s.editor.view().editor.setSelection({ startLineNumber: 14, startColumn: 1, endLineNumber: 15, endColumn: 30 });
});
await win.click("nav.activity button[title='Copilot']");
const ids = await win.evaluate(() => [...window.__shell.commands.keys()].filter((k) => k.startsWith("theme.")).map((k) => k.slice(6))).then((all) => only ?? all);
for (const [i, id] of ids.entries()) {
  await win.evaluate((x) => window.__shell.executeCommand(`theme.${x}`), id);
  await win.evaluate(() => document.fonts.ready);
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(out, `${String(i + 1).padStart(2, "0")}-${id}.png`) });
}
await app.close();
console.log(ids.join(" "));
