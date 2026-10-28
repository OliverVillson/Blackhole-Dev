// The parts of the shell's contexts (WS1, app/src/shared/ext.ts) this module uses, written out
// structurally so the VM code and its tests build without the rest of the app.

export type GatedAction = "vm.up" | "vm.down" | "vm.delete" | "run.launch" | "download" | "paid.api" | "paid.gpu";

export interface ConfirmRequest {
  action: GatedAction;
  title: string;
  why: string;
  estCost?: string;
  details?: { label: string; value: string }[];
  requestedBy: "user" | "copilot";
}

export interface Gate { confirm(req: ConfirmRequest): Promise<boolean> }

export interface Helper { call<T>(method: string, params?: object): Promise<T> }

export interface Settings {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface VmMainContext {
  handle(channel: string, fn: (...args: any[]) => any): void;
  send(channel: string, payload: unknown): void;
  gate: Gate;
  helper: Helper;
  settings: Settings;
  paths: { userData: string; workspace: string; recipes: string; functions: string; models: string };
  log(...a: unknown[]): void;
}

export interface VmRendererContext {
  registerActivity(a: { id: string; title: string; icon: string; order?: number }): void;
  registerSidebarView(activityId: string, v: { render(el: HTMLElement): void | (() => void) }): void;
  registerTabType(t: { id: string; title(state: any): string; render(el: HTMLElement, state: any): void | (() => void) }): void;
  openTab(typeId: string, state: any): void;
  showModal(m: { title: string; width?: number; render(el: HTMLElement, close: () => void): void | (() => void) }): { close(): void };
  registerCommand(c: { id: string; title: string; keybinding?: string; run(...args: any[]): unknown }): void;
  executeCommand(id: string, ...args: any[]): Promise<unknown>;
  registerStatusItem(s: { id: string; side: "left" | "right"; text: string; title?: string; command?: string }): { update(text: string): void };
  registerRecipeAction(a: { id: string; title: string; keybinding?: string; run(path: string): unknown }): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
  terminal: {
    create(opts: { title: string; cwd?: string; cmd?: string; args?: string[] }): Promise<string>;
    write(id: string, data: string): void;
    onData(id: string, cb: (d: string) => void): void;
    dispose(id: string): void;
  };
  workspace: { activeFile(): string | null; onActiveFile(cb: (f: string | null) => void): void; open(path: string, line?: number): void; listRecipes(): Promise<string[]> };
}

/** I1 shapes this module reads (WS2: ws2-recipe.md I2b). */
export interface Problem { severity: "error" | "warning" | "info"; message: string; file: string; line: number }

export interface Manifest {
  format: string;
  name: string;
  id?: string;
  version?: string;
  base_model?: string;
  target?: string;
  runner?: "pipeline" | "core";
  stages?: string[];
  inputs?: Record<string, unknown>;
  needs?: { gpu_gb?: number | null; disk_gb?: number | null };
  blackhole_dev_version?: string;
  files?: Record<string, string>;
  functions?: { name: string; origin: string; sha256?: string; path?: string }[];
}

export interface BundleResult { bundle: string; sha256: string; functions: unknown[]; manifest: Manifest }

export interface PlanResult {
  rows?: { label: string; value: string; tone?: "ok" | "warn" | "bad" }[];
  sizeGb?: number;
  fits?: boolean;
  estHours?: number;
  problems?: Problem[];
}
