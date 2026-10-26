// The app shell: layout (title bar, activity bar, sidebar, tabs + editor, bottom panel, right
// panel, status bar) and the registries behind RendererContext.

import { h, clear, basename, debounce, ICONS } from "./dom";
import { bh, helper } from "./bridge";
import { EditorManager } from "./editor/monaco";
import { showModal, toast } from "./ui";
import { isMac, matches } from "./keys";
import { THEME } from "../shared/theme";
import type {
  ActivityDef, AppPaths, CommandDef, Dispose, Mount, OverviewSectionDef, PanelDef, RecipeActionDef, RendererContext,
  SettingsSectionDef, StatusItemDef, StatusItemHandle, TabTypeDef, TerminalApi, WorkspaceApi,
} from "../shared/ext";
import type { ConfirmRequest } from "../shared/gate";
import type { HelperStatus, Problem } from "../shared/rpc";

interface Slot {
  def: PanelDef;
  pane: HTMLElement;
  button: HTMLButtonElement;
  mounted: boolean;
  dispose?: void | Dispose;
}

interface Tab {
  key: string;
  type: string;
  state: any;
  button: HTMLButtonElement;
  pane?: HTMLElement;
  dispose?: void | Dispose;
}



export class Shell {
  paths!: AppPaths;
  readonly editor: EditorManager;
  helperStatus: HelperStatus = { state: "starting" };
  problems = new Map<string, Problem[]>();

  // registries
  private activities = new Map<string, { def: ActivityDef; button: HTMLButtonElement; view?: { render: Mount }; pane?: HTMLElement; mounted?: boolean }>();
  private activeActivity: string | null = null;
  private panels = new Map<string, Slot>();
  private rights = new Map<string, Slot>();
  private activePanel: string | null = null;
  private activeRight: string | null = null;
  readonly tabTypes = new Map<string, TabTypeDef>();
  private tabs: Tab[] = [];
  private activeTab: Tab | null = null;
  readonly commands = new Map<string, CommandDef>();
  readonly recipeActions: RecipeActionDef[] = [];
  readonly overviewSections: OverviewSectionDef[] = [];
  readonly settingsSections: SettingsSectionDef[] = [];
  private activeFileCbs = new Set<(p: string | null) => void>();
  private problemCbs = new Set<() => void>();

  // DOM
  readonly root: HTMLElement;
  private titleItems = h("div", { class: "row", style: "gap:8px" });
  private activityTop = h("div", { style: "display:flex;flex-direction:column" });
  private activityBottom = h("div", { style: "display:flex;flex-direction:column;margin-top:auto" });
  private sidebar = h("section", { class: "sidebar", "aria-label": "Sidebar" });
  private tablist = h("div", { class: "tablist", role: "tablist" });
  private tabActions = h("div", { class: "tab-actions" });
  private crumbs = h("div", { class: "crumbs" });
  readonly hunkbar = h("div", { class: "hunkbar hidden", "aria-label": "Copilot changes" });
  private editorHost = h("div", { class: "editor-host" });
  private monacoPane = h("div", { class: "pane" });
  private panel = h("section", { class: "panel", "aria-label": "Panel" });
  private panelTabs = h("div", { class: "panel-tabs", role: "tablist" });
  readonly panelNote = h("span", { class: "panel-note" });
  private panelBody = h("div", { class: "panel-body" });
  private right = h("aside", { class: "right", "aria-label": "Inspector" });
  private rightTabs = h("div", { class: "right-tabs", role: "tablist" });
  private rightBody = h("div", { class: "right-body" });
  private statusLeft = h("div", { class: "row", style: "gap:18px;flex-wrap:nowrap" });
  private statusRight = h("div", { class: "row", style: "gap:18px;flex-wrap:nowrap" });

  constructor(mount: HTMLElement) {
    this.root = mount;
    const monacoHost = h("div", { class: "monaco-host" });
    this.monacoPane.append(monacoHost);
    this.editorHost.append(this.monacoPane);
    this.panel.append(this.panelTabs, this.panelBody);
    this.panelTabs.append(this.panelNote);
    this.right.append(this.rightTabs, this.rightBody);

    const title = h("header", { class: `titlebar${isMac ? " mac" : ""}` },
      h("div", { class: "brand" }, h("span", { html: ICONS.logo }), h("b", null, "BLACKHOLE", h("span", null, "//"), "DEV")),
      h("div", { class: "search" }, h("button", { onclick: () => this.executeCommand("palette.open") }, `search recipes, functions, commands  ${isMac ? "⌘" : "Ctrl+"}P`)),
      this.titleItems);
    const center = h("main", { class: "center" },
      h("div", { class: "tabs" }, this.tablist, this.tabActions),
      this.crumbs, this.hunkbar, this.editorHost,
      this.sash("h", this.panel, "height", -1, 120, 700),
      this.panel);
    const body = h("div", { class: "body" },
      h("nav", { class: "activity", "aria-label": "Activity bar" }, this.activityTop, this.activityBottom),
      this.sidebar, this.sash("v", this.sidebar, "width", 1, 200, 560),
      center,
      this.sash("v", this.right, "width", -1, 260, 640), this.right);
    const status = h("footer", { class: "status" }, this.statusLeft, h("div", { class: "spacer" }), this.statusRight);
    mount.append(title, body, status);
    this.editor = new EditorManager(monacoHost);
    this.editor.on("dirty", (b) => this.refreshTabButton(b.path));
    this.editor.on("change", (b) => this.lintSoon(b.path));
    this.editor.on("hunks", (file) => this.renderHunkbar(file));
    this.right.classList.add("hidden");
    window.addEventListener("keydown", (e) => this.onKey(e));
    bh.on("app:command", (id: string) => this.executeCommand(id).catch((e) => toast(String(e.message ?? e), "error")));
    bh.on("helper:status", (s: HelperStatus) => this.setHelperStatus(s));
  }

  // ---- layout pieces -------------------------------------------------------

  private sash(dir: "v" | "h", target: HTMLElement, prop: "width" | "height", sign: 1 | -1, min: number, max: number): HTMLElement {
    const s = h("div", { class: `sash ${dir}`, role: "separator", "aria-orientation": dir === "v" ? "vertical" : "horizontal" });
    s.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const start = dir === "v" ? e.clientX : e.clientY;
      const size = target.getBoundingClientRect()[prop];
      s.classList.add("drag");
      const move = (ev: MouseEvent) => {
        const d = (dir === "v" ? ev.clientX : ev.clientY) - start;
        target.style[prop] = `${Math.min(max, Math.max(min, size + sign * d))}px`;
      };
      const up = () => {
        s.classList.remove("drag");
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    return s;
  }

  // ---- activities and sidebar --------------------------------------------

  registerActivity(def: ActivityDef, bottom = false): void {
    if (this.activities.has(def.id)) throw new Error(`activity exists: ${def.id}`);
    const button = h("button", { class: "ab", "aria-label": def.title, title: def.title, html: def.icon, onclick: () => (def.run ? def.run() : this.toggleActivity(def.id)) });
    button.dataset.order = String(def.order ?? 100);
    this.activities.set(def.id, { def, button });
    const box = bottom ? this.activityBottom : this.activityTop;
    const after = [...box.children].find((c) => Number((c as HTMLElement).dataset.order) > (def.order ?? 100));
    box.insertBefore(button, after ?? null);
  }

  registerSidebarView(activityId: string, v: { render: Mount }): void {
    const a = this.activities.get(activityId);
    if (!a) throw new Error(`no activity ${activityId}`);
    a.view = v;
    if (this.activeActivity === activityId) this.showActivity(activityId);
  }

  toggleActivity(id: string): void {
    if (this.activeActivity === id && !this.sidebar.classList.contains("hidden")) {
      this.sidebar.classList.add("hidden");
      this.activities.get(id)?.button.classList.remove("on");
      return;
    }
    this.showActivity(id);
  }

  showActivity(id: string): void {
    const a = this.activities.get(id);
    if (!a) return;
    for (const [k, x] of this.activities) {
      x.button.classList.toggle("on", k === id);
      x.pane?.classList.add("hidden");
    }
    this.activeActivity = id;
    this.sidebar.classList.remove("hidden");
    if (!a.pane) {
      a.pane = h("div", { style: "display:flex;flex-direction:column;min-height:100%" });
      this.sidebar.append(a.pane);
    }
    a.pane.classList.remove("hidden");
    a.pane.style.display = "";
    for (const [k, x] of this.activities) if (k !== id && x.pane) x.pane.style.display = "none";
    if (a.view && !a.mounted) {
      a.mounted = true;
      a.view.render(a.pane);
    } else if (!a.view && !a.mounted) {
      a.pane.append(h("div", { class: "view" }, h("div", { class: "empty" }, `${a.def.title}: nothing here yet.`)));
      a.mounted = true;
    }
  }

  // ---- bottom panel and right panel ----------------------------------------

  private addSlot(map: Map<string, Slot>, tabsEl: HTMLElement, bodyEl: HTMLElement, def: PanelDef, onPick: (id: string) => void, beforeEl?: HTMLElement): void {
    if (map.has(def.id)) throw new Error(`panel exists: ${def.id}`);
    const pane = h("div", { class: "pane hidden" });
    const button = h("button", { class: "ptab", role: "tab", onclick: () => onPick(def.id) }, def.title);
    button.dataset.order = String(def.order ?? 100);
    map.set(def.id, { def, pane, button, mounted: false });
    const after = [...tabsEl.children].find((c) => (c as HTMLElement).dataset.order && Number((c as HTMLElement).dataset.order) > (def.order ?? 100));
    tabsEl.insertBefore(button, after ?? beforeEl ?? null);
    bodyEl.append(pane);
  }

  private pick(map: Map<string, Slot>, id: string): Slot | undefined {
    const s = map.get(id);
    if (!s) return;
    for (const [k, x] of map) {
      x.pane.classList.toggle("hidden", k !== id);
      x.button.classList.toggle("on", k === id);
      x.button.setAttribute("aria-selected", String(k === id));
    }
    if (!s.mounted) {
      s.mounted = true;
      s.dispose = s.def.render(s.pane);
    }
    return s;
  }

  registerPanel(def: PanelDef): void {
    this.addSlot(this.panels, this.panelTabs, this.panelBody, def, (id) => this.showPanel(id), this.panelNote);
    if (!this.activePanel) this.showPanel(def.id);
  }

  showPanel(id: string): void {
    this.panel.classList.remove("hidden");
    if (this.pick(this.panels, id)) this.activePanel = id;
  }

  setPanelTitle(id: string, title: string): void {
    const s = this.panels.get(id);
    if (s) s.button.textContent = title;
  }

  togglePanel(): void {
    this.panel.classList.toggle("hidden");
  }

  registerRightPanel(def: PanelDef): void {
    this.addSlot(this.rights, this.rightTabs, this.rightBody, def, (id) => this.showRight(id));
    if (!this.activeRight) this.pick(this.rights, def.id), (this.activeRight = def.id);
  }

  showRight(id: string): void {
    this.right.classList.remove("hidden");
    if (this.pick(this.rights, id)) this.activeRight = id;
  }

  toggleRight(): void {
    this.right.classList.toggle("hidden");
  }

  // ---- tabs ----------------------------------------------------------------

  registerTabType<S>(t: TabTypeDef<S>): void {
    if (this.tabTypes.has(t.id)) throw new Error(`tab type exists: ${t.id}`);
    this.tabTypes.set(t.id, t as TabTypeDef);
  }

  openTab<S>(typeId: string, state: S): void {
    const t = this.tabTypes.get(typeId);
    if (!t) throw new Error(`no tab type ${typeId}`);
    const key = `${typeId}:${t.key ? t.key(state) : JSON.stringify(state)}`;
    const have = this.tabs.find((x) => x.key === key);
    if (have) return this.focusTab(have);
    const tab: Tab = { key, type: typeId, state, button: this.tabButton(t.title(state), () => this.focusTab(tab), () => this.closeTab(tab)) };
    this.tabs.push(tab);
    this.tablist.append(tab.button);
    this.focusTab(tab);
  }

  private tabButton(title: string, onFocus: () => void, onClose: () => void): HTMLButtonElement {
    const x = h("span", { class: "x", role: "button", "aria-label": `Close ${title}`, onclick: (e: Event) => { e.stopPropagation(); onClose(); } }, h("span", null, "✕"));
    const b = h("button", { class: "tab", role: "tab", title, onclick: onFocus, onauxclick: (e: MouseEvent) => e.button === 1 && onClose() }, h("span", { class: "tab-title" }, title), x);
    return b;
  }

  async openFile(path: string, line?: number, opts: { readonly?: boolean; text?: string; title?: string } = {}): Promise<void> {
    const key = `file:${path}`;
    let tab = this.tabs.find((x) => x.key === key);
    if (!tab) {
      await this.editor.load(path, opts);
      const t: Tab = { key, type: "file", state: { path }, button: this.tabButton(opts.title ?? basename(path), () => this.focusTab(t), () => this.closeTab(t)) };
      tab = t;
      this.tabs.push(t);
      this.tablist.append(t.button);
      this.lintSoon(path);
    }
    this.focusTab(tab, line);
  }

  focusTab(tab: Tab, line?: number): void {
    this.activeTab = tab;
    for (const t of this.tabs) {
      t.button.classList.toggle("on", t === tab);
      t.button.setAttribute("aria-selected", String(t === tab));
      t.pane?.classList.add("hidden");
    }
    const isFile = tab.type === "file";
    this.monacoPane.classList.toggle("hidden", !isFile);
    this.crumbs.style.display = isFile ? "" : "none";
    if (isFile) {
      this.editor.show(tab.state.path, line);
      this.renderCrumbs();
      this.renderHunkbar(tab.state.path);
    } else {
      this.hunkbar.classList.add("hidden");
      if (!tab.pane) {
        tab.pane = h("div", { class: "pane" });
        this.editorHost.append(tab.pane);
        tab.dispose = this.tabTypes.get(tab.type)!.render(tab.pane, tab.state);
      }
      tab.pane.classList.remove("hidden");
    }
    this.renderTabActions();
    const file = this.activeFile();
    this.activeFileCbs.forEach((cb) => cb(file));
  }

  closeTab(tab: Tab): void {
    if (tab.type === "file" && this.editor.isDirty(tab.state.path) && !confirm(`${basename(tab.state.path)} has unsaved changes. Close anyway?`)) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.button.remove();
    if (tab.type === "file") this.editor.close(tab.state.path);
    else {
      if (typeof tab.dispose === "function") tab.dispose();
      tab.pane?.remove();
    }
    if (this.activeTab === tab) {
      this.activeTab = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.focusTab(next);
      else {
        this.monacoPane.classList.add("hidden");
        this.crumbs.style.display = "none";
        this.hunkbar.classList.add("hidden");
        this.renderTabActions();
        this.activeFileCbs.forEach((cb) => cb(null));
      }
    }
  }

  closeActiveTab(): void {
    if (this.activeTab) this.closeTab(this.activeTab);
  }

  fileRenamed(from: string, to: string): void {
    const tab = this.tabs.find((x) => x.key === `file:${from}`);
    if (!tab) return;
    tab.key = `file:${to}`;
    tab.state = { path: to };
    tab.button.querySelector(".tab-title")!.textContent = basename(to);
    this.editor.rename(from, to);
  }

  fileRemoved(path: string): void {
    const tab = this.tabs.find((x) => x.key === `file:${path}`);
    if (tab) {
      this.editor.close(path);
      tab.type = "gone";
      this.closeTab({ ...tab, type: "x" } as Tab);
    }
  }

  private refreshTabButton(path: string): void {
    const tab = this.tabs.find((x) => x.key === `file:${path}`);
    tab?.button.classList.toggle("dirty", this.editor.isDirty(path));
  }

  activeFile(): string | null {
    return this.activeTab?.type === "file" ? this.activeTab.state.path : null;
  }

  isRecipe(path: string | null): path is string {
    return !!path && !!this.paths && path.startsWith(this.paths.recipes) && path.endsWith(".py");
  }

  private renderCrumbs(): void {
    clear(this.crumbs);
    const p = this.activeFile();
    if (!p) return;
    const rel = this.paths && p.startsWith(this.paths.workspace) ? p.slice(this.paths.workspace.length + 1) : p;
    const b = this.editor.buffers.get(p);
    this.crumbs.append(h("span", null, rel.split("/").join(" › ")));
    if (b?.readonly) this.crumbs.append(h("span", { class: "badge" }, "built-in · read only"), h("button", { class: "btn sm", onclick: () => this.executeCommand("function.fork", basename(p).replace(/^builtin:/, "").replace(/\.py$/, "")) }, "Fork to edit"));
    if (this.editor.streams.isStreaming(p)) this.crumbs.append(h("span", { class: "live" }, "● copilot writing"));
  }

  private renderTabActions(): void {
    clear(this.tabActions);
    const p = this.activeFile();
    if (!this.isRecipe(p)) return;
    this.tabActions.append(h("button", { class: "btn", onclick: () => this.executeCommand("recipe.plan") }, "Plan"));
    if (this.commands.has("blackhole.runOnVm")) this.tabActions.append(h("button", { class: "btn pri", onclick: () => this.executeCommand("blackhole.runOnVm", p) }, "Run on VM ▸"));
  }

  renderHunkbar(file: string): void {
    if (file !== this.activeFile()) return;
    const hunks = this.editor.streams.hunks(file).filter((x) => x.kind === "copilot" && x.state === "pending");
    clear(this.hunkbar);
    this.hunkbar.classList.toggle("hidden", hunks.length === 0);
    this.renderCrumbs();
    if (!hunks.length) return;
    const s = this.editor.streams;
    this.hunkbar.append(h("span", { class: "tone-warn" }, `Copilot changes · ${hunks.length} pending`));
    for (const x of hunks.slice(0, 8)) {
      this.hunkbar.append(h("span", { class: "chip" },
        h("button", { class: "btn sm", style: "border:0;background:none;padding:0", onclick: () => this.editor.show(file, x.startLine) }, x.startLine === x.endLine ? `L${x.startLine}` : `L${x.startLine}–${x.endLine}`),
        h("button", { class: "btn sm", "aria-label": `Accept lines ${x.startLine} to ${x.endLine}`, onclick: () => s.acceptHunk(x.id) }, "✓"),
        h("button", { class: "btn sm", "aria-label": `Reject lines ${x.startLine} to ${x.endLine}`, onclick: () => s.rejectHunk(x.id) }, "✕")));
    }
    this.hunkbar.append(h("span", { style: "flex:1" }),
      h("button", { class: "btn sm", onclick: () => s.rejectAll(file) }, "Reject all"),
      h("button", { class: "btn sm pri", onclick: () => s.acceptAll(file) }, "Accept all"));
  }

  // ---- commands and keys ---------------------------------------------------

  registerCommand(c: CommandDef): void {
    if (this.commands.has(c.id)) throw new Error(`command exists: ${c.id}`);
    this.commands.set(c.id, c);
    if (c.id === "blackhole.runOnVm") this.renderTabActions();
  }

  async executeCommand(id: string, ...args: any[]): Promise<unknown> {
    const c = this.commands.get(id);
    if (!c) {
      if (id === "blackhole.runOnVm") return toast("Run on VM arrives with the VM module.", "warn");
      throw new Error(`unknown command ${id}`);
    }
    return c.run(...args);
  }

  private onKey(e: KeyboardEvent): void {
    for (const c of this.commands.values()) {
      if (c.keybinding && matches(c.keybinding, e)) {
        e.preventDefault();
        e.stopPropagation();
        this.executeCommand(c.id).catch((err) => toast(String(err.message ?? err), "error"));
        return;
      }
    }
  }

  // ---- status bar ----------------------------------------------------------

  registerStatusItem(s: StatusItemDef): StatusItemHandle {
    const el = s.side === "title"
      ? h("button", { class: "chip", title: s.title, onclick: () => s.command && this.executeCommand(s.command) }, s.text)
      : h("button", { title: s.title, onclick: () => s.command && this.executeCommand(s.command) }, s.text);
    (s.side === "left" ? this.statusLeft : s.side === "right" ? this.statusRight : this.titleItems).append(el);
    return {
      update: (text, title) => {
        el.textContent = text;
        if (title !== undefined) el.title = title;
      },
      dispose: () => el.remove(),
    };
  }

  // ---- helper, lint, problems ---------------------------------------------

  private helperItem?: StatusItemHandle;
  private lintItem?: StatusItemHandle;

  initStatus(): void {
    this.lintItem = this.registerStatusItem({ id: "lint", side: "left", text: "recipe lint –", command: "panel.problems" });
    this.helperItem = this.registerStatusItem({ id: "helper", side: "left", text: "blackhole_dev starting…", command: "helper.restart", title: "Python helper" });
  }

  setHelperStatus(s: HelperStatus): void {
    this.helperStatus = s;
    const t =
      s.state === "ready" ? `blackhole_dev ${s.version ?? "?"} · Python ${s.python ?? "?"}`
      : s.state === "starting" ? `blackhole_dev starting…${s.error ? " (" + s.error + ")" : ""}`
      : s.state === "missing" ? "⚠ Python not found: click to retry"
      : `⚠ blackhole_dev down: click to retry`;
    this.helperItem?.update(t, s.error ?? "Python helper");
    if (s.state === "ready") for (const b of this.editor.buffers.keys()) this.lintSoon(b);
  }

  private lintTimers = new Map<string, () => void>();

  lintSoon(path: string): void {
    if (!this.paths || !path.endsWith(".py") || !(path.startsWith(this.paths.recipes) || path.startsWith(this.paths.functions))) return;
    let run = this.lintTimers.get(path);
    if (!run) {
      run = debounce(() => this.lint(path), 450);
      this.lintTimers.set(path, run);
    }
    run();
  }

  async lint(path: string): Promise<void> {
    if (this.helperStatus.state !== "ready") return;
    const b = this.editor.buffers.get(path);
    if (!b) return;
    try {
      const r = await helper("recipe.lint", { path, text: b.model.getValue() });
      this.setProblems(path, r.problems);
    } catch (e) {
      this.setProblems(path, [{ severity: "error", message: `lint failed: ${(e as Error).message}`, file: path, line: 1, code: "lint" }]);
    }
  }

  setProblems(path: string, problems: Problem[]): void {
    if (problems.length) this.problems.set(path, problems);
    else this.problems.delete(path);
    this.editor.setProblems(path, problems);
    const all = [...this.problems.values()].flat();
    const errors = all.filter((p) => p.severity === "error").length;
    const warns = all.filter((p) => p.severity === "warning").length;
    this.lintItem?.update(all.length ? `recipe lint ✕ ${errors} · ⚠ ${warns}` : "recipe lint ✓");
    this.setPanelTitle("problems", `PROBLEMS ${all.length}`);
    this.problemCbs.forEach((cb) => cb());
  }

  onProblems(cb: () => void): Dispose {
    this.problemCbs.add(cb);
    return () => this.problemCbs.delete(cb);
  }

  // ---- context for modules ---------------------------------------------------

  readonly terminal: TerminalApi = {
    create: async (o) => {
      const id = await bh.invoke<string>("term:create", o);
      this.executeCommand("terminal.attach", id, o.title).catch(() => undefined);
      return id;
    },
    write: (id, d) => void bh.invoke("term:write", id, d),
    onData: (id, cb) => bh.on("term:data", (p: { id: string; data: string }) => p.id === id && cb(p.data)),
    onExit: (id, cb) => bh.on("term:exit", (p: { id: string; code: number | null }) => p.id === id && cb(p.code)),
    focus: (id) => void this.executeCommand("terminal.focus", id),
    dispose: (id) => void bh.invoke("term:dispose", id),
  };

  readonly workspace: WorkspaceApi = {
    activeFile: () => this.activeFile(),
    onActiveFile: (cb) => {
      this.activeFileCbs.add(cb);
      return () => this.activeFileCbs.delete(cb);
    },
    open: (path, line) => this.openFile(path, line),
    listRecipes: async () => flatten(await bh.invoke("ws:list", this.paths.recipes)),
    readFile: (path) => {
      const b = this.editor.buffers.get(path);
      return b ? Promise.resolve(b.model.getValue()) : bh.invoke<string>("ws:read", path);
    },
    paths: async () => this.paths,
  };

  readonly gate = { confirm: (req: ConfirmRequest) => bh.invoke<boolean>("gate:confirm", req) };

  contextFor(module: string): RendererContext {
    const prefix = (id: string) => (id.includes(".") || id.includes(":") ? id : `${module}.${id}`);
    return {
      module,
      registerActivity: (a) => this.registerActivity(a),
      registerSidebarView: (id, v) => this.registerSidebarView(id, v),
      registerPanel: (p) => this.registerPanel(p),
      registerRightPanel: (p) => this.registerRightPanel(p),
      registerTabType: (t) => this.registerTabType(t),
      openTab: (id, s) => this.openTab(id, s),
      showModal,
      registerCommand: (c) => this.registerCommand({ ...c, id: prefix(c.id) }),
      executeCommand: (id, ...a) => this.executeCommand(id, ...a),
      registerStatusItem: (s) => this.registerStatusItem(s),
      registerRecipeAction: (a) => void this.recipeActions.push(a),
      registerOverviewSection: (s) => void this.overviewSections.push(s),
      registerSettingsSection: (s) => void this.settingsSections.push(s),
      invoke: (channel, ...a) => bh.invoke(channel, ...a),
      on: (channel, cb) => bh.on(channel, cb),
      editor: this.editor.streams,
      gate: this.gate,
      terminal: this.terminal,
      workspace: this.workspace,
      notify: (m, k) => toast(m, k),
      theme: THEME,
    };
  }
}

function flatten(entries: { path: string; dir: boolean; children?: any[] }[]): string[] {
  return entries.flatMap((e) => (e.dir ? flatten(e.children ?? []) : [e.path]));
}
