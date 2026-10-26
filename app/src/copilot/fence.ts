// Splits the model's streamed text into chat prose and file code.
// The copilot writes files as fenced blocks:  ```python path=recipes/x.py mode=new
// Everything inside the fence streams into the editor; everything outside goes to the chat.

export interface FenceInfo {
  lang: string;
  path?: string;
  mode: "new" | "rewrite" | "append";
  /** The info string named a mode (mode=...), so the block is meant for a file even without a path. */
  modeSet?: true;
}

export type FenceEvent =
  | { type: "prose"; text: string }
  | { type: "open"; info: FenceInfo }
  | { type: "code"; text: string }
  | { type: "close" };

export function parseFenceInfo(info: string): FenceInfo {
  const parts = info.trim().split(/\s+/).filter(Boolean);
  const out: FenceInfo = { lang: "", mode: "new" };
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) {
      if (!out.lang) out.lang = p;
      continue;
    }
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1).replace(/^["']|["']$/g, "");
    if (k === "path" || k === "file") out.path = v;
    else if (k === "mode" && (v === "new" || v === "rewrite" || v === "append")) {
      out.mode = v;
      out.modeSet = true;
    }
  }
  return out;
}

/** Streaming, line-aware fence splitter. Fence markers must start a line. */
export class FenceSplitter {
  private inCode = false;
  /** Text of the current line not yet classified (could still become a fence marker). */
  private line = "";
  private atLineStart = true;

  push(s: string): FenceEvent[] {
    const ev: FenceEvent[] = [];
    for (const ch of s) this.feed(ch, ev);
    return merge(ev);
  }

  end(): FenceEvent[] {
    const ev: FenceEvent[] = [];
    if (this.line) {
      if (this.inCode) {
        if (this.line.trim() === "```") ev.push({ type: "close" });
        else ev.push({ type: "code", text: this.line });
      } else if (/^```/.test(this.line)) {
        ev.push({ type: "open", info: parseFenceInfo(this.line.slice(3)) });
      } else {
        ev.push({ type: "prose", text: this.line });
      }
    }
    if (this.inCode && !(ev.length && ev[ev.length - 1].type === "close")) ev.push({ type: "close" });
    this.inCode = false;
    this.line = "";
    this.atLineStart = true;
    return merge(ev);
  }

  get writingCode(): boolean {
    return this.inCode;
  }

  private feed(ch: string, ev: FenceEvent[]): void {
    if (this.atLineStart || this.line) {
      // Possibly a fence marker: hold the line until we know.
      this.line += ch;
      this.atLineStart = false;
      if (ch === "\n") {
        const l = this.line;
        this.line = "";
        this.atLineStart = true;
        const body = l.replace(/\r?\n$/, "");
        if (!this.inCode && /^```/.test(body)) {
          this.inCode = true;
          ev.push({ type: "open", info: parseFenceInfo(body.slice(3)) });
        } else if (this.inCode && body.trim() === "```") {
          this.inCode = false;
          ev.push({ type: "close" });
        } else {
          ev.push(this.inCode ? { type: "code", text: l } : { type: "prose", text: l });
        }
        return;
      }
      // Release the held text as soon as it can no longer be a marker.
      const couldBeMarker = this.inCode ? /^\s{0,3}`{0,3}$/.test(this.line) || /^\s{0,3}```\s*$/.test(this.line) : "```".startsWith(this.line) || /^```/.test(this.line);
      if (!couldBeMarker) {
        ev.push(this.inCode ? { type: "code", text: this.line } : { type: "prose", text: this.line });
        this.line = "";
      }
      return;
    }
    ev.push(this.inCode ? { type: "code", text: ch } : { type: "prose", text: ch });
    if (ch === "\n") this.atLineStart = true;
  }
}

function merge(ev: FenceEvent[]): FenceEvent[] {
  const out: FenceEvent[] = [];
  for (const e of ev) {
    const last = out[out.length - 1];
    if (last && (e.type === "prose" || e.type === "code") && last.type === e.type) {
      (last as { text: string }).text += e.text;
    } else {
      out.push(e.type === "prose" || e.type === "code" ? { ...e } : e);
    }
  }
  return out;
}
