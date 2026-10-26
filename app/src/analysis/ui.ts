// Analysis module UI: the sidebar (model + forks, analyses, scripts) and the analysis tab
// (params form, read estimate, run, the report's charts).
import type { RendererContext } from "../shared/ext";
import { renderBlock } from "./charts";
import { CH, fmtBytes, fmtSeconds, type AnalysisInfo, type Estimate, type ModelBrief, type ModelRow, type RunOutcome, type RunRequest } from "./shared";

export interface AnalysisTabState {
  name?: string;
  path?: string;          // a script file
  model?: string;         // a model folder or Hub id; empty = the model open in Anatomy
  params?: Record<string, unknown>;
}

type Listener = () => void;

/** What the sidebar and the tabs share: the analyses, the models folder, the chosen model. */
export class AnalysisStore {
  analyses: AnalysisInfo[] = [];
  problems: { file: string; error: string }[] = [];
  dir: string | null = null;
  models: ModelRow[] = [];
  anatomyModel: ModelBrief | null = null;
  model: string = "";
  error: string | null = null;
  private subs = new Set<Listener>();

  constructor(private ctx: Pick<RendererContext, "invoke">) {
    try {
      this.model = localStorage.getItem("analysis.model") ?? "";
    } catch {
      this.model = "";
    }
  }

  subscribe(fn: Listener): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(): void {
    this.subs.forEach((f) => f());
  }

  setModel(path: string): void {
    this.model = path;
    try {
      localStorage.setItem("analysis.model", path);
    } catch {
      /* per-viewer convenience only */
    }
    this.emit();
  }

  async refresh(): Promise<void> {
    try {
      const [l, m] = await Promise.all([
        this.ctx.invoke<{ analyses: AnalysisInfo[]; problems: { file: string; error: string }[]; dir: string | null; model: ModelBrief | null }>(CH.list),
        this.ctx.invoke<{ models: ModelRow[] }>(CH.models),
      ]);
      this.analyses = l.analyses;
      this.problems = l.problems;
      this.dir = l.dir;
      this.anatomyModel = l.model;
      this.models = m.models;
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.emit();
  }

  get(name: string): AnalysisInfo | undefined {
    return this.analyses.find((a) => a.name === name);
  }

  modelLabel(path = this.model): string {
    if (!path) return this.anatomyModel ? `${this.anatomyModel.name} (open in Anatomy)` : "no model chosen";
    return this.models.find((m) => m.path === path)?.name ?? path.split(/[\\/]/).pop() ?? path;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

const GROUP_TITLE: Record<string, string> = { model: "Model analyses", jobs: "Job results", forks: "Forks and comparisons" };

/** Models folder as a tree: each fork under its parent. */
export function modelTree(rows: ModelRow[]): { row: ModelRow; depth: number }[] {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const kids = new Map<string, ModelRow[]>();
  const roots: ModelRow[] = [];
  for (const r of rows) {
    if (r.parent && byPath.has(r.parent)) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
    else roots.push(r);
  }
  const out: { row: ModelRow; depth: number }[] = [];
  const walk = (r: ModelRow, depth: number, seen: Set<string>) => {
    if (seen.has(r.path)) return;
    seen.add(r.path);
    out.push({ row: r, depth });
    for (const k of kids.get(r.path) ?? []) walk(k, depth + 1, seen);
  };
  const seen = new Set<string>();
  roots.forEach((r) => walk(r, 0, seen));
  rows.forEach((r) => walk(r, 0, seen));     // a cycle never hides a row
  return out;
}

export function renderSidebar(root: HTMLElement, ctx: RendererContext, store: AnalysisStore, open: (s: AnalysisTabState) => void): () => void {
  const view = el("div", "an-view");
  root.append(view);
  const forkModel = async (src: string) => {
    const name = prompt("Name of the fork", `${src.split(/[\\/]/).pop()}-fork`);
    if (name === null) return;
    const r = await ctx.invoke<{ ok: boolean; path?: string; error?: string; cancelled?: boolean }>(CH.forkModel, { src, name: name || undefined });
    if (r.ok && r.path) {
      ctx.notify(`Forked into ${r.path}`);
      await store.refresh();
      store.setModel(r.path);
    } else if (!r.cancelled) ctx.notify(`Fork failed: ${r.error}`, "error");
  };
  const draw = () => {
    view.replaceChildren();
    // model
    const sec = el("div", "an-sec", "Model");
    sec.append(button("Refresh", "an-link", () => void store.refresh()));
    view.append(sec);
    view.append(el("div", "an-hint", `Analysing: ${store.modelLabel()}`));
    const inline = el("div", "an-inline");
    const input = el("input");
    input.placeholder = "Folder or Hub id";
    input.setAttribute("aria-label", "Model to analyse");
    const use = () => input.value.trim() && store.setModel(input.value.trim());
    input.addEventListener("keydown", (e) => e.key === "Enter" && use());
    inline.append(input, button("Use", "btn", use));
    view.append(inline);
    if (store.model) {
      const acts = el("div", "an-inline");
      acts.append(button("Use the Anatomy model", "an-link", () => store.setModel(""), "Analyse whatever model the Anatomy view has open"));
      view.append(acts);
    }
    const tree = modelTree(store.models);
    if (!tree.length) view.append(el("div", "an-hint", "No model folders in your models folder yet. Pull a finished job, or type a folder above."));
    for (const { row, depth } of tree) {
      const r = el("div", `an-row${depth ? " an-indent" : ""}${store.model === row.path ? " on" : ""}`);
      r.style.paddingLeft = `${6 + depth * 14}px`;
      r.tabIndex = 0;
      r.title = `${row.path}${row.edits ? `\n${row.edits} recorded edit${row.edits === 1 ? "" : "s"}` : ""}${row.parent ? `\nforked from ${row.parent}` : ""}`;
      r.append(el("span", "nm", row.name));
      if (row.parent) r.append(el("span", "an-tag fork", row.parentChanged ? "fork · parent changed" : "fork"));
      r.append(el("span", "meta", fmtBytes(row.sizeBytes)));
      const acts = el("span", "an-acts");
      acts.append(button("Fork", "an-link", () => void forkModel(row.path), "Fork this model (linked: no extra disk)"));
      if (row.parent) acts.append(button("Diff", "an-link", () => open({ name: "compare", model: row.path }), "Compare with its parent"));
      r.append(acts);
      const pick = () => store.setModel(row.path);
      r.addEventListener("click", pick);
      r.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
      view.append(r);
    }
    if (store.error) view.append(el("div", "an-warn", `Python helper: ${store.error}`));
    // analyses by group
    const groups = new Map<string, AnalysisInfo[]>();
    for (const a of store.analyses) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
    for (const [g, list] of [...groups].sort((a, b) => Object.keys(GROUP_TITLE).indexOf(a[0]) - Object.keys(GROUP_TITLE).indexOf(b[0]))) {
      view.append(el("div", "an-sec", GROUP_TITLE[g] ?? g));
      for (const a of list) {
        const r = el("div", "an-row");
        r.tabIndex = 0;
        r.title = a.doc;
        r.append(el("span", "nm", a.title));
        if (a.origin !== "builtin") r.append(el("span", "an-tag", a.origin === "override" ? "your version" : "yours"));
        if (a.needs === "headers") r.append(el("span", "meta", "free"));
        const acts = el("span", "an-acts");
        acts.append(button("Source", "an-link", () => void ctx.workspace.open(a.path), "Open its Python file"));
        if (a.origin === "builtin") {
          acts.append(button("Fork", "an-link", async () => {
            try {
              const f = await ctx.invoke<{ path: string }>(CH.forkScript, a.name);
              await store.refresh();
              await ctx.workspace.open(f.path);
              ctx.notify(`Your copy of ${a.name} now replaces the built-in. Edit it and run it again.`);
            } catch (e) {
              ctx.notify(`Fork failed: ${(e as Error).message}`, "error");
            }
          }, "Copy into your analysis folder (it then replaces the built-in)"));
        }
        r.append(acts);
        const go = () => open({ name: a.name, model: store.model || undefined });
        r.addEventListener("click", go);
        r.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
        view.append(r);
      }
    }
    // scripts
    const ss = el("div", "an-sec", "Your scripts");
    view.append(ss);
    const row = el("div", "an-inline");
    row.append(button("New script", "btn", () => void ctx.executeCommand("analysis.newScript")),
      button("Run the open file", "btn", () => void ctx.executeCommand("analysis.runActiveFile")));
    view.append(row);
    view.append(el("div", "an-hint", store.dir ? `Files in ${store.dir} with an @analysis appear above; a file without one runs top to bottom with r, m and params.` : "The helper has not said where your analysis folder is yet."));
    for (const p of store.problems) view.append(el("div", "an-warn", `${p.file.split(/[\\/]/).pop()}: ${p.error}`));
  };
  const off = store.subscribe(draw);
  draw();
  if (!store.analyses.length) void store.refresh();
  return () => {
    off();
    view.remove();
  };
}

function paramInput(name: string, spec: AnalysisInfo["params"][string], value: unknown): { wrap: HTMLElement; read: () => unknown } {
  const wrap = el("label", "an-field");
  wrap.append(document.createTextNode(name));
  const input = el("input");
  if (spec.type === "bool") {
    input.type = "checkbox";
    input.checked = Boolean(value ?? spec.default);
    wrap.append(input);
    return { wrap, read: () => input.checked };
  }
  input.type = spec.type === "int" || spec.type === "float" ? "number" : "text";
  if (spec.type === "float") input.step = "any";
  input.value = value === undefined || value === null ? String(spec.default ?? "") : String(value);
  if (spec.type === "str") input.style.minWidth = "220px";
  wrap.append(input);
  return { wrap, read: () => input.value };
}

export function renderTab(root: HTMLElement, ctx: RendererContext, store: AnalysisStore, state: AnalysisTabState): () => void {
  const tab = el("div", "an-tab");
  const page = el("div", "an-page");
  tab.append(page);
  root.append(tab);
  const head = el("div", "an-head");
  const bar = el("div", "an-bar");
  const status = el("div", "an-status-line");
  const blocks = el("div", "an-blocks");
  const foot = el("div", "an-hint");
  page.append(head, bar, status, blocks, foot);
  let reads: (() => unknown)[] = [];
  let names: string[] = [];
  let running = false;
  let disposed = false;

  const req = (): RunRequest => {
    const params: Record<string, unknown> = {};
    names.forEach((n, i) => {
      const v = reads[i]();
      if (v !== "" && v !== undefined) params[n] = v;
    });
    let text: string | undefined;
    if (state.path) {
      try {
        text = ctx.editor.getText(state.path) || undefined;
      } catch {
        text = undefined;
      }
    }
    return { name: state.name, path: state.path, text, model: state.model ?? (store.model || undefined), params };
  };

  const est = el("div", "an-est");
  const showEstimate = async () => {
    try {
      const e = await ctx.invoke<Estimate>(CH.estimate, req());
      est.textContent = e.needs === "none" ? "Reads files, not weights." : e.needs === "headers" ? "Headers only: reads no weights." :
        e.known ? `${e.remote ? "Downloads" : "Reads"} ~${fmtBytes(e.bytes)} of weights, ${fmtSeconds(e.seconds)}.` :
          "This script does not say what it reads: it runs under your read limit and asks before passing it.";
      return e;
    } catch (e) {
      est.textContent = (e as Error).message;
      return null;
    }
  };

  const run = async () => {
    if (running) return;
    running = true;
    blocks.classList.add("stale");
    status.className = "an-status-line";
    status.textContent = "Running…";
    const off = ctx.on(CH.progress, (p: { message?: string; fraction?: number }) => {
      if (running && p?.message) status.textContent = `Running: ${p.message}${p.fraction != null ? ` (${Math.round(p.fraction * 100)}%)` : ""}`;
    });
    try {
      const out = await ctx.invoke<RunOutcome>(CH.run, req());
      if (disposed) return;
      if (out.ok) {
        const r = out.report;
        blocks.replaceChildren(...(r.blocks.length ? r.blocks.map(renderBlock) : [el("div", "an-empty", "This analysis drew nothing.")]));
        status.textContent = "";
        foot.textContent = `${r.model ? r.model.split(/[\\/]/).pop() + " · " : ""}read ${fmtBytes(r.reads)} in ${r.seconds < 1 ? `${Math.round(r.seconds * 1000)} ms` : `${r.seconds.toFixed(1)} s`}`;
        if (r.title) title.textContent = r.title;
      } else if ("cancelled" in out && out.cancelled) {
        status.textContent = "Not run: the read was not approved.";
      } else {
        status.className = "an-status-line err";
        status.textContent = "error" in out ? out.error : "failed";
      }
    } catch (e) {
      status.className = "an-status-line err";
      status.textContent = (e as Error).message;
    } finally {
      off();
      running = false;
      blocks.classList.remove("stale");
    }
  };

  const title = el("h2");
  const draw = () => {
    const a = state.name ? store.get(state.name) : undefined;
    title.textContent = a?.title ?? (state.path ? state.path.split(/[\\/]/).pop()! : state.name ?? "Analysis");
    head.replaceChildren(title);
    if (a?.doc) head.append(el("p", "an-doc", a.doc));
    head.append(el("p", "an-doc", `Model: ${a?.needs === "none" ? "not needed" : store.modelLabel(state.model ?? store.model)}`));
    bar.replaceChildren();
    reads = [];
    names = [];
    for (const [n, spec] of Object.entries(a?.params ?? {})) {
      const f = paramInput(n, spec, state.params?.[n]);
      f.wrap.addEventListener("change", () => void showEstimate());
      bar.append(f.wrap);
      reads.push(f.read);
      names.push(n);
    }
    bar.append(button("Run", "btn", () => void run()));
    if (state.path) bar.append(button("Open the file", "an-link", () => void ctx.workspace.open(state.path!)));
    else if (a) bar.append(button("Source", "an-link", () => void ctx.workspace.open(a.path)));
    bar.append(est);
  };

  const start = async () => {
    if (state.name && !store.get(state.name)) await store.refresh();
    if (disposed) return;
    draw();
    const e = await showEstimate();
    const a = state.name ? store.get(state.name) : undefined;
    // Cheap analyses run on open; anything that reads more waits for the Run click.
    if (e && a && a.needs !== "none" && e.known && (e.bytes ?? 0) < 256e6 && !e.remote) void run();
    else if (!blocks.childElementCount) blocks.replaceChildren(el("div", "an-empty", "Set the params and press Run."));
  };
  void start();
  return () => {
    disposed = true;
    tab.remove();
  };
}
