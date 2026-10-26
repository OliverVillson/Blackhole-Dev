// The copilot controller (renderer side). Owns the conversation, drives the model turn
// loop, routes streamed code into the editor through the Pacer, runs tools, and handles
// pause / stop / steer / accept / reject. The model call itself runs in main (copilot/main.ts)
// because the API key is only readable there.
import type { EditorStreamApi, StreamAt, UserEditEvent } from "../shared/editor";
import type { LlmBlock, LlmChunk, LlmMessage, Usage } from "../llm/types";
import { FenceSplitter, type FenceInfo } from "./fence";
import { Pacer, type PacerOptions } from "./pacer";
import { SYSTEM_PROMPT, compactRanges, turnContext } from "./prompt";
import { GATED_CHANNELS, HELPER_METHODS, MODULE_CHANNELS, TOOL_BY_NAME, llmTools, numbered, planEdits, validateToolInput } from "./tools";

export type CopilotState = "idle" | "thinking" | "writing" | "paused" | "tools" | "error";

export type CopilotEvent =
  | { type: "state"; state: CopilotState; detail?: string }
  | { type: "user-message"; text: string; steer?: boolean }
  | { type: "prose"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "write"; file: string; mode: FenceInfo["mode"]; status: "start" | "done" | "stopped" }
  | { type: "tool"; id: string; name: string; status: "running" | "ok" | "error" | "waiting"; summary: string }
  | { type: "user-edit"; file: string; startLine: number; endLine: number; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string };

export interface TurnRequest {
  turnId: string;
  system: string;
  messages: LlmMessage[];
  tools: ReturnType<typeof llmTools>;
}

/** What the controller needs from the outside world. The renderer wires these to ctx.invoke / ctx.on. */
export interface CopilotHost {
  editor: EditorStreamApi;
  activeFile(): string | null;
  /** Streams one model turn (runs in main). Must end with a done or error chunk. */
  turn(req: TurnRequest): AsyncIterable<LlmChunk>;
  abortTurn(turnId: string): void;
  /** I1 helper call (forwarded by main to the Python helper). */
  helper(method: string, params: object): Promise<unknown>;
  /** Invoke an owning module's main channel; that handler opens the I4 gate itself. */
  invoke(channel: string, payload: object): Promise<unknown>;
  /** Read a file from disk (for files not open in the editor). */
  readFile?(path: string): Promise<string>;
  /** Open a file in the editor; I3 only works on open buffers. */
  openFile?(path: string): Promise<void>;
  /** Timer for the pacer. Tests pass a manual one. */
  every?(ms: number, fn: () => void): () => void;
  pacer?: PacerOptions;
  newFilePath?: string;
}

interface TurnResult {
  text: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  finish: "stop" | "length" | "tool_use" | "refusal" | "aborted" | "error";
  raw?: LlmMessage["raw"];
}

const MAX_AUTO_FOLLOWUPS = 2;

let seq = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export class CopilotSession {
  readonly messages: LlmMessage[] = [];
  private listeners = new Set<(e: CopilotEvent) => void>();
  private _state: CopilotState = "idle";
  private running: Promise<void> | null = null;
  private turnId: string | null = null;
  private pacers: Pacer[] = [];
  private pacerDone: Promise<void>[] = [];
  private stopTimer: (() => void) | null = null;
  private stopRequested = false;
  private pendingSteer: string[] = [];
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private userEdits: UserEditEvent[] = [];
  private unsubEdit: () => void;
  /** Files the copilot wrote or edited in this session (for accept/reject all). */
  readonly touched = new Set<string>();
  /** Where the copilot's text ended in each file (1-based line after it), for mode=append. */
  private anchors = new Map<string, number>();
  private autoFollowups = 0;

  constructor(private host: CopilotHost) {
    this.unsubEdit = host.editor.onUserEdit((e) => {
      if (!this.touched.has(e.file) && !this.pacers.some((p) => p.file === e.file)) return;
      this.userEdits.push(e);
      this.emit({ type: "user-edit", file: e.file, startLine: e.startLine, endLine: e.endLine, text: e.text });
    });
  }

  dispose(): void {
    this.stop();
    this.unsubEdit();
  }

  on(cb: (e: CopilotEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get state(): CopilotState {
    return this._state;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Ask for something. While the copilot is busy this acts as a steer. */
  ask(text: string): Promise<void> {
    if (this.running) {
      this.steer(text);
      return this.running;
    }
    this.emit({ type: "user-message", text });
    this.autoFollowups = 0;
    this.messages.push({ role: "user", content: [{ type: "text", text: this.contextFor(text) }] });
    return this.start();
  }

  /** Redirect the copilot mid-write: what is already typed stays, the ghost is dropped, the model continues with the new instruction. */
  steer(text: string): void {
    if (!this.running) {
      void this.ask(text);
      return;
    }
    this.emit({ type: "user-message", text, steer: true });
    this.pendingSteer.push(text);
    if (this.turnId) this.host.abortTurn(this.turnId);
    for (const p of this.pacers) p.abort();
    this.setPaused(false);
  }

  pause(): void {
    this.setPaused(true);
  }

  resume(): void {
    this.setPaused(false);
  }

  /** Stop everything. Text already typed stays as pending hunks the user can accept or reject. */
  stop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.pendingSteer = [];
    if (this.turnId) this.host.abortTurn(this.turnId);
    for (const p of this.pacers) p.abort();
    this.setPaused(false);
  }

  acceptAll(): void {
    for (const f of this.touched) this.host.editor.acceptAll(f);
  }

  rejectAll(): void {
    this.stop();
    for (const f of this.touched) this.host.editor.rejectAll(f);
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    for (const x of this.pacers) x.setPaused(p);
    if (p) this.setState("paused");
    else {
      const w = this.resumeWaiters;
      this.resumeWaiters = [];
      w.forEach((f) => f());
      if (this.running && this._state === "paused") this.setState(this.pacers.length ? "writing" : "thinking");
    }
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((r) => this.resumeWaiters.push(r));
  }

  private emit(e: CopilotEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setState(s: CopilotState, detail?: string): void {
    this._state = s;
    this.emit({ type: "state", state: s, detail });
  }

  private contextFor(text: string): string {
    const f = this.host.activeFile();
    const body = f ? this.safeText(f) : null;
    return `${turnContext({ activeFile: f, activeText: body, lockedLines: f ? this.lockedLines(f) : [] })}\n\n${text}`;
  }

  private safeText(file: string): string | null {
    try {
      return this.host.editor.getText(file);
    } catch {
      return null;
    }
  }

  private lockedLines(file: string): number[] {
    const out: number[] = [];
    for (const h of this.host.editor.hunks(file)) {
      if (h.kind === "user") for (let l = h.startLine; l <= h.endLine; l++) out.push(l);
    }
    return out;
  }

  private start(): Promise<void> {
    this.stopRequested = false;
    // Start on a microtask so `busy` is already true when the first state event fires.
    this.running = Promise.resolve()
      .then(() => this.loop())
      .catch((err) => {
        this.emit({ type: "error", message: String(err instanceof Error ? err.message : err) });
        this.setState("error");
      })
      .finally(() => {
        this.running = null;
        this.turnId = null;
        this.stopTimer?.();
        this.stopTimer = null;
        if (this._state !== "error") this.setState("idle");
      });
    return this.running;
  }

  private async loop(): Promise<void> {
    for (;;) {
      const r = await this.streamTurn();
      this.pushAssistant(r);
      if (r.finish === "error") {
        this.setState("error");
        return;
      }
      await Promise.all(this.pacerDone);
      this.pacers = [];
      this.pacerDone = [];

      const parts: LlmBlock[] = [];
      if (r.toolCalls.length) {
        if (this.stopRequested || r.finish === "aborted") {
          // Every tool_use needs a tool_result, even when we do not run it.
          for (const c of r.toolCalls) parts.push({ type: "tool_result", tool_use_id: c.id, content: "Not run: the user interrupted.", is_error: true });
        } else {
          await this.waitWhilePaused();
          parts.push(...(await this.runTools(r.toolCalls)));
        }
      }
      if (this.stopRequested) {
        if (parts.length) this.messages.push({ role: "user", content: parts });
        this.userEdits = [];
        return;
      }

      const edits = this.drainUserEdits();
      if (edits) parts.push({ type: "text", text: edits });

      if (this.pendingSteer.length) {
        const steer = this.pendingSteer.join("\n");
        this.pendingSteer = [];
        const interrupted =
          r.finish === "aborted"
            ? "You were interrupted. Anything you had not finished typing was discarded; what is in the editor stays. Continue with mode=append or use edit_file.\n\n"
            : "";
        parts.push({ type: "text", text: interrupted + this.contextFor(`The user says: ${steer}`) });
      } else if (r.finish === "aborted") {
        if (parts.length) this.messages.push({ role: "user", content: parts });
        return;
      } else if (!r.toolCalls.length) {
        // A finished answer. Follow up only to react to the user's own edits.
        if (!edits || this.autoFollowups >= MAX_AUTO_FOLLOWUPS) {
          if (edits) this.messages.push({ role: "user", content: parts });
          return;
        }
        this.autoFollowups++;
      }
      this.messages.push({ role: "user", content: parts });
      await this.waitWhilePaused();
      if (this.stopRequested) return;
    }
  }

  private pushAssistant(r: TurnResult): void {
    const content: LlmBlock[] = [];
    if (r.text) content.push({ type: "text", text: r.text });
    for (const c of r.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    if (!content.length && !r.raw) return;
    // Replay the provider's own content (thinking blocks included) only for complete turns.
    this.messages.push({ role: "assistant", content, raw: r.finish === "aborted" ? undefined : r.raw });
  }

  private drainUserEdits(): string {
    if (!this.userEdits.length) return "";
    const byFile = new Map<string, UserEditEvent[]>();
    for (const e of this.userEdits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    this.userEdits = [];
    const lines: string[] = ["While you were working, the user edited files themselves. Their lines are locked; keep them and adapt the rest."];
    for (const [file, es] of byFile) {
      const nums: number[] = [];
      for (const e of es) for (let l = e.startLine; l <= e.endLine; l++) nums.push(l);
      lines.push(`${file}: lines ${compactRanges(nums)} now read:`);
      const text = this.safeText(file);
      if (text !== null) {
        const all = text.split("\n");
        for (const n of [...new Set(nums)].sort((a, b) => a - b)) if (n <= all.length) lines.push(`${String(n).padStart(4)}  ${all[n - 1]}`);
      }
    }
    lines.push("Re-check anything that depends on these values (lint, plan) and fix what no longer fits. If nothing needs to change, say so in one line.");
    return lines.join("\n");
  }

  private async streamTurn(): Promise<TurnResult> {
    const turnId = newId("turn");
    this.turnId = turnId;
    this.setState("thinking");
    const fence = new FenceSplitter();
    let pacer: Pacer | null = null;
    const res: TurnResult = { text: "", toolCalls: [], finish: "stop" };

    const handle = (evs: ReturnType<FenceSplitter["push"]>) => {
      for (const e of evs) {
        if (e.type === "prose") this.emit({ type: "prose", text: e.text });
        else if (e.type === "open") pacer = this.openPacer(e.info);
        else if (e.type === "code") pacer?.push(e.text);
        else if (e.type === "close" && pacer) {
          const p: Pacer = pacer;
          pacer = null;
          this.pacerDone.push(
            p.finish().then(() => {
              this.trackAnchor(p.file);
              this.emit({ type: "write", file: p.file, mode: "new", status: "done" });
            }),
          );
        }
      }
    };

    for await (const c of this.host.turn({ turnId, system: SYSTEM_PROMPT, messages: [...this.messages], tools: llmTools() })) {
      if (c.type === "text") {
        res.text += c.text;
        handle(fence.push(c.text));
      } else if (c.type === "reasoning") {
        this.emit({ type: "reasoning", text: c.text });
      } else if (c.type === "tool_use") {
        res.toolCalls.push({ id: c.id, name: c.name, input: c.input });
      } else if (c.type === "usage") {
        this.emit({ type: "usage", usage: c.usage });
      } else if (c.type === "done") {
        res.finish = c.finishReason;
        res.raw = c.raw;
      } else if (c.type === "error") {
        res.finish = "error";
        this.emit({ type: "error", message: c.message });
      }
    }
    if (res.finish === "aborted" || res.finish === "error") {
      const open = pacer as Pacer | null;
      if (open) {
        open.abort();
        this.trackAnchor(open.file);
        this.emit({ type: "write", file: open.file, mode: "new", status: "stopped" });
      }
    } else {
      handle(fence.end());
    }
    if (res.finish === "refusal") this.emit({ type: "error", message: "The model declined this request." });
    if (res.finish === "length") this.emit({ type: "error", message: "The answer hit the output limit and was cut off." });
    this.turnId = null;
    return res;
  }

  private openPacer(info: FenceInfo): Pacer {
    const file = info.path ?? this.host.activeFile() ?? this.host.newFilePath ?? "recipes/untitled.py";
    this.touched.add(file);
    // Code is buffered (shown as ghost) until the file is open and we know where to write.
    const p = new Pacer(this.host.editor, file, null, this.host.pacer);
    void this.ensureOpen(file).then((existing) => {
      let at: StreamAt = "end";
      if (info.mode === "rewrite") at = "replaceAll";
      else if (info.mode === "append") {
        const a = this.anchors.get(file);
        at = a ? { line: a } : "end";
      } else if (existing && existing.trim()) {
        // "new" over a file that has content means the model thinks it is replacing it.
        at = "replaceAll";
      }
      p.setAt({ at });
    });
    p.setPaused(this.paused);
    this.pacers.push(p);
    this.ensureTimer();
    this.setState(this.paused ? "paused" : "writing", file);
    this.emit({ type: "write", file, mode: info.mode, status: "start" });
    return p;
  }

  /** Opens an existing file in the editor (I3 needs an open buffer). Returns its text, or null for a new file. */
  private async ensureOpen(file: string): Promise<string | null> {
    if (file === this.host.activeFile() || this.touched.has(file) && this.anchors.has(file)) return this.safeText(file);
    let disk: string | null = null;
    try {
      disk = this.host.readFile ? await this.host.readFile(file) : this.safeText(file);
    } catch {
      disk = null;
    }
    if (disk !== null && this.host.openFile) await this.host.openFile(file);
    return disk;
  }

  private async readAny(file: string): Promise<string> {
    const open = file === this.host.activeFile() || this.touched.has(file) ? this.safeText(file) : null;
    if (open !== null) return open;
    if (this.host.readFile) return this.host.readFile(file);
    return this.host.editor.getText(file);
  }

  private trackAnchor(file: string): void {
    const hs = this.host.editor.hunks(file).filter((h) => h.kind === "copilot" && h.state === "pending");
    if (hs.length) this.anchors.set(file, Math.max(...hs.map((h) => h.endLine)) + 1);
  }

  private ensureTimer(): void {
    if (this.stopTimer) return;
    const every = this.host.every ?? ((ms, fn) => {
      const h = setInterval(fn, ms);
      return () => clearInterval(h);
    });
    this.stopTimer = every(30, () => {
      for (const p of this.pacers) p.tick();
    });
  }

  private async runTools(calls: TurnResult["toolCalls"]): Promise<LlmBlock[]> {
    this.setState("tools");
    // Independent calls run concurrently; all results go back in one user message.
    return Promise.all(
      calls.map(async (c): Promise<LlmBlock> => {
        const v = validateToolInput(c.name, c.input);
        if (!v.ok) {
          this.emit({ type: "tool", id: c.id, name: c.name, status: "error", summary: v.error });
          return { type: "tool_result", tool_use_id: c.id, content: v.error, is_error: true };
        }
        this.emit({ type: "tool", id: c.id, name: c.name, status: TOOL_BY_NAME.get(c.name)?.side === "gated" ? "waiting" : "running", summary: describeCall(c.name, v.value) });
        try {
          const out = await this.runTool(c.name, v.value);
          this.emit({ type: "tool", id: c.id, name: c.name, status: "ok", summary: out.summary });
          return { type: "tool_result", tool_use_id: c.id, content: out.content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.emit({ type: "tool", id: c.id, name: c.name, status: "error", summary: msg });
          return { type: "tool_result", tool_use_id: c.id, content: msg, is_error: true };
        }
      }),
    );
  }

  private async runTool(name: string, input: any): Promise<{ content: string; summary: string }> {
    const ed = this.host.editor;
    switch (name) {
      case "read_file": {
        const t = await this.readAny(input.path);
        return { content: numbered(t), summary: `read ${input.path} · ${t.split("\n").length} lines` };
      }
      case "edit_file": {
        await this.ensureOpen(input.path);
        const text = ed.getText(input.path);
        const locked = new Set(this.lockedLines(input.path));
        const plan = planEdits(text, input.edits, (l) => locked.has(l));
        if (!plan.ok) throw new Error(plan.error);
        this.touched.add(input.path);
        ed.applyEdits(input.path, plan.edits);
        return { content: `Applied ${plan.edits.length} edit(s) to ${input.path}. They show as pending changes the user can accept or reject.`, summary: `edited ${input.path} · ${plan.edits.length} change(s)` };
      }
      case "request_action": {
        const channel = GATED_CHANNELS[input.action];
        const result = await this.host.invoke(channel, { ...input, requestedBy: "copilot" });
        const approved = !(result && typeof result === "object" && (result as { approved?: boolean }).approved === false);
        return {
          content: approved ? `The user approved ${input.action}. Result: ${JSON.stringify(result ?? null)}` : `The user declined ${input.action}. Do not ask again unless they bring it up.`,
          summary: approved ? `${input.action} approved by you` : `${input.action} declined`,
        };
      }
      case "list_machines":
      case "job_status": {
        const channel = input.name || name === "list_machines" ? MODULE_CHANNELS[name] : "vm:job.list";
        const out = await this.host.invoke(channel, name === "job_status" && !input.name ? input.hostId : input);
        return { content: JSON.stringify(out ?? null), summary: name === "list_machines" ? "listed your machines" : `checked jobs on ${input.hostId}` };
      }
      default: {
        const method = HELPER_METHODS[name];
        if (!method) throw new Error(`No handler for ${name}`);
        const params: Record<string, unknown> = { ...input };
        // Lint and plan read the live buffer, so they see what is streaming before it is saved.
        if ((name === "lint_recipe" || name === "plan_recipe") && typeof input.path === "string") {
          const t = this.safeText(input.path);
          if (t !== null) params.text = t;
        }
        const out = await this.host.helper(method, params);
        return { content: JSON.stringify(out), summary: summarizeResult(name, out) };
      }
    }
  }
}

function describeCall(name: string, input: any): string {
  switch (name) {
    case "plan_recipe":
      return `planning ${input.path} for ${input.device}`;
    case "lint_recipe":
      return `linting ${input.path}`;
    case "open_model":
      return `reading anatomy of ${input.model}`;
    case "request_action":
      return `waiting for your approval: ${input.action}`;
    default:
      return name.replace(/_/g, " ");
  }
}

function summarizeResult(name: string, out: any): string {
  try {
    if (name === "lint_recipe") {
      const ps = out?.problems ?? [];
      const errs = ps.filter((p: any) => p.severity === "error").length;
      return ps.length ? `lint: ${errs} error(s), ${ps.length - errs} warning(s)` : "lint: clean";
    }
    if (name === "plan_recipe") {
      const size = out?.sizeGb == null ? "size unknown" : `~${Number(out.sizeGb).toFixed(1)} GB`;
      const fits = out?.fits == null ? "" : out.fits ? " · fits" : " · does not fit";
      return `plan → ${size}${fits}`;
    }
    if (name === "open_model") return `anatomy · ${out?.summary ?? out?.name ?? "opened"}`;
    if (name === "list_functions") return `${Array.isArray(out) ? out.length : "?"} functions`;
  } catch {
    /* fall through */
  }
  return `${name.replace(/_/g, " ")} done`;
}
