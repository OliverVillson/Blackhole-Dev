// I3: the copilot writes into the editor through streams. Streamed text is marked "copilot"
// until accepted; lines the user changes inside it turn "user" and are never removed by a
// reject. Built on Monaco text models, whose decorations follow every edit.

import type * as Monaco from "monaco-editor";
import type { EditorStreamApi, Hunk, LineEdit, StreamOptions, UserEditEvent } from "../../shared/editor";

type Model = Monaco.editor.ITextModel;
type IRange = Monaco.IRange;

export interface StreamHost {
  /** The model for a file, opening the file in a tab if needed. */
  model(file: string): Model;
  /** Cursor position in the file's editor, if it is the visible one. */
  cursor(file: string): { lineNumber: number; column: number } | null;
  /** Show (or clear with null) greyed ghost text after a position. */
  renderGhost(file: string, at: { lineNumber: number; column: number } | null, text: string | null): void;
  /** Called after hunks change so the UI (gutter buttons, copilot panel) can refresh. */
  changed?(file: string): void;
}

interface HunkRec {
  id: string;
  file: string;
  streamId?: string;
  kind: "copilot" | "user";
  state: Hunk["state"];
  deco: string | null;
  replaced?: string;
  lastText: string;
}

interface StreamRec {
  id: string;
  file: string;
  anchor: string;
  lastAnchor: Monaco.IPosition;
  run: string | null;
  done: boolean;
  replaced?: string;
  replaceMode: boolean;
  needNewline: boolean;
  wrote: boolean;
}

// Monaco's TrackedRangeStickiness values (kept numeric so this file needs no runtime import).
const ALWAYS_GROWS = 0;
const NEVER_GROWS = 1;

const OPTS: Record<"copilot" | "user" | "anchor", Monaco.editor.IModelDecorationOptions> = {
  copilot: { isWholeLine: true, className: "bh-copilot-line", linesDecorationsClassName: "bh-copilot-gutter", stickiness: NEVER_GROWS },
  user: { isWholeLine: true, className: "bh-user-line", linesDecorationsClassName: "bh-user-gutter", stickiness: NEVER_GROWS },
  anchor: { stickiness: ALWAYS_GROWS },
};

let seq = 0;
const newId = (p: string) => `${p}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function endOf(start: Monaco.IPosition, text: string): Monaco.IPosition {
  const lines = text.split("\n");
  if (lines.length === 1) return { lineNumber: start.lineNumber, column: start.column + text.length };
  return { lineNumber: start.lineNumber + lines.length - 1, column: lines[lines.length - 1].length + 1 };
}

function lineSpan(r: IRange): [number, number] {
  let end = r.endLineNumber;
  if (r.endColumn === 1 && end > r.startLineNumber) end -= 1;
  return [r.startLineNumber, end];
}

export class StreamManager implements EditorStreamApi {
  private streams = new Map<string, StreamRec>();
  private hunkRecs = new Map<string, HunkRec>();
  private listeners = new Set<{ file: string | null; cb: (e: UserEditEvent) => void }>();
  private watched = new WeakSet<Model>();
  private applying = 0;

  constructor(private host: StreamHost) {}

  // ---- internals ---------------------------------------------------------

  private model(file: string): Model {
    const m = this.host.model(file);
    if (!this.watched.has(m)) {
      this.watched.add(m);
      m.onDidChangeContent((e) => {
        if (this.applying) return;
        this.onUserChange(file, m, e);
      });
    }
    return m;
  }

  private edit(m: Model, range: IRange, text: string): void {
    this.applying++;
    try {
      m.pushEditOperations([], [{ range, text }], () => null);
    } finally {
      this.applying--;
    }
  }

  private range(m: Model, deco: string | null): IRange | null {
    if (!deco) return null;
    return m.getDecorationRange(deco);
  }

  private deco(m: Model, old: string | null, range: IRange | null, kind: "copilot" | "user" | "anchor"): string | null {
    const next = range ? [{ range, options: OPTS[kind] }] : [];
    const ids = m.deltaDecorations(old ? [old] : [], next);
    return ids[0] ?? null;
  }

  private newHunk(file: string, m: Model, range: IRange, kind: "copilot" | "user", streamId?: string, replaced?: string): HunkRec {
    const h: HunkRec = {
      id: newId("h"),
      file,
      streamId,
      kind,
      state: kind === "user" ? "accepted" : "pending",
      deco: this.deco(m, null, range, kind),
      replaced,
      lastText: m.getValueInRange(range),
    };
    this.hunkRecs.set(h.id, h);
    return h;
  }

  private anchorPos(m: Model, s: StreamRec): Monaco.IPosition {
    const r = this.range(m, s.anchor);
    return r ? { lineNumber: r.endLineNumber, column: r.endColumn } : s.lastAnchor;
  }

  private setAnchor(m: Model, s: StreamRec, p: Monaco.IPosition): void {
    s.anchor = this.deco(m, s.anchor, { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }, "anchor")!;
    s.lastAnchor = p;
  }

  private onUserChange(file: string, m: Model, e: Monaco.editor.IModelContentChangedEvent): void {
    for (const c of e.changes) {
      const start = c.range.startLineNumber;
      const end = start + (c.text.match(/\n/g)?.length ?? 0);
      let streamId: string | undefined;
      for (const h of [...this.hunkRecs.values()]) {
        if (h.file !== file || h.kind !== "copilot" || h.state !== "pending") continue;
        const r = this.range(m, h.deco);
        if (!r) continue;
        const [a, b] = lineSpan(r);
        if (end < a || start > b) continue;
        streamId ??= h.streamId;
        this.splitForUser(file, m, h, r, a, b, Math.max(a, start), Math.min(b, end));
      }
      for (const s of this.streams.values()) {
        if (s.file === file && !s.done) {
          const p = this.anchorPos(m, s);
          if (p.lineNumber >= start && p.lineNumber <= end + 1) streamId ??= s.id;
        }
      }
      const ev: UserEditEvent = { file, streamId, startLine: start, endLine: end, text: c.text };
      for (const l of this.listeners) if (l.file === null || l.file === file) l.cb(ev);
    }
    this.host.changed?.(file);
  }

  /** Lines [s, e] of copilot hunk h (range r, lines [a, b]) were edited by the user. */
  private splitForUser(file: string, m: Model, h: HunkRec, r: IRange, a: number, b: number, s: number, e: number): void {
    const lineStart = (x: number) => ({ lineNumber: x, column: 1 });
    const span = (p: Monaco.IPosition, q: Monaco.IPosition): IRange => ({ startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: q.lineNumber, endColumn: q.column });
    const rEnd = { lineNumber: r.endLineNumber, column: r.endColumn };
    const stream = h.streamId ? this.streams.get(h.streamId) : undefined;
    // Upper copilot part keeps the hunk id (and the replaced text), lower part becomes a new hunk.
    if (s > a) h.deco = this.deco(m, h.deco, span({ lineNumber: r.startLineNumber, column: r.startColumn }, lineStart(s)), "copilot");
    else {
      this.deco(m, h.deco, null, "copilot");
      h.deco = null;
    }
    const lower = e < b ? this.newHunk(file, m, span(lineStart(e + 1), rEnd), "copilot", h.streamId) : null;
    const userEnd = e < m.getLineCount() ? lineStart(e + 1) : { lineNumber: e, column: m.getLineMaxColumn(e) };
    this.newHunk(file, m, span(lineStart(s), e < b ? userEnd : rEnd.lineNumber > e ? userEnd : rEnd), "user", h.streamId);
    if (!h.deco) {
      // Nothing of the original hunk is left above: hand its role (and replaced text) to the lower part.
      if (lower) {
        lower.replaced = h.replaced;
        this.hunkRecs.delete(h.id);
      } else {
        h.state = "accepted"; // fully rewritten by the user: nothing to reject
        h.lastText = "";
      }
    }
    // The stream keeps extending the copilot text below the user's lines, if any is left.
    if (stream && stream.run === h.id) stream.run = lower ? lower.id : h.deco ? h.id : null;
  }

  private toHunk(h: HunkRec): Hunk {
    let startLine = 0;
    let endLine = 0;
    let text = h.lastText;
    const m = h.deco ? this.host.model(h.file) : null;
    const r = m ? this.range(m, h.deco) : null;
    if (m && r) {
      [startLine, endLine] = lineSpan(r);
      text = m.getValueInRange(r);
      h.lastText = text;
    }
    return { id: h.id, file: h.file, streamId: h.streamId, startLine, endLine, kind: h.kind, state: h.state, text };
  }

  // ---- I3 ----------------------------------------------------------------

  streamBegin(file: string, opts: StreamOptions = {}): string {
    const m = this.model(file);
    const id = newId("s");
    let at: Monaco.IPosition;
    let replaced: string | undefined;
    let needNewline = false;
    const full = m.getFullModelRange();
    if (opts.replaceRange) {
      const { startLine, endLine } = opts.replaceRange;
      const last = m.getLineCount();
      const r: IRange =
        endLine < last
          ? { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine + 1, endColumn: 1 }
          : { startLineNumber: startLine, startColumn: 1, endLineNumber: last, endColumn: m.getLineMaxColumn(last) };
      replaced = m.getValueInRange(r);
      this.edit(m, r, "");
      at = { lineNumber: startLine, column: 1 };
    } else if (opts.at === "replaceAll") {
      replaced = m.getValue();
      this.edit(m, full, "");
      at = { lineNumber: 1, column: 1 };
    } else if (opts.at && typeof opts.at === "object") {
      const line = Math.min(Math.max(1, opts.at.line), m.getLineCount());
      at = { lineNumber: line, column: Math.min(opts.at.col ?? 1, m.getLineMaxColumn(line)) };
    } else if (opts.at === "cursor" && this.host.cursor(file)) {
      at = this.host.cursor(file)!;
    } else {
      const last = m.getLineCount();
      at = { lineNumber: last, column: m.getLineMaxColumn(last) };
      needNewline = m.getLineContent(last).length > 0;
    }
    const s: StreamRec = { id, file, anchor: "", lastAnchor: at, run: null, done: false, replaced, replaceMode: replaced !== undefined, needNewline, wrote: false };
    this.setAnchor(m, s, at);
    this.streams.set(id, s);
    return id;
  }

  streamChunk(id: string, text: string): void {
    const s = this.streams.get(id);
    if (!s || s.done || !text) return;
    let m: Model;
    try {
      m = this.host.model(s.file);
    } catch {
      this.streamAbort(id);
      return;
    }
    let at = this.anchorPos(m, s);
    const movedByUser = at.lineNumber !== s.lastAnchor.lineNumber || at.column !== s.lastAnchor.column;
    if (movedByUser) {
      // The user typed at the stream's position: their text stays, the stream continues on the next line.
      s.run = null;
      if (at.column > 1) s.needNewline = true;
    }
    if (s.needNewline) {
      this.edit(m, { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column }, "\n");
      at = { lineNumber: at.lineNumber + 1, column: 1 };
      s.needNewline = false;
    }
    this.edit(m, { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column }, text);
    const end = endOf(at, text);
    const run = s.run ? this.hunkRecs.get(s.run) : undefined;
    const runRange = run && run.state === "pending" ? this.range(m, run.deco) : null;
    if (run && runRange && runRange.endLineNumber === at.lineNumber && runRange.endColumn === at.column) {
      run.deco = this.deco(m, run.deco, { startLineNumber: runRange.startLineNumber, startColumn: runRange.startColumn, endLineNumber: end.lineNumber, endColumn: end.column }, "copilot");
    } else {
      const h = this.newHunk(s.file, m, { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: end.lineNumber, endColumn: end.column }, "copilot", s.id, s.wrote ? undefined : s.replaced);
      s.run = h.id;
    }
    s.wrote = true;
    this.setAnchor(m, s, end);
    this.host.changed?.(s.file);
  }

  private finish(id: string): StreamRec | null {
    const s = this.streams.get(id);
    if (!s || s.done) return null;
    s.done = true;
    const m = this.host.model(s.file);
    if (s.replaceMode && !s.wrote && s.replaced) {
      const p = this.anchorPos(m, s);
      this.edit(m, { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }, s.replaced);
    } else if (s.replaceMode && s.wrote && s.replaced?.endsWith("\n")) {
      const p = this.anchorPos(m, s);
      if (p.column > 1) {
        // Replaced whole lines: keep the line after the replacement on its own line.
        this.edit(m, { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }, "\n");
        const run = s.run ? this.hunkRecs.get(s.run) : undefined;
        const rr = run ? this.range(m, run.deco) : null;
        if (run && rr && rr.endLineNumber === p.lineNumber && rr.endColumn === p.column) {
          run.deco = this.deco(m, run.deco, { ...rr, endLineNumber: p.lineNumber + 1, endColumn: 1 }, "copilot");
        }
      }
    }
    this.deco(m, s.anchor, null, "anchor");
    this.host.renderGhost(s.file, null, null);
    return s;
  }

  streamEnd(id: string): Hunk[] {
    const s = this.finish(id);
    if (!s) return this.listHunks(id);
    this.host.changed?.(s.file);
    return this.listHunks(id);
  }

  streamAbort(id: string): void {
    const s = this.finish(id);
    if (s) this.host.changed?.(s.file);
  }

  setGhost(file: string, text: string | null): void {
    const live = [...this.streams.values()].find((s) => s.file === file && !s.done);
    if (!live || !text) {
      this.host.renderGhost(file, null, null);
      return;
    }
    const m = this.host.model(file);
    this.host.renderGhost(file, this.anchorPos(m, live), text);
  }

  onUserEdit(a: string | ((e: UserEditEvent) => void), b?: (e: UserEditEvent) => void): () => void {
    const l = typeof a === "string" ? { file: a, cb: b! } : { file: null, cb: a };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  hunks(file: string): Hunk[] {
    return [...this.hunkRecs.values()]
      .filter((h) => h.file === file && h.deco && (h.state === "pending" || h.kind === "user"))
      .map((h) => this.toHunk(h))
      .sort((x, y) => x.startLine - y.startLine);
  }

  listHunks(streamId: string): Hunk[] {
    return [...this.hunkRecs.values()].filter((h) => h.streamId === streamId).map((h) => this.toHunk(h)).sort((x, y) => x.startLine - y.startLine);
  }

  acceptHunk(id: string): void {
    const h = this.hunkRecs.get(id);
    if (!h || h.state !== "pending") return;
    const m = this.host.model(h.file);
    this.toHunk(h);
    h.state = "accepted";
    this.deco(m, h.deco, null, "copilot");
    h.deco = null;
    this.host.changed?.(h.file);
  }

  rejectHunk(id: string): void {
    const h = this.hunkRecs.get(id);
    if (!h || h.state !== "pending" || h.kind !== "copilot") return;
    const m = this.host.model(h.file);
    const r = this.range(m, h.deco);
    this.toHunk(h);
    h.state = "rejected";
    this.deco(m, h.deco, null, "copilot");
    h.deco = null;
    if (r) this.edit(m, r, h.replaced ?? "");
    this.host.changed?.(h.file);
  }

  acceptAll(file: string): void {
    for (const h of [...this.hunkRecs.values()]) if (h.file === file && h.state === "pending") this.acceptHunk(h.id);
  }

  rejectAll(file: string): void {
    // Bottom-up, so earlier ranges are untouched by later removals.
    const pending = this.hunks(file).filter((h) => h.state === "pending").sort((x, y) => y.startLine - x.startLine);
    for (const h of pending) this.rejectHunk(h.id);
  }

  getText(file: string): string {
    return this.model(file).getValue();
  }

  applyEdits(file: string, edits: LineEdit[]): Hunk[] {
    const m = this.model(file);
    const sorted = [...edits].sort((x, y) => y.startLine - x.startLine || y.startCol - x.startCol);
    const out: HunkRec[] = [];
    for (const e of sorted) {
      const r: IRange = { startLineNumber: e.startLine, startColumn: e.startCol, endLineNumber: e.endLine, endColumn: e.endCol };
      const replaced = m.getValueInRange(r);
      this.edit(m, r, e.text);
      if (!e.text) continue;
      const end = endOf({ lineNumber: e.startLine, column: e.startCol }, e.text);
      out.push(this.newHunk(file, m, { startLineNumber: e.startLine, startColumn: e.startCol, endLineNumber: end.lineNumber, endColumn: end.column }, "copilot", undefined, replaced));
    }
    this.host.changed?.(file);
    return out.map((h) => this.toHunk(h));
  }

  /** True while a stream is writing into the file (the editor shows a live badge). */
  isStreaming(file: string): boolean {
    return [...this.streams.values()].some((s) => s.file === file && !s.done);
  }
}
