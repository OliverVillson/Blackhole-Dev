// Extension points the shell gives to workstream modules (copilot, vm, chat, ...).
// A module exports `activate(ctx)` from src/<module>/main.ts and/or src/<module>/renderer.ts
// and is listed once in src/modules.main.ts / src/modules.renderer.ts.

import type { ConfirmRequest } from "./gate";
import type { EditorStreamApi } from "./editor";
import type { HelperMethod, HelperParams, HelperResult, HelperStatus } from "./rpc";
import type { THEME } from "./theme";

export type Dispose = () => void;
export type Mount = (el: HTMLElement) => void | Dispose;

export interface Licence {
  ok: boolean;
  tier: "dev";
  reason?: string;
}

export interface AppPaths {
  userData: string;
  workspace: string;
  recipes: string;
  functions: string;
  models: string;
}

export interface MainContext {
  readonly module: string;
  handle(channel: string, fn: (...args: any[]) => unknown): void;
  send(channel: string, payload: unknown): void;
  gate: { confirm(req: ConfirmRequest): Promise<boolean> };
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    has(name: string): Promise<boolean>;
    /** False when the OS cannot encrypt (no Keychain); set() then throws. */
    available?(): boolean;
  };
  helper: {
    call<M extends HelperMethod>(method: M, params: HelperParams<M>): Promise<HelperResult<M>>;
    call<T = unknown>(method: string, params?: object): Promise<T>;
    onNotify(method: string, cb: (params: any) => void): Dispose;
    status(): HelperStatus;
  };
  licence: { status(): Licence };
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  paths: AppPaths;
  log(...a: unknown[]): void;
}

export interface MainModule {
  /** May return { deactivate } (called at quit, e.g. to stop a local server). */
  activate(ctx: MainContext): void | { deactivate(): unknown } | Promise<void | { deactivate(): unknown }>;
}

export interface ActivityDef {
  id: string;
  title: string;
  icon: string;
  order?: number;
  /** Runs on click instead of opening a sidebar view, for an activity that lives elsewhere (the Copilot panel). */
  run?: () => void;
}

export interface PanelDef {
  id: string;
  title: string;
  order?: number;
  render: Mount;
}

export interface TabTypeDef<S = any> {
  id: string;
  title(state: S): string;
  /** Tabs with the same key are focused instead of opened twice. */
  key?(state: S): string;
  render(el: HTMLElement, state: S): void | Dispose;
}

export interface CommandDef {
  id: string;
  title: string;
  keybinding?: string;
  run(...args: any[]): unknown;
}

export interface StatusItemDef {
  id: string;
  side: "left" | "right" | "title";
  text: string;
  title?: string;
  command?: string;
}

export interface StatusItemHandle {
  update(text: string, title?: string): void;
  dispose(): void;
}

export interface RecipeActionDef {
  id: string;
  title: string;
  keybinding?: string;
  run(path: string): unknown;
}

export interface OverviewSectionDef {
  id: string;
  title: string;
  order?: number;
  render(el: HTMLElement, recipePath: string): void | Dispose;
}

export interface SettingsSectionDef {
  id: string;
  title: string;
  order?: number;
  render: Mount;
}

export interface TerminalApi {
  create(opts: { title: string; cwd?: string; cmd?: string; args?: string[]; env?: Record<string, string> }): Promise<string>;
  write(id: string, data: string): void;
  onData(id: string, cb: (data: string) => void): Dispose;
  onExit(id: string, cb: (code: number | null) => void): Dispose;
  focus(id: string): void;
  dispose(id: string): void;
}

export interface WorkspaceApi {
  activeFile(): string | null;
  onActiveFile(cb: (path: string | null) => void): Dispose;
  open(path: string, line?: number): Promise<void>;
  listRecipes(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  paths(): Promise<AppPaths>;
}

export interface RendererContext {
  readonly module: string;
  registerActivity(a: ActivityDef): void;
  registerSidebarView(activityId: string, v: { render: Mount }): void;
  registerPanel(p: PanelDef): void;
  registerRightPanel(p: PanelDef): void;
  registerTabType<S>(t: TabTypeDef<S>): void;
  openTab<S>(typeId: string, state: S): void;
  showModal(m: { title: string; width?: number; render(el: HTMLElement, close: () => void): void | Dispose }): { close(): void };
  registerCommand(c: CommandDef): void;
  executeCommand(id: string, ...args: any[]): Promise<unknown>;
  registerStatusItem(s: StatusItemDef): StatusItemHandle;
  registerRecipeAction(a: RecipeActionDef): void;
  registerOverviewSection(s: OverviewSectionDef): void;
  registerSettingsSection(s: SettingsSectionDef): void;
  invoke<T = any>(channel: string, ...args: any[]): Promise<T>;
  on(channel: string, cb: (payload: any) => void): Dispose;
  editor: EditorStreamApi;
  gate: { confirm(req: ConfirmRequest): Promise<boolean> };
  terminal: TerminalApi;
  workspace: WorkspaceApi;
  notify(message: string, kind?: "info" | "warn" | "error"): void;
  theme: typeof THEME;
}

export interface RendererModule {
  activate(ctx: RendererContext): void | Promise<void>;
}

/** The only object the preload exposes to the main window (window.bh). */
export interface BhBridge {
  invoke<T = any>(channel: string, ...args: any[]): Promise<T>;
  on(channel: string, cb: (payload: any) => void): Dispose;
  platform: string;
}

/** Module channel names must be "<module>:<name>" (lower case, digits, dot, dash). */
export const CHANNEL_RE = /^[a-z][a-z0-9-]*:[a-zA-Z0-9.\-]+$/;
