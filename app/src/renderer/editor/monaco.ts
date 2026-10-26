// Monaco setup and the open-file buffers. One editor instance; each file is a model.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { THEME } from "../../shared/theme";
import type { Problem } from "../../shared/rpc";
import { bh } from "../bridge";
import { StreamManager } from "./stream";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const hex = (c: string) => c.replace("#", "");
monaco.editor.defineTheme("blackhole", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: hex(THEME.text) },
    { token: "keyword", foreground: hex(THEME.ember) },
    { token: "string", foreground: hex(THEME.flare) },
    { token: "comment", foreground: hex(THEME.dim), fontStyle: "italic" },
    { token: "number", foreground: "ff8c5a" },
    { token: "tag", foreground: "e8a27a" },
    { token: "delimiter", foreground: "c9a58f" },
    { token: "type", foreground: hex(THEME.photon) },
    { token: "identifier", foreground: hex(THEME.text) },
  ],
  colors: {
    "editor.background": THEME.void,
    "editor.foreground": THEME.text,
    "editorLineNumber.foreground": "#7a5240",
    "editorLineNumber.activeForeground": THEME.ember,
    "editor.lineHighlightBackground": "#140602",
    "editor.selectionBackground": "#4a0d0288",
    "editorCursor.foreground": THEME.ember,
    "editorWidget.background": THEME.bg2,
    "editorWidget.border": THEME.ash,
    "editorGutter.background": THEME.void,
    "scrollbarSlider.background": "#2b0d0588",
    "editorError.foreground": THEME.redshift,
    "editorWarning.foreground": THEME.ember,
    "editorIndentGuide.background1": "#1e0804",
  },
});

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

export class EditorManager {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  readonly buffers = new Map<string, Buffer>();
  readonly streams: StreamManager;
  private current: Buffer | null = null;
  private ghostZone: string | null = null;
  private listeners = { change: new Set<(b: Buffer) => void>(), dirty: new Set<(b: Buffer) => void>(), hunks: new Set<(file: string) => void>() };

  constructor(host: HTMLElement) {
    this.editor = monaco.editor.create(host, {
      theme: "blackhole",
      automaticLayout: true,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      tabSize: 4,
      insertSpaces: true,
      padding: { top: 12 },
      lineDecorationsWidth: 10,
      model: null,
    });
    this.streams = new StreamManager({
      model: (file) => this.modelFor(file),
      cursor: (file) => (this.current?.path === file ? this.editor.getPosition() : null),
      renderGhost: (file, at, text) => this.renderGhost(file, at, text),
      changed: (file) => this.listeners.hunks.forEach((cb) => cb(file)),
    });
  }

  on(ev: "change" | "dirty", cb: (b: Buffer) => void): () => void;
  on(ev: "hunks", cb: (file: string) => void): () => void;
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

  show(path: string, line?: number): void {
    const b = this.buffers.get(path);
    if (!b) return;
    if (this.current && this.current !== b) this.current.view = this.editor.saveViewState();
    this.current = b;
    this.editor.setModel(b.model);
    this.editor.updateOptions({ readOnly: b.readonly });
    if (b.view) this.editor.restoreViewState(b.view);
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    }
    this.editor.focus();
  }

  active(): Buffer | null {
    return this.current;
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
    if (this.current === b) {
      this.current = null;
      this.editor.setModel(null);
    }
    b.model.dispose();
    this.buffers.delete(path);
  }

  rename(from: string, to: string): void {
    const b = this.buffers.get(from);
    if (!b) return;
    const text = b.model.getValue();
    const wasCurrent = this.current === b;
    this.close(from);
    this.load(to, { text }).then(() => wasCurrent && this.show(to));
  }

  setProblems(path: string, problems: Problem[]): void {
    const b = this.buffers.get(path);
    if (!b) return;
    monaco.editor.setModelMarkers(b.model, "blackhole", problems.map((p) => ({
      severity: SEV[p.severity] ?? monaco.MarkerSeverity.Info,
      message: p.code ? `${p.message} (${p.code})` : p.message,
      startLineNumber: Math.max(1, p.line),
      startColumn: p.col ?? 1,
      endLineNumber: p.endLine ?? Math.max(1, p.line),
      endColumn: p.endCol ?? (p.col ? p.col + 1 : b.model.getLineMaxColumn(Math.min(Math.max(1, p.line), b.model.getLineCount()))),
    })));
  }

  /** Insert text at the cursor as a normal (undoable) user edit. */
  insertAtCursor(text: string): void {
    const sel = this.editor.getSelection();
    if (!sel || !this.current || this.current.readonly) return;
    this.editor.executeEdits("insert", [{ range: sel, text, forceMoveMarkers: true }]);
    this.editor.focus();
  }

  private renderGhost(file: string, at: { lineNumber: number; column: number } | null, text: string | null): void {
    this.editor.changeViewZones((acc) => {
      if (this.ghostZone) acc.removeZone(this.ghostZone);
      this.ghostZone = null;
      if (!at || !text || this.current?.path !== file) return;
      const dom = document.createElement("div");
      dom.className = "bh-ghost";
      dom.textContent = text;
      this.ghostZone = acc.addZone({ afterLineNumber: at.lineNumber, heightInLines: Math.min(12, text.split("\n").length), domNode: dom });
    });
  }
}
