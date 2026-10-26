// Copilot, main-process side: runs model turns with the user's own key (or their own signed-in
// Claude Code) and forwards helper (I1) calls for the copilot's cheap tools. The renderer drives
// the loop; for Claude Code, whose own loop owns the turn, tool calls come back here over a local
// MCP bridge and are sent to the renderer to run (copilot:toolCall → copilot:toolResult).
import type { MainContext } from "../shared/ext";
import { anthropicModel, chat, claudeCodeModel, claudeCodeStatus, DEFAULT_ANTHROPIC_MODEL, LOCAL_PRESETS, probe, testAnthropicConnection, testAnthropicKey, testClaudeCode, type ConnectionReport, type Effort, type LlmChunk } from "../llm";
import type { TurnRequest } from "./session";
import { HELPER_METHODS } from "./tools";

export const KEY_NAME = "anthropic-api-key";
/** Last four characters of the saved key, so the panel can say which key is in use. Not secret. */
const HINT_SETTING = "copilot.keyHint";

export interface KeyStatus {
  has: boolean;
  /** e.g. "sk-ant-…x7Qa"; null when the key was saved before hints existed. */
  hint: string | null;
  /** Electron safeStorage can encrypt on this machine (macOS Keychain). */
  encryption: boolean;
}

export function keyHint(key: string): string {
  return `${key.startsWith("sk-ant-") ? "sk-ant-" : ""}…${key.slice(-4)}`;
}

/** Quick format check before any network call. */
export function keyProblem(key: string): string | null {
  if (!key) return "Paste a key first.";
  if (/\s/.test(key)) return "The key has a space or line break in it. Copy it again from the Anthropic Console.";
  if (!key.startsWith("sk-ant-")) return "That does not look like an Anthropic API key (they start with sk-ant-).";
  if (key.startsWith("sk-ant-admin")) return "That is an Admin key. The copilot needs a normal API key from Console › API keys.";
  return null;
}

export type ProviderSettings =
  | { provider: "anthropic"; model: string; effort: Effort }
  | { provider: "openai-compatible"; preset: keyof typeof LOCAL_PRESETS | "custom"; baseUrl: string; model: string }
  | { provider: "claude-code"; model: string; effort: Effort };

/** A tool call from inside a Claude Code run, for the renderer to execute. */
export interface ToolCallEvent {
  turnId: string;
  callId: string;
  name: string;
  input: unknown;
}

export const DEFAULT_SETTINGS: ProviderSettings = { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, effort: "high" };

const EFFORT_SET = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/** Keeps a bad value from the renderer (or an old settings file) out of the request. */
export function normalizeSettings(s: ProviderSettings): ProviderSettings {
  if (s?.provider === "openai-compatible") {
    return { provider: "openai-compatible", preset: s.preset in LOCAL_PRESETS ? s.preset : "custom", baseUrl: String(s.baseUrl ?? ""), model: String(s.model ?? "") };
  }
  if (s?.provider === "claude-code") {
    const m = claudeCodeModel(String(s.model ?? "")) ?? claudeCodeModel("default")!;
    return { provider: "claude-code", model: m.id, effort: EFFORT_SET.has(s.effort) ? s.effort : m.defaultEffort };
  }
  const model = anthropicModel(s?.model ?? "") ? s.model : DEFAULT_ANTHROPIC_MODEL;
  const effort = EFFORT_SET.has((s as { effort?: Effort })?.effort as Effort) ? (s as { effort: Effort }).effort : anthropicModel(model)!.defaultEffort;
  return { provider: "anthropic", model, effort };
}

const ALLOWED_HELPER = new Set(Object.values(HELPER_METHODS));

/** How long a tool call from Claude Code may wait on the renderer (a gated action waits on a human click). */
const TOOL_WAIT_MS = 15 * 60_000;

export function activate(ctx: MainContext): void {
  const turns = new Map<string, AbortController>();
  const pendingTools = new Map<string, { turnId: string; resolve: (r: { content: string; isError?: boolean }) => void }>();
  let callSeq = 0;
  const getSettings = () => normalizeSettings(ctx.settings.get<ProviderSettings>("copilot.provider", DEFAULT_SETTINGS));

  ctx.handle("copilot:settings", () => getSettings());
  ctx.handle("copilot:setSettings", (s: ProviderSettings) => {
    const clean = normalizeSettings(s);
    ctx.settings.set("copilot.provider", clean);
    return clean;
  });

  // The renderer may set, check or delete the key, never read it back. The key is encrypted
  // with safeStorage (a per-user macOS Keychain entry) and decrypted only here in main.
  const keyStatus = async (): Promise<KeyStatus> => {
    const has = await ctx.secrets.has(KEY_NAME);
    return { has, hint: has ? ctx.settings.get<string | null>(HINT_SETTING, null) : null, encryption: ctx.secrets.available?.() ?? true };
  };
  ctx.handle("copilot:hasKey", () => ctx.secrets.has(KEY_NAME));
  ctx.handle("copilot:keyStatus", keyStatus);
  ctx.handle("copilot:setKey", async (key: string) => {
    const k = String(key ?? "").trim();
    const bad = keyProblem(k);
    if (bad) return { ok: false, saved: false, message: bad };
    const s = getSettings();
    const t = await testAnthropicKey(k, s.provider === "anthropic" ? s.model : DEFAULT_ANTHROPIC_MODEL);
    // Offline is not the key's fault: keep it and say so. A rejected key is never stored.
    if (!t.ok && !t.retryable) return { ok: false, saved: false, message: t.message };
    try {
      await ctx.secrets.set(KEY_NAME, k);
    } catch (err) {
      return { ok: false, saved: false, message: `Could not encrypt the key: ${err instanceof Error ? err.message : String(err)}` };
    }
    ctx.settings.set(HINT_SETTING, keyHint(k));
    return t.ok
      ? { ok: true, saved: true, message: "Key works. Saved encrypted in your Keychain." }
      : { ok: false, saved: true, message: `Saved, but could not check it: ${t.message}` };
  });
  ctx.handle("copilot:deleteKey", async () => {
    await ctx.secrets.delete(KEY_NAME);
    ctx.settings.set(HINT_SETTING, null);
    return keyStatus();
  });

  /** "Test connection" for whatever the panel has selected. */
  ctx.handle("copilot:test", async (): Promise<ConnectionReport> => {
    const s = getSettings();
    if (s.provider === "claude-code") return testClaudeCode(s.model);
    if (s.provider === "anthropic") {
      const key = await ctx.secrets.get(KEY_NAME);
      if (!key) return { ok: false, message: "No API key saved yet. Paste yours above." };
      return testAnthropicConnection(key, s.model);
    }
    const r = await probe({ baseUrl: s.baseUrl, timeoutMs: 3000 });
    if (!r.ok) return { ok: false, message: `No server at ${s.baseUrl} (${r.message ?? "unreachable"}). Start mlx_lm.server, llama.cpp or Ollama first.` };
    if (!s.model) return { ok: false, message: `Server is up (${r.latencyMs} ms) but no model is picked.` };
    if (r.models.length && !r.models.includes(s.model)) return { ok: false, message: `Server is up but does not list ${s.model}. It serves: ${r.models.slice(0, 5).join(", ")}` };
    return { ok: true, message: `Connected to ${s.model} at ${s.baseUrl} in ${r.latencyMs} ms.`, model: s.model, latencyMs: r.latencyMs };
  });

  ctx.handle("copilot:probe", (baseUrl: string) => probe({ baseUrl }));
  /** Is `claude` installed and signed in? Never reads the login itself. */
  ctx.handle("copilot:claudeStatus", () => claudeCodeStatus());

  ctx.handle("copilot:toolResult", (callId: string, result: { content: string; isError?: boolean }) => {
    const p = pendingTools.get(callId);
    if (!p) return false;
    pendingTools.delete(callId);
    p.resolve({ content: String(result?.content ?? ""), isError: !!result?.isError });
    return true;
  });

  const runToolInRenderer = (turnId: string, signal: AbortSignal) => (name: string, input: unknown) =>
    new Promise<{ content: string; isError?: boolean }>((resolve) => {
      const callId = `${turnId}:${callSeq++}`;
      const done = (r: { content: string; isError?: boolean }) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        pendingTools.delete(callId);
        resolve(r);
      };
      const onAbort = () => done({ content: "Not run: the user interrupted.", isError: true });
      const timer = setTimeout(() => done({ content: "The tool did not answer in time.", isError: true }), TOOL_WAIT_MS);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      pendingTools.set(callId, { turnId, resolve: done });
      ctx.send("copilot:toolCall", { turnId, callId, name, input } satisfies ToolCallEvent);
    });

  ctx.handle("copilot:turn", async (req: TurnRequest) => {
    const s = getSettings();
    const ctl = new AbortController();
    turns.set(req.turnId, ctl);
    const send = (chunk: LlmChunk) => ctx.send("copilot:chunk", { turnId: req.turnId, chunk });
    // Stream in the background; the invoke returns at once and chunks arrive as events.
    void (async () => {
      try {
        const apiKey = s.provider === "anthropic" ? (await ctx.secrets.get(KEY_NAME)) ?? undefined : undefined;
        const stream = chat({
          provider: s.provider,
          model: s.model,
          baseUrl: s.provider === "openai-compatible" ? s.baseUrl : undefined,
          apiKey,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          signal: ctl.signal,
          params: s.provider === "openai-compatible" ? { max_tokens: 16384 } : { effort: s.effort, max_tokens: 64000 },
          runTool: s.provider === "claude-code" ? runToolInRenderer(req.turnId, ctl.signal) : undefined,
          cwd: s.provider === "claude-code" ? ctx.paths.workspace : undefined,
        });
        let ended = false;
        for await (const c of stream) {
          send(c);
          if (c.type === "done" || c.type === "error") ended = true;
        }
        if (!ended) send({ type: "done", finishReason: ctl.signal.aborted ? "aborted" : "stop" });
      } catch (err) {
        send({ type: "error", message: String(err), retryable: false });
      } finally {
        turns.delete(req.turnId);
      }
    })();
    return { turnId: req.turnId, provider: s.provider, model: s.model };
  });

  ctx.handle("copilot:abort", (turnId: string) => {
    turns.get(turnId)?.abort();
    return true;
  });

  ctx.handle("copilot:helper", (method: string, params: object) => {
    if (!ALLOWED_HELPER.has(method)) throw new Error(`Copilot may not call ${method}`);
    return ctx.helper.call(method, params);
  });
}
