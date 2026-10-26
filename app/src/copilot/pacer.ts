// Types the copilot's code into the editor at a readable pace.
// Text the model has produced but the pacer has not typed yet is shown as ghost text
// ("what it plans to write next"). While the model is still writing, the pacer keeps a
// few lines of lookahead in the ghost, so the user sees upcoming lines and can stop,
// pause or edit before they land.
import type { EditorStreamApi, Hunk, StreamAt } from "../shared/editor";

export interface PacerOptions {
  /** Complete lines kept as ghost while the model is still writing. */
  lookaheadLines?: number;
  /** Characters typed per tick at minimum. */
  charsPerTick?: number;
  /** Ghost preview shows at most this many lines. */
  maxGhostLines?: number;
}

export class Pacer {
  private buf = "";
  private streamId: string | null = null;
  private sourceDone = false;
  private paused = false;
  private typed = 0;
  private onIdle: (() => void) | null = null;
  readonly file: string;
  private readonly o: Required<PacerOptions>;

  constructor(
    private editor: EditorStreamApi,
    file: string,
    /** Where the stream starts. null = not known yet (the file is still being opened); see setAt. */
    private at: { at?: StreamAt } | null,
    opts: PacerOptions = {},
  ) {
    this.file = file;
    this.o = { lookaheadLines: 3, charsPerTick: 6, maxGhostLines: 12, ...opts };
  }

  /** Model produced more code. */
  push(text: string): void {
    this.buf += text;
    this.renderGhost();
  }

  /** The model closed the fence: type out the rest, then end the stream. */
  finish(): Promise<void> {
    this.sourceDone = true;
    if (!this.buf && this.at) {
      this.end();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.onIdle = resolve;
    });
  }

  get pending(): string {
    return this.buf;
  }

  get charsTyped(): number {
    return this.typed;
  }

  get active(): boolean {
    return this.streamId !== null || !!this.buf;
  }

  setAt(at: { at?: StreamAt }): void {
    this.at = at;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  /** Called on a timer (about 30 ms). Returns true while there is work left. */
  tick(): boolean {
    if (this.paused || !this.at || !this.buf) return !!this.buf || !this.sourceDone;
    const commitable = this.sourceDone ? this.buf.length : this.commitLimit();
    if (commitable <= 0) return true;
    // Speed up when far behind, so the editor never lags the model by much.
    const n = Math.min(commitable, Math.max(this.o.charsPerTick, Math.ceil(commitable / 20)));
    this.write(this.buf.slice(0, n));
    this.buf = this.buf.slice(n);
    this.renderGhost();
    if (!this.buf && this.sourceDone) {
      this.end();
      return false;
    }
    return true;
  }

  /** Stop typing: drop the ghost, keep what is already in the editor as pending hunks. */
  abort(): void {
    this.buf = "";
    this.editor.setGhost(this.file, null);
    if (this.streamId) this.editor.streamAbort(this.streamId);
    this.streamId = null;
    this.resolveIdle();
  }

  /** Type everything at once (used when the user presses Accept all mid-write). */
  flush(): Hunk[] {
    if (this.buf) this.write(this.buf);
    this.buf = "";
    return this.end();
  }

  private commitLimit(): number {
    // Keep the last `lookaheadLines` complete lines and the partial line as ghost.
    let idx = this.buf.length;
    let lines = 0;
    // Partial last line: everything after the last newline stays in the ghost.
    const lastNl = this.buf.lastIndexOf("\n");
    if (lastNl < 0) return 0;
    idx = lastNl + 1;
    while (lines < this.o.lookaheadLines) {
      const prev = this.buf.lastIndexOf("\n", idx - 2);
      if (prev < 0) return 0;
      idx = prev + 1;
      lines++;
    }
    return idx;
  }

  private write(text: string): void {
    if (!this.streamId) this.streamId = this.editor.streamBegin(this.file, this.at ?? { at: "end" });
    this.editor.streamChunk(this.streamId, text);
    this.typed += text.length;
  }

  private renderGhost(): void {
    if (!this.buf) {
      this.editor.setGhost(this.file, null);
      return;
    }
    const lines = this.buf.split("\n");
    this.editor.setGhost(this.file, lines.slice(0, this.o.maxGhostLines).join("\n"));
  }

  private end(): Hunk[] {
    this.editor.setGhost(this.file, null);
    let hunks: Hunk[] = [];
    if (this.streamId) hunks = this.editor.streamEnd(this.streamId);
    this.streamId = null;
    this.resolveIdle();
    return hunks;
  }

  private resolveIdle(): void {
    const f = this.onIdle;
    this.onIdle = null;
    f?.();
  }
}
