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
// Palette is a single popover: the same shortcut again closes it, the other mode switches it.
const overlays = () => win.evaluate(() => document.querySelectorAll(".palette-overlay").length);
const assert = (ok, what) => { if (!ok) { console.error("FAILED: " + what); process.exit(1); } };
await win.keyboard.press("Control+P");
await win.keyboard.press("Control+Shift+P");
assert((await overlays()) === 1 && (await win.inputValue(".palette input")) === ">", "Cmd+Shift+P switches the open palette to commands");
await win.keyboard.type("split right");
await win.waitForSelector(".palette kbd");
await win.screenshot({ path: join(out, "06-command-palette.png") });
await win.keyboard.press("Control+Shift+P");
assert((await overlays()) === 0, "Cmd+Shift+P again closes the palette");
await win.keyboard.press("Control+P");
await win.keyboard.press("Control+P");
await win.keyboard.press("Control+P");
assert((await overlays()) === 1, "Cmd+P three times leaves one palette");
await win.keyboard.press("Escape");
assert((await overlays()) === 0, "Escape closes the palette");
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
// Split view: split right (a second view of the same file), drag the Welcome tab down into a
// third group, resize, cycle groups, then collapse everything back into one group.
const groups = () => win.evaluate(() => document.querySelectorAll(".editor-area .group").length);
await win.click(".editor-area .group .tab >> nth=1");
await win.keyboard.press("Control+\\");
await win.waitForFunction(() => document.querySelectorAll(".editor-area .group").length === 2);
await win.waitForFunction(() => document.querySelectorAll(".editor-area .group:nth-child(3) .monaco-editor .view-lines").length > 0 || document.querySelectorAll(".monaco-editor").length >= 2);
const welcome = win.locator(".group >> nth=0").locator(".tab", { hasText: "Welcome" });
const target = win.locator(".group >> nth=1").locator(".editor-host");
const box = await target.boundingBox();
await welcome.dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 20 } });
await win.waitForFunction(() => document.querySelectorAll(".editor-area .group").length === 3, null, { timeout: 5000 });
assert(await win.evaluate(() => !!document.querySelector(".split.split-col")), "dragging a tab to the bottom edge splits down");
const sash = win.locator(".gsash.v").first();
const sb = await sash.boundingBox();
const before = await win.locator(".group >> nth=0").boundingBox();
await win.mouse.move(sb.x + sb.width / 2, sb.y + 80);
await win.mouse.down();
await win.mouse.move(sb.x - 150, sb.y + 80, { steps: 5 });
await win.mouse.up();
const after = await win.locator(".group >> nth=0").boundingBox();
assert(after.width < before.width - 100, `dragging the divider resizes groups (${before.width} -> ${after.width})`);
await win.screenshot({ path: join(out, "07-split-groups.png") });
const activeIdx = () => win.evaluate(() => [...document.querySelectorAll(".editor-area .group")].findIndex((g) => g.classList.contains("active")));
const i0 = await activeIdx();
await win.evaluate(() => window.__shell.executeCommand("group.next"));
assert((await activeIdx()) === (i0 + 1) % 3, "next group moves focus");
// Drag a tab onto the left of another group's tab: it joins that group.
const g0 = win.locator(".group >> nth=0").locator(".tab").first();
const moving = win.locator(".group >> nth=2").locator(".tab").first();
await moving.dragTo(g0, { targetPosition: { x: 4, y: 10 } });
await win.waitForFunction(() => document.querySelectorAll(".editor-area .group").length === 2, null, { timeout: 5000 });
assert(await win.evaluate(() => document.querySelector(".group .tab")?.textContent?.includes("Welcome")), "a tab dropped left of a tab is inserted before it");
await win.evaluate(() => window.__shell.executeCommand("group.collapse"));
assert((await groups()) === 1, "collapse folds the second group into the first");
// Shift+Tab moves between tabs of the group.
await win.click(".editor-area .group .tab >> nth=0");
const tabIdx = () => win.evaluate(() => [...document.querySelectorAll(".editor-area .group .tab")].findIndex((t) => t.classList.contains("on")));
const t0 = await tabIdx();
await win.keyboard.press("Shift+Tab");
assert((await tabIdx()) !== t0, "Shift+Tab switches tab");
// Tab autofill: type a prefix and press Tab for the dropdown.
await win.click("text=first-recipe.py");
await win.click(".monaco-editor .view-lines");
await win.keyboard.press("Control+End");
await win.keyboard.type("\nx = Rec");
await win.keyboard.press("Tab");
await win.waitForSelector(".suggest-widget.visible", { timeout: 5000 });
await win.screenshot({ path: join(out, "08-tab-autofill.png") });
await win.keyboard.press("Tab");
assert(await win.evaluate(() => window.__shell.editor.view().editor.getModel().getValue().includes("x = Recipe")), "Tab accepts the completion");
await win.keyboard.press("Control+Z");
await win.keyboard.press("Control+Z");

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
