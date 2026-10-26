// In-memory I3 editor with the shell's semantics: streams write at an anchor, user lines lock.
import type { EditorStreamApi, Hunk, StreamAt, LineEdit, UserEditEvent } from "../../src/shared/editor";

type Tag = "orig" | "copilot" | "user";
interface Doc { lines: string[]; tags: Tag[]; snapshot: string[]; ghost: string | null }

export class FakeEditor implements EditorStreamApi {
  docs = new Map<string, Doc>();
  streams = new Map<string, { file: string; line: number; col: number; open: boolean }>();
  private cbs = new Set<(e: UserEditEvent) => void>();
  ghostLog: (string | null)[] = [];
  private n = 0;

  doc(file: string): Doc {
    let d = this.docs.get(file);
    if (!d) {
      d = { lines: [""], tags: ["orig"], snapshot: [""], ghost: null };
      this.docs.set(file, d);
    }
    return d;
  }
  setText(file: string, text: string) {
    const d = this.doc(file);
    d.lines = text.split("\n");
    d.tags = d.lines.map(() => "orig");
    d.snapshot = [...d.lines];
  }
  getText(file: string) {
    return this.doc(file).lines.join("\n");
  }
  streamBegin(file: string, opts?: { at?: StreamAt }): string {
    const d = this.doc(file);
    const at = opts?.at ?? "end";
    let line = d.lines.length - 1;
    let col = d.lines[line].length;
    if (at === "replaceAll") {
      d.snapshot = [...d.lines];
      d.lines = [""];
      d.tags = ["copilot"];
      line = 0;
      col = 0;
    } else if (typeof at === "object") {
      line = Math.min(at.line - 1, d.lines.length);
      if (line === d.lines.length) {
        d.lines.push("");
        d.tags.push("copilot");
      } else {
        d.lines.splice(line, 0, "");
        d.tags.splice(line, 0, "copilot");
      }
      col = 0;
    } else if (d.lines.length === 1 && d.lines[0] === "") {
      line = 0;
      col = 0;
    } else if (col > 0) {
      d.lines.push("");
      d.tags.push("copilot");
      line++;
      col = 0;
    }
    const id = `s${this.n++}`;
    this.streams.set(id, { file, line, col, open: true });
    return id;
  }
  streamChunk(id: string, text: string) {
    const s = this.streams.get(id)!;
    const d = this.doc(s.file);
    const cur = d.lines[s.line];
    const head = cur.slice(0, s.col);
    const tail = cur.slice(s.col);
    const parts = text.split("\n");
    if (parts.length === 1) {
      d.lines[s.line] = head + parts[0] + tail;
      if (d.tags[s.line] !== "user") d.tags[s.line] = "copilot";
      s.col += parts[0].length;
      return;
    }
    const newLines = [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail];
    d.lines.splice(s.line, 1, ...newLines);
    const t0 = d.tags[s.line] === "user" ? "user" : "copilot";
    d.tags.splice(s.line, 1, t0, ...newLines.slice(1).map(() => "copilot" as Tag));
    s.line += parts.length - 1;
    s.col = parts[parts.length - 1].length;
  }
  streamEnd(id: string): Hunk[] {
    const s = this.streams.get(id)!;
    s.open = false;
    return this.hunks(s.file);
  }
  streamAbort(id: string) {
    this.streams.get(id)!.open = false;
  }
  setGhost(file: string, text: string | null) {
    this.doc(file).ghost = text;
    this.ghostLog.push(text);
  }
  onUserEdit(a: string | ((e: UserEditEvent) => void), b?: (e: UserEditEvent) => void): () => void {
    const cb = typeof a === "function" ? a : (e: UserEditEvent) => e.file === a && b!(e);
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  }
  listHunks(streamId: string): Hunk[] {
    const s = this.streams.get(streamId);
    return s ? this.hunks(s.file) : [];
  }
  /** Simulate the user retyping one line (1-based). */
  userEditLine(file: string, line: number, text: string) {
    const d = this.doc(file);
    d.lines[line - 1] = text;
    d.tags[line - 1] = "user";
    for (const cb of this.cbs) cb({ file, startLine: line, endLine: line, text });
  }
  hunks(file: string): Hunk[] {
    const d = this.doc(file);
    const out: Hunk[] = [];
    let i = 0;
    while (i < d.tags.length) {
      const t = d.tags[i];
      if (t === "orig") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < d.tags.length && d.tags[j + 1] === t) j++;
      out.push({ id: `${file}:${i}`, file, startLine: i + 1, endLine: j + 1, kind: t, state: "pending", text: d.lines.slice(i, j + 1).join("\n") });
      i = j + 1;
    }
    return out;
  }
  accepted: string[] = [];
  rejected: string[] = [];
  acceptHunk() {}
  rejectHunk() {}
  acceptAll(file: string) {
    const d = this.doc(file);
    d.tags = d.tags.map((t) => (t === "copilot" ? "orig" : t));
    this.accepted.push(file);
  }
  rejectAll(file: string) {
    const d = this.doc(file);
    d.lines = [...d.snapshot];
    d.tags = d.lines.map(() => "orig");
    this.rejected.push(file);
  }
  applied: { file: string; edits: LineEdit[] }[] = [];
  applyEdits(file: string, edits: LineEdit[]): Hunk[] {
    this.applied.push({ file, edits });
    let text = this.getText(file);
    const off = (l: number, c: number) => text.split("\n").slice(0, l - 1).reduce((a, s) => a + s.length + 1, 0) + c - 1;
    for (const e of [...edits].sort((a, b) => b.startLine - a.startLine || b.startCol - a.startCol)) {
      text = text.slice(0, off(e.startLine, e.startCol)) + e.text + text.slice(off(e.endLine, e.endCol));
    }
    const d = this.doc(file);
    d.lines = text.split("\n");
    d.tags = d.lines.map((_, i) => d.tags[i] ?? "copilot");
    return this.hunks(file);
  }
}
