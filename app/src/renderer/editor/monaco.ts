// Monaco setup and the open-file buffers. One editor per editor group; each file is a model
// shared by every group that shows it.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { Theme } from "../../shared/themes";
import { currentTheme, fontsReady, onTheme } from "../theme";
import type { Problem } from "../../shared/rpc";
import { bh, helper } from "../bridge";
import { StreamManager } from "./stream";
import { CompletionSource, bindTabAutofill, installCompletion } from "./autofill";
import { narrow } from "./lang";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// One Monaco theme name ("blackhole") redefined from the active app theme; setTheme repaints
// every editor. Fonts and density follow the theme too (renderer/theme.ts).
function defineTheme(t: Theme): void {
  monaco.editor.defineTheme("blackhole", { base: t.light ? "vs" : "vs-dark", inherit: true, rules: t.monaco.rules, colors: t.monaco.colors });
}

function fontOptions(t: Theme): monaco.editor.IEditorOptions {
  const d = t.metrics;
  return { fontFamily: `"${t.fonts.mono}", Menlo, monospace`, fontSize: d.code, lineHeight: d.lh };
}

defineTheme(currentTheme());

export interface Buffer {
  path: string;
  model: monaco.editor.ITextModel;
  saved: number;
  readonly: boolean;
  isNew: boolean;
  view?: monaco.editor.ICodeEditorViewState | null;
}

const SEV: Record<Problem["severity"], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
};

/** One Monaco editor (an editor group shows its file tabs in one view). */
export interface EditorView {
  id: number;
  editor: monaco.editor.IStandaloneCodeEditor;
  buffer: Buffer | null;
  states: Map<string, monaco.editor.ICodeEditorViewState | null>;
  ghostZone: string | null;
  /** Dimmed-line decorations for focus themes. */
  focus: monaco.editor.IEditorDecorationsCollection;
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "blackhole",
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  tabSize: 4,
  insertSpaces: true,
  padding: { top: 12 },
  lineDecorationsWidth: 10,
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: "active", indentation: true },
  stickyScroll: { enabled: true },
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  mouseWheelZoom: true,
  wordBasedSuggestions: "off",
  suggestSelection: "first",
  suggest: { preview: true, previewMode: "subwordSmart", showStatusBar: true, insertMode: "replace" },
  quickSuggestions: { other: true, comments: false, strings: true },
  quickSuggestionsDelay: 80,
  suggestOnTriggerCharacters: true,
  parameterHints: { enabled: true, cycle: true },
  hover: { enabled: "on", delay: 400 },
  model: null,
};

let nextViewId = 1;

export class EditorManager {
  readonly views: EditorView[] = [];
  readonly buffers = new Map<string, Buffer>();
  readonly streams: StreamManager;
  readonly completion = new CompletionSource();
  private activeView: EditorView | null = null;
  private listeners = { change: new Set<(b: Buffer) => void>(), dirty: new Set<(b: Buffer) => void>(), hunks: new Set<(file: string) => void>(), cursor: new Set<(v: EditorView) => void>() };

  constructor(host?: HTMLElement) {
    this.completion.backend = {
      complete: (p) => helper("lang.complete", p),
      signatures: (p) => helper("lang.signatures", p),
      hover: (p) => helper("lang.hover", p),
    };
    installCompletion(this.completion);
    if (host) this.createView(host);
    this.streams = new StreamManager({
      model: (file) => this.modelFor(file),
      cursor: (file) => {
        const v = this.activeView?.buffer?.path === file ? this.activeView : this.views.find((x) => x.buffer?.path === file);
        return v ? v.editor.getPosition() : null;
      },
      renderGhost: (file, at, text) => this.renderGhost(file, at, text),
      changed: (file) => this.listeners.hunks.forEach((cb) => cb(file)),
    });
    onTheme((t) => this.restyle(t));
    void fontsReady(currentTheme()).then(() => monaco.editor.remeasureFonts());
  }

  /** Repaint every editor for a new theme: colours now, glyph metrics once its fonts are in. */
  restyle(t: Theme): void {
    defineTheme(t);
    monaco.editor.setTheme("blackhole");
    const opts = fontOptions(t);
    this.views.forEach((v) => {
      v.editor.updateOptions(opts);
      this.refocus(v);
    });
    void fontsReady(t).then(() => monaco.editor.remeasureFonts());
  }

  /** Focus themes dim every line more than three away from the cursor ("bh-dim", styled by the theme). */
  private refocus(v: EditorView): void {
    const m = v.editor.getModel(), at = v.editor.getPosition();
    if (!currentTheme().focus || !m || !at) return v.focus.clear();
    const last = m.getLineCount(), lo = at.lineNumber - 3, hi = at.lineNumber + 3;
    const dim = (a: number, b: number) => ({ range: new monaco.Range(a, 1, b, m.getLineMaxColumn(b)), options: { inlineClassName: "bh-dim" } });
    v.focus.set([...(lo > 1 ? [dim(1, lo - 1)] : []), ...(hi < last ? [dim(hi + 1, last)] : [])]);
  }

  /** The focused group's editor (the one commands and the anatomy "Insert path" act on). */
  get editor(): monaco.editor.IStandaloneCodeEditor {
    return (this.activeView ?? this.views[0]).editor;
  }

  createView(host: HTMLElement): EditorView {
    const editor = monaco.editor.create(host, { ...EDITOR_OPTIONS, ...fontOptions(currentTheme()) });
    const v: EditorView = { id: nextViewId++, editor, buffer: null, states: new Map(), ghostZone: null, focus: editor.createDecorationsCollection() };
    this.views.push(v);
    if (!this.activeView) this.activeView = v;
    editor.onDidFocusEditorWidget(() => this.setActiveView(v));
    editor.onDidChangeCursorPosition(() => {
      this.refocus(v);
      this.listeners.cursor.forEach((cb) => cb(v));
    });
    editor.onDidChangeModelContent(() => this.refocus(v));
    editor.onDidChangeModel(() => this.refocus(v));
    bindTabAutofill(editor, this.completion);
    return v;
  }

  disposeView(v: EditorView): void {
    const i = this.views.indexOf(v);
    if (i < 0) return;
    this.views.splice(i, 1);
    v.editor.setModel(null);
    v.editor.dispose();
    if (this.activeView === v) this.activeView = this.views[0] ?? null;
  }

  setActiveView(v: EditorView): void {
    if (this.activeView === v) return;
    this.activeView = v;
    this.listeners.cursor.forEach((cb) => cb(v));
  }

  view(): EditorView | null {
    return this.activeView;
  }

  on(ev: "change" | "dirty", cb: (b: Buffer) => void): () => void;
  on(ev: "hunks", cb: (file: string) => void): () => void;
  on(ev: "cursor", cb: (v: EditorView) => void): () => void;
  on(ev: keyof EditorManager["listeners"], cb: (x: any) => void): () => void {
    this.listeners[ev].add(cb);
    return () => this.listeners[ev].delete(cb);
  }

  private track(b: Buffer): Buffer {
    this.buffers.set(b.path, b);
    b.model.onDidChangeContent(() => {
      this.listeners.change.forEach((cb) => cb(b));
      this.listeners.dirty.forEach((cb) => cb(b));
    });
    return b;
  }

  /** Model for an open file; a path that is not open becomes a new, empty, unsaved buffer. */
  modelFor(path: string): monaco.editor.ITextModel {
    const b = this.buffers.get(path);
    if (b) return b.model;
    const model = monaco.editor.createModel("", "python", monaco.Uri.file(path));
    return this.track({ path, model, saved: model.getAlternativeVersionId(), readonly: false, isNew: true }).model;
  }

  async load(path: string, opts: { text?: string; readonly?: boolean } = {}): Promise<Buffer> {
    const have = this.buffers.get(path);
    if (have) return have;
    const text = opts.text ?? (await bh.invoke<string>("ws:read", path));
    const again = this.buffers.get(path);
    if (again) return again;
    const lang = path.endsWith(".py") ? "python" : path.endsWith(".toml") ? "ini" : path.endsWith(".json") ? "json" : "plaintext";
    const uri = opts.readonly ? monaco.Uri.from({ scheme: "builtin", path: "/" + path.replace(/^builtin:\/*/, "") }) : monaco.Uri.file(path);
    const model = monaco.editor.createModel(text, lang, uri);
    return this.track({ path, model, saved: model.getAlternativeVersionId(), readonly: !!opts.readonly, isNew: false });
  }

  show(path: string, line?: number, v: EditorView | null = this.activeView, focus = true): void {
    const b = this.buffers.get(path);
    if (!b || !v) return;
    if (v.buffer && v.buffer !== b) v.states.set(v.buffer.path, v.editor.saveViewState());
    v.buffer = b;
    if (v.editor.getModel() !== b.model) v.editor.setModel(b.model);
    v.editor.updateOptions({ readOnly: b.readonly });
    const st = v.states.get(path);
    if (st) v.editor.restoreViewState(st);
    if (line) {
      v.editor.revealLineInCenter(line);
      v.editor.setPosition({ lineNumber: line, column: 1 });
    }
    if (!focus) return;
    this.setActiveView(v);
    v.editor.focus();
  }

  /** Detach a view from its file (its tab moved away or closed). */
  hide(v: EditorView): void {
    if (v.buffer) v.states.set(v.buffer.path, v.editor.saveViewState());
    v.buffer = null;
    v.editor.setModel(null);
  }

  active(): Buffer | null {
    return this.activeView?.buffer ?? null;
  }

  isDirty(path: string): boolean {
    const b = this.buffers.get(path);
    return !!b && !b.readonly && (b.isNew || b.model.getAlternativeVersionId() !== b.saved);
  }

  async save(path: string): Promise<void> {
    const b = this.buffers.get(path);
    if (!b || b.readonly) return;
    await bh.invoke("ws:write", path, b.model.getValue());
    b.saved = b.model.getAlternativeVersionId();
    b.isNew = false;
    this.listeners.dirty.forEach((cb) => cb(b));
  }

  close(path: string): void {
    const b = this.buffers.get(path);
    if (!b) return;
    for (const v of this.views) {
      v.states.delete(path);
      if (v.buffer === b) this.hide(v);
    }
    b.model.dispose();
    this.buffers.delete(path);
  }

  rename(from: string, to: string): void {
    const b = this.buffers.get(from);
    if (!b) return;
    const text = b.model.getValue();
    const showing = this.views.filter((v) => v.buffer === b);
    this.close(from);
    this.load(to, { text }).then(() => showing.forEach((v) => this.show(to, undefined, v)));
  }

  setProblems(path: string, problems: Problem[]): void {
    const b = this.buffers.get(path);
    if (!b) return;
    const lines = b.model.getLineCount();
    monaco.editor.setModelMarkers(b.model, "blackhole", problems.map((p) => {
      const line = Math.min(Math.max(1, p.line), lines);
      // point at the param, function or stage the message names, not the whole line
      const at = p.col ? null : narrow(b.model.getLineContent(line), p.message);
      const text = b.model.getLineContent(line);
      const indent = text.length - text.trimStart().length + 1;
      return {
        severity: SEV[p.severity] ?? monaco.MarkerSeverity.Info,
        message: p.message,
        code: p.code,
        source: "blackhole",
        startLineNumber: line,
        startColumn: p.col ?? at?.start ?? indent,
        endLineNumber: p.endLine ?? line,
        endColumn: p.endCol ?? (p.col ? p.col + 1 : at?.end ?? b.model.getLineMaxColumn(line)),
      };
    }));
  }

  /** Insert text at the cursor as a normal (undoable) user edit. */
  insertAtCursor(text: string): void {
    const sel = this.editor.getSelection();
    if (!sel || !this.active() || this.active()!.readonly) return;
    this.editor.executeEdits("insert", [{ range: sel, text, forceMoveMarkers: true }]);
    this.editor.focus();
  }

  private renderGhost(file: string, at: { lineNumber: number; column: number } | null, text: string | null): void {
    for (const v of this.views)
      v.editor.changeViewZones((acc) => {
        if (v.ghostZone) acc.removeZone(v.ghostZone);
        v.ghostZone = null;
        if (!at || !text || v.buffer?.path !== file) return;
        const dom = document.createElement("div");
        dom.className = "bh-ghost";
        dom.textContent = text;
        v.ghostZone = acc.addZone({ afterLineNumber: at.lineNumber, heightInLines: Math.min(12, text.split("\n").length), domNode: dom });
      });
  }
}
