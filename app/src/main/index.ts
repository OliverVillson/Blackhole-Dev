import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Menu, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { HelperClient } from "./helper";
import { Gate, type GateUi } from "./gate";
import { Secrets } from "./secrets";
import { Settings } from "./settings";
import * as licence from "./licence";
import { Workspace, ensureWorkspace, workspacePaths } from "./workspace";
import { pickPython, runChecks, sourceCheckout } from "./python";
import { Terminals } from "./terminal";
import { Host } from "./host";
import { buildMenu } from "./menu";
import { setupUpdates } from "./updates";
import { HELPER_METHODS } from "../shared/rpc";
import { settle } from "../shared/invoke";
import { themeById } from "../shared/themes";
import type { ConfirmAnswer, ConfirmShown } from "../shared/gate";
import type { MainContext } from "../shared/ext";
import { mainModules } from "../modules.main";

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
let win: BrowserWindow | null = null;
const logs: string[] = [];

function log(...a: unknown[]): void {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logs.push(line);
  if (logs.length > 2000) logs.shift();
  console.log(line);
  send("app:log", { source: "app", line });
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send("bh:event", channel, payload);
}

function rendererUrl(page: "index" | "gate"): { url?: string; file?: string } {
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}/${page}.html` };
  return { file: join(__dirname, `../renderer/${page}.html`) };
}

function load(w: BrowserWindow, page: "index" | "gate"): Promise<void> {
  const r = rendererUrl(page);
  return r.url ? w.loadURL(r.url) : w.loadFile(r.file!);
}

/** Window background before the page paints: the chosen theme's surface, so a light theme does not flash black. */
let windowBg = themeById(null).vars.void;

const gateUi: GateUi = {
  show(req: ConfirmShown): Promise<ConfirmAnswer> {
    return new Promise((resolve) => {
      const parent = win && !win.isDestroyed() ? win : undefined;
      const g = new BrowserWindow({
        parent,
        modal: !!parent,
        width: 560,
        height: 420,
        resizable: false,
        minimizable: false,
        maximizable: false,
        show: false,
        backgroundColor: windowBg,
        title: "Confirm",
        webPreferences: { preload: join(__dirname, "../preload/gate.js"), sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      let done = false;
      const finish = (a: ConfirmAnswer) => {
        if (done) return;
        done = true;
        ipcMain.removeListener("gate:answer", onAnswer);
        if (!g.isDestroyed()) g.close();
        resolve(a);
      };
      const onAnswer = (e: Electron.IpcMainEvent, a: ConfirmAnswer) => {
        if (e.sender !== g.webContents) return; // only the gate window can answer
        finish({ id: String(a?.id), approved: a?.approved === true, trusted: a?.trusted === true });
      };
      ipcMain.on("gate:answer", onAnswer);
      g.on("closed", () => finish({ id: req.id, approved: false, trusted: false }));
      g.webContents.on("will-navigate", (ev) => ev.preventDefault());
      g.webContents.once("did-finish-load", () => {
        g.webContents.send("gate:request", req);
        g.show();
        g.focus();
      });
      load(g, "gate").catch(() => finish({ id: req.id, approved: false, trusted: false }));
    });
  },
};

async function main(): Promise<void> {
  await app.whenReady();
  const userData = app.getPath("userData");
  const settings = new Settings(join(userData, "settings.json"));
  windowBg = themeById(settings.get<string | null>("ui.theme", null)).vars.void;
  const paths = workspacePaths(settings.get("workspace", join(homedir(), "BlackHole-Dev")), userData);
  ensureWorkspace(paths);
  const ws = new Workspace(paths);
  const secrets = new Secrets(join(userData, "secrets.json"), safeStorage);
  const gate = new Gate(gateUi, join(userData, "confirm-log.jsonl"));
  const python = () => pickPython(settings.get<string>("python.path", ""), process.resourcesPath);
  const helper = new HelperClient({
    python,
    // BLACKHOLE_DEV_HELPER=path/to/script.py runs that script instead of `-m blackhole_dev.rpc` (tests, helper development).
    args: process.env.BLACKHOLE_DEV_HELPER ? [process.env.BLACKHOLE_DEV_HELPER] : undefined,
    cwd: paths.workspace,
    init: {
      workspace: paths.workspace,
      recipesDir: paths.recipes,
      functionsDir: paths.functions,
      modelsDir: paths.models,
      client: "blackhole-dev-app",
      version: app.getVersion(),
    },
  });
  helper.on("status", (s) => send("helper:status", s));
  helper.on("stderr", (d: string) => send("app:log", { source: "helper", line: d.replace(/\n$/, "") }));
  helper.on("notify", (method: string, params: unknown) => send("helper:notify", { method, params }));
  const terms = new Terminals(send);
  const host = new Host();

  const base: Omit<MainContext, "module" | "handle"> = {
    send,
    gate,
    secrets,
    helper: {
      call: (method: string, params?: object, timeoutMs?: number) => helper.call(method, params, timeoutMs),
      onNotify: (method, cb) => {
        const l = (p: unknown) => cb(p);
        helper.on(`notify:${method}`, l);
        return () => helper.off(`notify:${method}`, l);
      },
      status: () => helper.status(),
    } as MainContext["helper"],
    licence,
    settings,
    paths,
    log,
  };

  // Shell channels. Modules get their own "<module>:" namespace through ctx.handle.
  const reg = (module: string, channel: string, fn: (...a: any[]) => unknown) => host.register(module, channel, fn);
  reg("app", "app:info", () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, licence: licence.status(), pty: terms.hasPty, channels: host.channels() }));
  reg("app", "app:logs", () => logs.slice(-500));
  reg("app", "app:checks", () => runChecks(python(), sourceCheckout(app.getAppPath())));
  reg("app", "app:openExternal", (url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error("only https links open externally");
    return shell.openExternal(url);
  });
  reg("app", "app:reveal", (p: string) => shell.showItemInFolder(ws.inside(p)));
  reg("helper", "helper:call", (method: string, params?: object) => {
    if (!(HELPER_METHODS as readonly string[]).includes(method)) throw new Error(`helper method not allowed: ${method}`);
    return helper.call(method, params);
  });
  reg("helper", "helper:status", () => helper.status());
  reg("helper", "helper:restart", () => helper.restart());
  reg("ws", "ws:paths", () => paths);
  reg("ws", "ws:list", (dir: string) => ws.list(dir));
  reg("ws", "ws:read", (p: string) => ws.read(p));
  reg("ws", "ws:write", (p: string, text: string) => ws.write(p, String(text)));
  reg("ws", "ws:create", (dir: string, name: string, text: string) => ws.create(dir, name, String(text ?? "")));
  reg("ws", "ws:rename", (p: string, name: string) => ws.rename(p, name));
  reg("ws", "ws:mkdir", (parent: string, name: string) => ws.mkdir(parent, String(name)));
  reg("ws", "ws:move", (p: string, toDir: string) => ws.move(p, toDir));
  reg("ws", "ws:trash", (p: string) => ws.remove(p, (abs) => shell.trashItem(abs)));
  reg("ws", "ws:importToml", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Import a TOML schema", filters: [{ name: "Schema", extensions: ["toml"] }], properties: ["openFile"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return helper.call("recipe.fromToml", { path: r.filePaths[0], out: paths.recipes });
  });
  reg("ws", "ws:chooseFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Choose workspace folder", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set("workspace", r.filePaths[0]);
    app.relaunch();
    app.exit(0);
    return r.filePaths[0];
  });
  reg("secrets", "secrets:has", (n: string) => secrets.has(n));
  reg("secrets", "secrets:set", (n: string, v: string) => secrets.set(n, String(v)));
  reg("secrets", "secrets:delete", (n: string) => secrets.delete(n));
  reg("settings", "settings:get", (k: string, f: unknown) => settings.get(k, f));
  reg("settings", "settings:set", (k: string, v: unknown) => {
    if (k === "workspace") throw new Error("use ws:chooseFolder");
    settings.set(k, v);
    if (k === "python.path") helper.restart().catch(() => undefined);
    if (k === "ui.theme") {
      windowBg = themeById(typeof v === "string" ? v : null).vars.void;
      if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg);
    }
  });
  reg("gate", "gate:confirm", (req) => gate.confirm(req));
  reg("term", "term:create", (o) => terms.create(o));
  reg("term", "term:write", (id: string, d: string) => terms.write(id, d));
  reg("term", "term:resize", (id: string, c: number, r: number) => terms.resize(id, c, r));
  reg("term", "term:dispose", (id: string) => terms.dispose(id));

  ipcMain.handle("bh:invoke", (e: IpcMainInvokeEvent, channel: string, ...args: unknown[]) => {
    if (!win || e.sender !== win.webContents) throw new Error("not the main window");
    return settle(() => host.invoke(String(channel), args), (err) => log(`${channel} failed: ${(err as Error)?.stack ?? err}`));
  });

  const deactivators: (() => unknown)[] = [];
  for (const [id, loadModule] of mainModules) {
    try {
      const mod = await loadModule();
      const r = await mod.activate(host.contextFor(id, base));
      if (r && typeof r.deactivate === "function") deactivators.push(() => r.deactivate());
      log(`module ${id}: active`);
    } catch (e) {
      log(`module ${id}: failed to activate: ${(e as Error).stack ?? e}`);
    }
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: windowBg,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 12 },
    title: "BlackHole-Dev",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!isDev || !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "-")) ev.preventDefault();
  });
  win.once("ready-to-show", () => win?.show());
  Menu.setApplicationMenu(buildMenu((cmd) => send("app:command", cmd)));
  await load(win, "index");
  helper.start().catch((e) => log(`helper: ${e.message}`));
  setupUpdates(log);

  app.on("before-quit", () => {
    for (const d of deactivators) {
      try {
        d();
      } catch (e) {
        log(`deactivate failed: ${(e as Error).message}`);
      }
    }
    terms.disposeAll();
    helper.stop().catch(() => undefined);
  });
}

app.on("window-all-closed", () => app.quit());
main().catch((e) => {
  console.error(e);
  app.exit(1);
});
