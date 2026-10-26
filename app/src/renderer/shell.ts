// The app shell: layout (title bar, activity bar, sidebar, tabs + editor, bottom panel, right
// panel, status bar) and the registries behind RendererContext.

import { h, clear, basename, debounce, ICONS } from "./dom";
import { bh, helper } from "./bridge";
import { EditorManager, type EditorView } from "./editor/monaco";
import { contextMenu, showModal, toast } from "./ui";
import { isMac, matches, prettyKeys } from "./keys";
import { KEYMAP } from "./shortcuts";
import { dropZone, groupsOf, leaf, remove, split, type LayoutNode, type Side } from "./layout";
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

export interface Tab {
  key: string;
  type: string;
  state: any;
  title: string;
  group: Group;
  button: HTMLButtonElement;
  pane?: HTMLElement;
  dispose?: void | Dispose;
}

/** An editor group: a tab strip with its own Monaco view. Groups are laid out by layout.ts. */
export interface Group {
  id: number;
  el: HTMLElement;
  tablist: HTMLElement;
  tabActions: HTMLElement;
  groupActions: HTMLElement;
  crumbs: HTMLElement;
  hunkbar: HTMLElement;
  host: HTMLElement;
  monacoPane: HTMLElement;
  drop: HTMLElement;
  view: EditorView;
  tabs: Tab[];
  active: Tab | null;
}

const ICON_SPLIT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>';
const ICON_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M11 6 8.5 8 11 10M8.5 8H14"/></svg>';

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
  private layout!: LayoutNode<Group>;
  private activeGroup!: Group;
  private groupSeq = 1;
  private dragTab: Tab | null = null;
  private closed: { type: string; state: any }[] = [];
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
  private editorArea = h("div", { class: "editor-area" });
  private panel = h("section", { class: "panel", "aria-label": "Panel" });
  private panelTabs = h("div", { class: "panel-tabs", role: "tablist" });
  readonly panelNote = h("span", { class: "panel-note" });
  private panelBody = h("div", { class: "panel-body" });
  private right = h("aside", { class: "right", "aria-label": "Inspector" });
  private rightTabs = h("div", { class: "right-tabs", role: "tablist" });
  private rightBody = h("div", { class: "right-body" });
  private rightClose = h("button", { class: "right-close", title: `Hide the right side bar (${prettyKeys("Cmd+Alt+B")})`, "aria-label": "Hide the right side bar", onclick: () => this.hideRight() }, "×");
  /** Saving waits for restoreLayout(), so boot defaults never overwrite what the user left. */
  private layoutRestored = false;
  private statusLeft = h("div", { class: "row", style: "gap:18px;flex-wrap:nowrap" });
  private statusRight = h("div", { class: "row", style: "gap:18px;flex-wrap:nowrap" });

  constructor(mount: HTMLElement) {
    this.root = mount;
    this.panel.append(this.panelTabs, this.panelBody);
    this.panelTabs.append(this.panelNote);
    this.right.append(this.rightTabs, this.rightBody);
    this.rightTabs.append(this.rightClose);

    const title = h("header", { class: `titlebar${isMac ? " mac" : ""}` },
      h("div", { class: "brand" }, h("span", { html: ICONS.logo }), h("b", null, "BLACKHOLE", h("span", null, "//"), "DEV")),
      h("div", { class: "search" }, h("button", { onclick: () => this.executeCommand("palette.open") }, `search recipes, functions, commands  ${prettyKeys("Cmd+P")}`)),
      this.titleItems);
    const center = h("main", { class: "center" },
      this.editorArea,
      this.sash("h", this.panel, "height", -1, 120, 700),
      this.panel);
    const body = h("div", { class: "body" },
      h("nav", { class: "activity", "aria-label": "Activity bar" }, this.activityTop, this.activityBottom),
      this.sidebar, this.sash("v", this.sidebar, "width", 1, 200, 560, (open) => (open ? this.showActivity(this.activeActivity ?? "recipes") : this.hideSidebar())),
      center,
      this.sash("v", this.right, "width", -1, 260, 640, (open) => (open ? this.toggleRight() : this.hideRight())), this.right);
    const status = h("footer", { class: "status" }, this.statusLeft, h("div", { class: "spacer" }), this.statusRight);
    mount.append(title, body, status);
    this.editor = new EditorManager();
    const first = this.newGroup();
    this.layout = leaf(first);
    this.activeGroup = first;
    first.el.classList.add("active");
    this.renderLayout();
    this.editor.on("dirty", (b) => this.refreshTabButton(b.path));
    this.editor.on("change", (b) => this.lintSoon(b.path));
    this.editor.on("hunks", (file) => this.renderHunkbar(file));
    this.right.classList.add("hidden");
    window.addEventListener("keydown", (e) => this.onKey(e), true);
    bh.on("app:command", (id: string) => this.executeCommand(id).catch((e) => toast(String(e.message ?? e), "error")));
    bh.on("helper:status", (s: HelperStatus) => this.setHelperStatus(s));
  }

  // ---- layout pieces -------------------------------------------------------

  /** A drag handle. With `toggle`, dragging past half the minimum collapses the target and
   *  dragging a collapsed target back out reopens it (as in VS Code). */
  private sash(dir: "v" | "h", target: HTMLElement, prop: "width" | "height", sign: 1 | -1, min: number, max: number, toggle?: (open: boolean) => void): HTMLElement {
    const s = h("div", { class: `sash ${dir}`, role: "separator", "aria-orientation": dir === "v" ? "vertical" : "horizontal" });
    s.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const start = dir === "v" ? e.clientX : e.clientY;
      const hidden = () => target.classList.contains("hidden");
      const size = hidden() ? 0 : target.getBoundingClientRect()[prop];
      s.classList.add("drag");
      const move = (ev: MouseEvent) => {
        const want = size + sign * ((dir === "v" ? ev.clientX : ev.clientY) - start);
        if (toggle && want < min / 2) {
          if (!hidden()) toggle(false);
          return;
        }
        if (hidden()) {
          if (!toggle) return;
          toggle(true);
        }
        target.style[prop] = `${Math.min(max, Math.max(min, want))}px`;
      };
      const up = () => {
        s.classList.remove("drag");
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        this.saveLayout();
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    return s;
  }

  // ---- activities and sidebar --------------------------------------------

  registerActivity(def: ActivityDef, bottom = false): void {
    if (this.activities.has(def.id)) throw new Error(`activity exists: ${def.id}`);
    const button = h("button", { class: "ab", "aria-label": def.title, title: def.title, html: def.icon, onclick: () => this.clickActivity(def.id) });
    button.dataset.order = String(def.order ?? 100);
    this.activities.set(def.id, { def, button });
    const box = bottom ? this.activityBottom : this.activityTop;
    const after = [...box.children].find((c) => Number((c as HTMLElement).dataset.order) > (def.order ?? 100));
    box.insertBefore(button, after ?? null);
    this.markActivities();
  }

  /** Clicking an icon opens its side bar; clicking the icon of the open one collapses it. */
  clickActivity(id: string): void {
    const a = this.activities.get(id);
    if (!a) return;
    const { def } = a;
    if (def.rightPanel) {
      if (this.isRightOpen(def.rightPanel)) this.hideRight();
      else if (def.run) def.run();
      else this.showRight(def.rightPanel);
    } else if (def.run) def.run();
    else this.toggleActivity(id);
  }

  /** Lights the icon of each open side bar: one on the left, one for the right. */
  private markActivities(): void {
    const left = this.sidebar.classList.contains("hidden") ? null : this.activeActivity;
    const right = this.right.classList.contains("hidden") ? null : this.activeRight;
    for (const [k, x] of this.activities) {
      const on = x.def.rightPanel ? x.def.rightPanel === right : k === left;
      x.button.classList.toggle("on", on);
      x.button.setAttribute("aria-pressed", String(on));
    }
  }

  registerSidebarView(activityId: string, v: { render: Mount }): void {
    const a = this.activities.get(activityId);
    if (!a) throw new Error(`no activity ${activityId}`);
    a.view = v;
    if (this.activeActivity === activityId) this.showActivity(activityId);
  }

  toggleActivity(id: string): void {
    if (this.activeActivity === id && !this.sidebar.classList.contains("hidden")) this.hideSidebar();
    else this.showActivity(id);
  }

  hideSidebar(): void {
    this.sidebar.classList.add("hidden");
    this.markActivities();
    this.saveLayout();
  }

  showActivity(id: string): void {
    const a = this.activities.get(id);
    if (!a) return;
    for (const x of this.activities.values()) x.pane?.classList.add("hidden");
    this.activeActivity = id;
    this.sidebar.classList.remove("hidden");
    this.markActivities();
    this.saveLayout();
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
    this.addSlot(this.rights, this.rightTabs, this.rightBody, def, (id) => this.showRight(id), this.rightClose);
    if (!this.activeRight) this.pick(this.rights, def.id), (this.activeRight = def.id);
  }

  showRight(id: string): void {
    if (!this.rights.has(id)) return;
    this.right.classList.remove("hidden");
    if (this.pick(this.rights, id)) this.activeRight = id;
    this.markActivities();
    this.saveLayout();
  }

  hideRight(): void {
    this.right.classList.add("hidden");
    this.markActivities();
    this.saveLayout();
  }

  isRightOpen(id?: string): boolean {
    return !this.right.classList.contains("hidden") && (id === undefined || this.activeRight === id);
  }

  toggleRight(): void {
    if (this.isRightOpen()) this.hideRight();
    else if (this.activeRight) this.showRight(this.activeRight);
  }

  // ---- saved side bar layout -----------------------------------------------

  private static readonly LAYOUT_KEY = "bh.shell.sidebars";

  private saveLayout(): void {
    if (!this.layoutRestored) return;
    const side = (el: HTMLElement, active: string | null) => ({ open: !el.classList.contains("hidden"), active, width: el.style.width || undefined });
    try {
      localStorage.setItem(Shell.LAYOUT_KEY, JSON.stringify({ left: side(this.sidebar, this.activeActivity), right: side(this.right, this.activeRight) }));
    } catch {
      /* storage unavailable: the layout just isn't remembered */
    }
  }

  /** Reopens the side bars as the user left them. Call once every module has registered. */
  restoreLayout(): void {
    type Side = { open?: boolean; active?: string | null; width?: string };
    let saved: { left?: Side; right?: Side } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(Shell.LAYOUT_KEY) ?? "null");
    } catch {
      saved = null;
    }
    const width = (el: HTMLElement, w?: string) => w && /^\d+(\.\d+)?px$/.test(w) && (el.style.width = w);
    if (saved?.left) {
      const { open, active, width: w } = saved.left;
      width(this.sidebar, w);
      if (active && this.activities.has(active) && !this.activities.get(active)!.def.run && !this.activities.get(active)!.def.rightPanel) this.activeActivity = active;
      if (open === false) this.sidebar.classList.add("hidden");
      else this.showActivity(this.activeActivity ?? "recipes");
    }
    if (saved?.right) {
      const { open, active, width: w } = saved.right;
      width(this.right, w);
      if (active && this.rights.has(active)) this.activeRight = active;
      if (open && this.activeRight) this.showRight(this.activeRight);
    }
    this.markActivities();
    this.layoutRestored = true;
  }

  // ---- editor groups and tabs ---------------------------------------------
  // The editor area is a tree of groups (layout.ts). Each group has its own tab strip and
  // Monaco editor; drag a tab onto a group's edge to split, onto a tab or tab strip to move it.

  private newGroup(): Group {
    const tablist = h("div", { class: "tablist", role: "tablist" });
    const monacoHost = h("div", { class: "monaco-host" });
    const monacoPane = h("div", { class: "pane hidden" }, monacoHost);
    const drop = h("div", { class: "drop-zone", "aria-hidden": "true" });
    const host = h("div", { class: "editor-host" }, monacoPane, drop);
    const g: Group = {
      id: this.groupSeq++,
      el: h("section", { class: "group", "aria-label": "Editor group" }),
      tablist, tabActions: h("div", { class: "tab-actions" }), groupActions: h("div", { class: "group-actions" }),
      crumbs: h("div", { class: "crumbs", style: "display:none" }), hunkbar: h("div", { class: "hunkbar hidden", "aria-label": "Copilot changes" }),
      host, monacoPane, drop, view: this.editor.createView(monacoHost), tabs: [], active: null,
    };
    g.el.append(h("div", { class: "tabs" }, tablist, g.tabActions, g.groupActions), g.crumbs, g.hunkbar, host);
    g.el.addEventListener("mousedown", () => this.setActiveGroup(g), true);
    tablist.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) tablist.scrollLeft += e.deltaY;
    }, { passive: true });
    tablist.addEventListener("dragover", (e) => {
      if (!this.dragTab || e.target !== tablist) return;
      e.preventDefault();
      this.clearDropMarks();
      tablist.classList.add("drop-end");
    });
    tablist.addEventListener("dragleave", () => tablist.classList.remove("drop-end"));
    tablist.addEventListener("drop", (e) => {
      if (!this.dragTab || e.target !== tablist) return;
      e.preventDefault();
      this.moveTab(this.dragTab, g, g.tabs.length);
    });
    drop.addEventListener("dragover", (e) => {
      if (!this.dragTab) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      drop.dataset.zone = dropZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    drop.addEventListener("dragleave", () => delete drop.dataset.zone);
    drop.addEventListener("drop", (e) => {
      const tab = this.dragTab;
      const zone = drop.dataset.zone as Side | "center" | undefined;
      delete drop.dataset.zone;
      if (!tab || !zone) return;
      e.preventDefault();
      if (zone === "center") this.moveTab(tab, g, g.tabs.length);
      else if (!(tab.group === g && g.tabs.length === 1)) this.splitWith(tab, g, zone);
    });
    return g;
  }

  /** All groups in layout order (left to right, top to bottom). */
  groups(): Group[] {
    return groupsOf(this.layout);
  }

  private renderLayout(): void {
    const build = (n: LayoutNode<Group>): HTMLElement => {
      if (n.kind === "leaf") return n.group.el;
      const box = h("div", { class: `split split-${n.dir}` });
      n.children.forEach((c, i) => {
        if (i > 0) box.append(this.groupSash(n, i, box));
        const el = build(c);
        el.style.flex = `${n.sizes[i]} 1 0px`;
        box.append(el);
      });
      return box;
    };
    const root = build(this.layout);
    root.style.flex = "1 1 0px";
    clear(this.editorArea);
    this.editorArea.append(root);
    const gs = this.groups();
    this.editorArea.classList.toggle("multi", gs.length > 1);
    gs.forEach((g, i) => this.renderGroupActions(g, i, gs.length));
  }

  /** Divider between two neighbours of a split: drag to set their widths (or heights). */
  private groupSash(n: Extract<LayoutNode<Group>, { kind: "split" }>, i: number, box: HTMLElement): HTMLElement {
    const row = n.dir === "row";
    const s = h("div", { class: `sash gsash ${row ? "v" : "h"}`, role: "separator", "aria-orientation": row ? "vertical" : "horizontal", title: "Drag to resize, double-click to even out" });
    s.addEventListener("dblclick", () => {
      const pair = n.sizes[i - 1] + n.sizes[i];
      n.sizes[i - 1] = n.sizes[i] = pair / 2;
      this.renderLayout();
    });
    s.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const a = s.previousElementSibling as HTMLElement;
      const b = s.nextElementSibling as HTMLElement;
      const pa = row ? a.getBoundingClientRect().width : a.getBoundingClientRect().height;
      const pb = row ? b.getBoundingClientRect().width : b.getBoundingClientRect().height;
      const total = n.sizes[i - 1] + n.sizes[i];
      const start = row ? e.clientX : e.clientY;
      const min = 140;
      s.classList.add("drag");
      document.body.classList.add(row ? "resizing-v" : "resizing-h");
      const move = (ev: MouseEvent) => {
        const d = Math.min(pb - min, Math.max(min - pa, (row ? ev.clientX : ev.clientY) - start));
        n.sizes[i - 1] = ((pa + d) / (pa + pb)) * total;
        n.sizes[i] = total - n.sizes[i - 1];
        a.style.flex = `${n.sizes[i - 1]} 1 0px`;
        b.style.flex = `${n.sizes[i]} 1 0px`;
      };
      const up = () => {
        s.classList.remove("drag");
        document.body.classList.remove("resizing-v", "resizing-h");
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    void box;
    return s;
  }

  private renderGroupActions(g: Group, index: number, count: number): void {
    clear(g.groupActions);
    g.groupActions.append(h("button", { class: "gbtn", title: `Split right (${prettyKeys("Cmd+\\")})`, "aria-label": "Split right", html: ICON_SPLIT, onclick: () => this.splitActive("right", g) }));
    if (count > 1)
      g.groupActions.append(h("button", {
        class: "gbtn", title: `Collapse into ${index === 0 ? "the next" : "the previous"} group (${prettyKeys("Cmd+Alt+J")})`, "aria-label": "Collapse group", html: ICON_COLLAPSE,
        onclick: (e: Event) => { e.stopPropagation(); this.collapseGroup(g); },
      }));
  }

  get activeGroupRef(): Group {
    return this.activeGroup;
  }

  setActiveGroup(g: Group): void {
    if (this.activeGroup === g) return;
    this.activeGroup = g;
    for (const x of this.groups()) x.el.classList.toggle("active", x === g);
    if (g.view) this.editor.setActiveView(g.view);
    const file = this.activeFile();
    this.activeFileCbs.forEach((cb) => cb(file));
  }

  registerTabType<S>(t: TabTypeDef<S>): void {
    if (this.tabTypes.has(t.id)) throw new Error(`tab type exists: ${t.id}`);
    this.tabTypes.set(t.id, t as TabTypeDef);
  }

  private allTabs(): Tab[] {
    return this.groups().flatMap((g) => g.tabs);
  }

  private findTab(key: string, prefer?: Group): Tab | undefined {
    return prefer?.tabs.find((x) => x.key === key) ?? this.activeGroup.tabs.find((x) => x.key === key) ?? this.allTabs().find((x) => x.key === key);
  }

  openTab<S>(typeId: string, state: S): void {
    const t = this.tabTypes.get(typeId);
    if (!t) throw new Error(`no tab type ${typeId}`);
    const key = `${typeId}:${t.key ? t.key(state) : JSON.stringify(state)}`;
    const have = this.findTab(key);
    if (have) return this.focusTab(have);
    const tab = this.addTab(this.activeGroup, key, typeId, state, t.title(state));
    this.focusTab(tab);
  }

  private addTab(g: Group, key: string, type: string, state: any, title: string, index = g.tabs.length): Tab {
    const tab = { key, type, state, title, group: g } as Tab;
    tab.button = this.tabButton(tab);
    this.insertTab(g, tab, index);
    return tab;
  }

  private insertTab(g: Group, tab: Tab, index: number): void {
    index = Math.max(0, Math.min(index, g.tabs.length));
    tab.group = g;
    g.tabs.splice(index, 0, tab);
    g.tablist.insertBefore(tab.button, g.tabs[index + 1]?.button ?? null);
    if (tab.pane) g.host.append(tab.pane);
  }

  private tabButton(tab: Tab): HTMLButtonElement {
    const title = tab.title;
    const x = h("span", { class: "x", role: "button", "aria-label": `Close ${title}`, onclick: (e: Event) => { e.stopPropagation(); this.closeTab(tab); } }, h("span", null, "✕"));
    const b = h("button", {
      class: "tab", role: "tab", title, draggable: "true",
      onclick: () => this.focusTab(tab),
      onauxclick: (e: MouseEvent) => e.button === 1 && this.closeTab(tab),
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.tabMenu(tab, e.clientX, e.clientY); },
    }, h("span", { class: "tab-title" }, title), x);
    b.addEventListener("dragstart", (e) => {
      this.dragTab = tab;
      e.dataTransfer?.setData("application/x-bh-tab", tab.key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => document.body.classList.add("tab-drag"));
    });
    b.addEventListener("dragend", () => {
      this.dragTab = null;
      document.body.classList.remove("tab-drag");
      this.clearDropMarks();
    });
    b.addEventListener("dragover", (e) => {
      if (!this.dragTab) return;
      e.preventDefault();
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      this.clearDropMarks();
      b.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-before", "drop-after"));
    b.addEventListener("drop", (e) => {
      const moving = this.dragTab;
      if (!moving) return;
      e.preventDefault();
      e.stopPropagation();
      const before = b.classList.contains("drop-before");
      this.clearDropMarks();
      const g = tab.group;
      let i = g.tabs.indexOf(tab) + (before ? 0 : 1);
      if (moving.group === g && g.tabs.indexOf(moving) < i) i--;
      this.moveTab(moving, g, i);
    });
    return b;
  }

  private clearDropMarks(): void {
    document.querySelectorAll(".drop-before,.drop-after,.drop-end").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-end"));
    document.querySelectorAll<HTMLElement>(".drop-zone[data-zone]").forEach((el) => delete el.dataset.zone);
  }

  private tabMenu(tab: Tab, x: number, y: number): void {
    const g = tab.group;
    const multi = this.groups().length > 1;
    const path = tab.type === "file" ? (tab.state.path as string) : null;
    contextMenu(x, y, [
      { label: "Close", hint: prettyKeys("Cmd+W"), run: () => this.closeTab(tab) },
      { label: "Close others", run: () => g.tabs.filter((t) => t !== tab).forEach((t) => this.closeTab(t)) },
      { label: "Close to the right", run: () => g.tabs.slice(g.tabs.indexOf(tab) + 1).forEach((t) => this.closeTab(t)) },
      { label: "Close all in group", run: () => [...g.tabs].forEach((t) => this.closeTab(t)) },
      { sep: true, label: "" },
      { label: "Split right", hint: prettyKeys("Cmd+\\"), run: () => this.splitTab(tab, "right") },
      { label: "Split down", hint: prettyKeys("Cmd+Alt+\\"), run: () => this.splitTab(tab, "down") },
      { label: "Move to next group", disabled: !multi, run: () => { const gs = this.groups(); const n = gs[(gs.indexOf(g) + 1) % gs.length]; this.moveTab(tab, n, n.tabs.length); } },
      { label: "Collapse group into previous", disabled: !multi, hint: prettyKeys("Cmd+Alt+J"), run: () => this.collapseGroup(g) },
      ...(path ? [
        { sep: true, label: "" },
        { label: "Copy path", run: () => navigator.clipboard?.writeText(path) },
        { label: "Reveal in Finder", run: () => bh.invoke("app:reveal", path).catch(() => undefined) },
      ] : []),
    ]);
  }

  async openFile(path: string, line?: number, opts: { readonly?: boolean; text?: string; title?: string; group?: Group; create?: boolean } = {}): Promise<void> {
    const key = `file:${path}`;
    let tab = opts.group ? opts.group.tabs.find((x) => x.key === key) : this.findTab(key);
    if (!tab) {
      try {
        await this.editor.load(path, opts);
      } catch (err) {
        if (!opts.create) throw err;
        this.editor.modelFor(path);
      }
      tab = this.addTab(opts.group ?? this.activeGroup, key, "file", { path }, opts.title ?? basename(path));
      this.lintSoon(path);
    }
    this.focusTab(tab, line);
  }

  /** Show a tab inside its group without moving focus to that group. */
  private showTab(tab: Tab, line?: number, focus = false): void {
    const g = tab.group;
    g.active = tab;
    for (const t of g.tabs) {
      t.button.classList.toggle("on", t === tab);
      t.button.setAttribute("aria-selected", String(t === tab));
      t.pane?.classList.add("hidden");
    }
    tab.button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const isFile = tab.type === "file";
    g.monacoPane.classList.toggle("hidden", !isFile);
    g.crumbs.style.display = isFile ? "" : "none";
    if (isFile) {
      this.editor.show(tab.state.path, line, g.view, focus);
      this.renderCrumbs(g);
      this.renderHunkbar(tab.state.path);
    } else {
      if (g.view.buffer) this.editor.hide(g.view);
      g.hunkbar.classList.add("hidden");
      if (!tab.pane) {
        tab.pane = h("div", { class: "pane" });
        g.host.append(tab.pane);
        tab.dispose = this.tabTypes.get(tab.type)!.render(tab.pane, tab.state);
      }
      tab.pane.classList.remove("hidden");
    }
    this.renderTabActions(g);
  }

  focusTab(tab: Tab, line?: number): void {
    this.activeGroup = tab.group;
    for (const x of this.groups()) x.el.classList.toggle("active", x === tab.group);
    this.editor.setActiveView(tab.group.view);
    this.showTab(tab, line, true);
    const file = this.activeFile();
    this.activeFileCbs.forEach((cb) => cb(file));
  }

  private showEmpty(g: Group): void {
    g.active = null;
    g.monacoPane.classList.add("hidden");
    g.crumbs.style.display = "none";
    g.hunkbar.classList.add("hidden");
    if (g.view.buffer) this.editor.hide(g.view);
    this.renderTabActions(g);
  }

  /** Take a tab out of its group (the tab and its pane stay alive). Removes an emptied group. */
  private detachTab(tab: Tab): { group: Group; index: number; removed: boolean } {
    const g = tab.group;
    const i = g.tabs.indexOf(tab);
    g.tabs.splice(i, 1);
    tab.button.remove();
    tab.button.classList.remove("on");
    if (g.active === tab) {
      const next = g.tabs[Math.min(i, g.tabs.length - 1)];
      if (next) this.showTab(next);
      else if (this.groups().length > 1) {
        this.removeGroup(g);
        return { group: g, index: i, removed: true };
      } else this.showEmpty(g);
    }
    return { group: g, index: i, removed: false };
  }

  closeTab(tab: Tab, force = false): void {
    const path = tab.type === "file" ? (tab.state.path as string) : null;
    const shared = path ? this.allTabs().some((t) => t !== tab && t.key === tab.key) : false;
    if (!force && path && !shared && this.editor.isDirty(path) && !confirm(`${basename(path)} has unsaved changes. Close anyway?`)) return;
    const wasActive = this.activeGroup === tab.group && tab.group.active === tab;
    this.closed.push({ type: tab.type, state: tab.state });
    if (this.closed.length > 30) this.closed.shift();
    const { group } = this.detachTab(tab);
    if (path) {
      if (!shared) this.editor.close(path);
      else if (group.view.buffer?.path === path && group.active?.key !== tab.key) this.editor.hide(group.view);
    } else {
      if (typeof tab.dispose === "function") tab.dispose();
      tab.pane?.remove();
    }
    if (wasActive) {
      const g = this.groups().includes(group) ? group : this.activeGroup;
      if (g.active) this.focusTab(g.active);
      else {
        this.setActiveGroup(g);
        this.activeFileCbs.forEach((cb) => cb(this.activeFile()));
      }
    }
  }

  closeActiveTab(): void {
    if (this.activeGroup.active) this.closeTab(this.activeGroup.active);
  }

  /** Reopen the most recently closed tab. */
  async reopenClosed(): Promise<void> {
    const t = this.closed.pop();
    if (!t) return;
    if (t.type === "file") await this.openFile(t.state.path).catch(() => this.reopenClosed());
    else if (this.tabTypes.has(t.type)) this.openTab(t.type, t.state);
  }

  /** Move a tab into a group at an index (same group reorders). A duplicate file tab merges. */
  moveTab(tab: Tab, target: Group, index: number): void {
    if (tab.group === target) {
      const i = target.tabs.indexOf(tab);
      target.tabs.splice(i, 1);
      target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, tab);
      target.tablist.insertBefore(tab.button, target.tabs[target.tabs.indexOf(tab) + 1]?.button ?? null);
      return this.focusTab(tab);
    }
    const dup = target.tabs.find((t) => t.key === tab.key);
    if (dup) {
      this.closeTab(tab, true);
      return this.focusTab(dup);
    }
    const from = tab.group;
    const fromShowed = tab.type === "file" && from.view.buffer?.path === tab.state.path;
    this.detachTab(tab);
    if (fromShowed && this.groups().includes(from) && from.active?.key !== tab.key) this.editor.hide(from.view);
    this.insertTab(target, tab, index);
    this.focusTab(tab);
  }

  /** Split `target` on a side and move the tab into the new group. */
  splitWith(tab: Tab, target: Group, side: Side): Group {
    const g = this.newGroup();
    this.layout = split(this.layout, target, g, side);
    this.renderLayout();
    this.moveTab(tab, g, 0);
    return g;
  }

  /** Split a tab into a new group: files open a second view of the same buffer, other tabs move. */
  splitTab(tab: Tab, side: Side): void {
    if (tab.type !== "file") {
      if (tab.group.tabs.length > 1) this.splitWith(tab, tab.group, side);
      return;
    }
    const g = this.newGroup();
    this.layout = split(this.layout, tab.group, g, side);
    this.renderLayout();
    this.openFile(tab.state.path, undefined, { group: g, title: tab.title });
  }

  splitActive(side: Side, g: Group = this.activeGroup): void {
    if (g.active) this.splitTab(g.active, side);
    else toast("Open a tab first, then split it.", "warn");
  }

  private removeGroup(g: Group): void {
    if (this.groups().length < 2) return;
    this.layout = remove(this.layout, g);
    this.editor.disposeView(g.view);
    g.el.remove();
    if (this.activeGroup === g) {
      this.activeGroup = this.groups()[0];
      this.editor.setActiveView(this.activeGroup.view);
    }
    this.renderLayout();
    for (const x of this.groups()) x.el.classList.toggle("active", x === this.activeGroup);
  }

  /** Fold a group's tabs into its neighbour (the previous group, or the next for the first). */
  collapseGroup(g: Group = this.activeGroup): void {
    const gs = this.groups();
    if (gs.length < 2) return;
    const i = gs.indexOf(g);
    const into = gs[i - 1] ?? gs[i + 1];
    const keep = g.active;
    for (const t of [...g.tabs]) this.moveTab(t, into, into.tabs.length);
    if (this.groups().includes(g)) this.removeGroup(g);
    const shown = keep && into.tabs.find((t) => t.key === keep.key);
    if (shown) this.focusTab(shown);
  }

  joinAllGroups(): void {
    while (this.groups().length > 1) this.collapseGroup(this.groups()[this.groups().length - 1]);
  }

  /** Next (+1) or previous (-1) tab in the active group. */
  cycleTab(step: number): void {
    const g = this.activeGroup;
    if (!g.tabs.length) return;
    const i = g.active ? g.tabs.indexOf(g.active) : -1;
    this.focusTab(g.tabs[(i + step + g.tabs.length) % g.tabs.length]);
  }

  /** Next (+1) or previous (-1) group. */
  cycleGroup(step: number): void {
    const gs = this.groups();
    this.focusGroup((gs.indexOf(this.activeGroup) + step + gs.length) % gs.length);
  }

  focusGroup(n: number): void {
    const g = this.groups()[n];
    if (!g) return;
    if (g.active) this.focusTab(g.active);
    else this.setActiveGroup(g);
  }

  fileRenamed(from: string, to: string): void {
    const tabs = this.allTabs().filter((x) => x.key === `file:${from}`);
    if (!tabs.length) return;
    for (const tab of tabs) {
      tab.key = `file:${to}`;
      tab.state = { path: to };
      tab.title = basename(to);
      tab.button.querySelector(".tab-title")!.textContent = tab.title;
    }
    this.editor.rename(from, to);
  }

  fileRemoved(path: string): void {
    for (const tab of this.allTabs().filter((x) => x.key === `file:${path}`)) this.closeTab(tab, true);
  }

  private refreshTabButton(path: string): void {
    const dirty = this.editor.isDirty(path);
    for (const tab of this.allTabs()) if (tab.key === `file:${path}`) tab.button.classList.toggle("dirty", dirty);
  }

  activeFile(): string | null {
    const t = this.activeGroup?.active;
    return t?.type === "file" ? t.state.path : null;
  }

  /** Every file open in a tab (for Save all). */
  openFiles(): string[] {
    return [...new Set(this.allTabs().filter((t) => t.type === "file").map((t) => t.state.path as string))];
  }

  isRecipe(path: string | null): path is string {
    return !!path && !!this.paths && path.startsWith(this.paths.recipes) && path.endsWith(".py");
  }

  private renderCrumbs(g: Group): void {
    clear(g.crumbs);
    const p = g.active?.type === "file" ? (g.active.state.path as string) : null;
    if (!p) return;
    const rel = this.paths && p.startsWith(this.paths.workspace) ? p.slice(this.paths.workspace.length + 1) : p;
    const b = this.editor.buffers.get(p);
    g.crumbs.append(h("span", null, rel.split("/").join(" › ")));
    if (b?.readonly) g.crumbs.append(h("span", { class: "badge" }, "built-in · read only"), h("button", { class: "btn sm", onclick: () => this.executeCommand("function.fork", basename(p).replace(/^builtin:/, "").replace(/\.py$/, "")) }, "Fork to edit"));
    if (this.editor.streams.isStreaming(p)) g.crumbs.append(h("span", { class: "live" }, "● copilot writing"));
  }

  private renderTabActions(g: Group): void {
    clear(g.tabActions);
    const p = g.active?.type === "file" ? (g.active.state.path as string) : null;
    if (!this.isRecipe(p)) return;
    g.tabActions.append(h("button", { class: "btn", onclick: () => { this.focusTab(g.active!); this.executeCommand("recipe.plan"); } }, "Plan"));
    if (this.commands.has("blackhole.runOnVm")) g.tabActions.append(h("button", { class: "btn pri", onclick: () => this.executeCommand("blackhole.runOnVm", p) }, "Run on VM ▸"));
  }

  /** The active group's copilot change bar (kept for callers of the single-editor shell). */
  get hunkbar(): HTMLElement {
    return this.activeGroup.hunkbar;
  }

  renderHunkbar(file: string): void {
    for (const g of this.groups()) {
      if (g.active?.type !== "file" || g.active.state.path !== file) continue;
      const bar = g.hunkbar;
      const hunks = this.editor.streams.hunks(file).filter((x) => x.kind === "copilot" && x.state === "pending");
      clear(bar);
      bar.classList.toggle("hidden", hunks.length === 0);
      this.renderCrumbs(g);
      if (!hunks.length) continue;
      const s = this.editor.streams;
      bar.append(h("span", { class: "tone-warn" }, `Copilot changes · ${hunks.length} pending`));
      for (const x of hunks.slice(0, 8)) {
        bar.append(h("span", { class: "chip" },
          h("button", { class: "btn sm", style: "border:0;background:none;padding:0", onclick: () => this.editor.show(file, x.startLine, g.view) }, x.startLine === x.endLine ? `L${x.startLine}` : `L${x.startLine}–${x.endLine}`),
          h("button", { class: "btn sm", "aria-label": `Accept lines ${x.startLine} to ${x.endLine}`, onclick: () => s.acceptHunk(x.id) }, "✓"),
          h("button", { class: "btn sm", "aria-label": `Reject lines ${x.startLine} to ${x.endLine}`, onclick: () => s.rejectHunk(x.id) }, "✕")));
      }
      bar.append(h("span", { style: "flex:1" }),
        h("button", { class: "btn sm", onclick: () => s.rejectAll(file) }, "Reject all"),
        h("button", { class: "btn sm pri", onclick: () => s.acceptAll(file) }, "Accept all"));
    }
  }

  // ---- commands and keys ---------------------------------------------------

  registerCommand(c: CommandDef): void {
    if (this.commands.has(c.id)) throw new Error(`command exists: ${c.id}`);
    this.commands.set(c.id, c);
    if (c.id === "blackhole.runOnVm") this.groups().forEach((g) => this.renderTabActions(g));
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
    if (e.defaultPrevented || document.querySelector(".overlay")) return;
    const t = e.target as HTMLElement | null;
    const inMonaco = !!t?.closest?.(".monaco-editor");
    const inField = !inMonaco && !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    const run = (id: string, args: unknown[] = []) => {
      e.preventDefault();
      e.stopPropagation();
      this.executeCommand(id, ...args).catch((err) => toast(String(err.message ?? err), "error"));
    };
    for (const b of KEYMAP) {
      if (!matches(b.keys, e) || !this.commands.has(b.command)) continue;
      // Plain keys (no Cmd/Ctrl) keep their meaning in text fields and terminals.
      if (inField && !/(cmd|ctrl)\+/i.test(b.keys)) return;
      if (b.keys === "Shift+Tab" && inMonaco && this.editor.view()?.editor.getSelections()?.some((s) => !s.isEmpty())) return;
      return run(b.command, b.args);
    }
    for (const c of this.commands.values()) if (c.keybinding && matches(c.keybinding, e)) return run(c.id);
  }

  toggleSidebar(): void {
    if (this.sidebar.classList.contains("hidden")) this.showActivity(this.activeActivity ?? "recipes");
    else this.hideSidebar();
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
    if (s.state === "ready") {
      for (const b of this.editor.buffers.keys()) this.lintSoon(b);
      helper("functions.list", {}).then((fns) => this.editor.completion.setFunctions(fns)).catch(() => undefined);
    }
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
    open: (path, line, opts) => this.openFile(path, line, { create: opts?.create }),
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
