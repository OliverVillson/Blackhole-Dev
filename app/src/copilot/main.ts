// Copilot, main-process side: runs model turns with the user's own key and forwards
// helper (I1) calls for the copilot's cheap tools. The renderer drives the loop.
import type { MainContext } from "../shared/ext";
import { chat, DEFAULT_ANTHROPIC_MODEL, LOCAL_PRESETS, probe, testAnthropicKey, type Effort, type LlmChunk } from "../llm";
import type { TurnRequest } from "./session";
import { HELPER_METHODS } from "./tools";

export const KEY_NAME = "anthropic-api-key";

export type ProviderSettings =
  | { provider: "anthropic"; model: string; effort: Effort }
  | { provider: "openai-compatible"; preset: keyof typeof LOCAL_PRESETS | "custom"; baseUrl: string; model: string };

export const DEFAULT_SETTINGS: ProviderSettings = { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, effort: "high" };

const ALLOWED_HELPER = new Set(Object.values(HELPER_METHODS));

export function activate(ctx: MainContext): void {
  const turns = new Map<string, AbortController>();
  const getSettings = () => ctx.settings.get<ProviderSettings>("copilot.provider", DEFAULT_SETTINGS);

  ctx.handle("copilot:settings", () => getSettings());
  ctx.handle("copilot:setSettings", (s: ProviderSettings) => {
    ctx.settings.set("copilot.provider", s);
    return s;
  });

  // The renderer may set, check or delete the key, never read it back.
  ctx.handle("copilot:hasKey", () => ctx.secrets.has(KEY_NAME));
  ctx.handle("copilot:setKey", async (key: string) => {
    const k = String(key ?? "").trim();
    if (!k) return { ok: false, message: "Empty key." };
    const t = await testAnthropicKey(k);
    if (t.ok) await ctx.secrets.set(KEY_NAME, k);
    return t;
  });
  ctx.handle("copilot:deleteKey", () => ctx.secrets.delete(KEY_NAME));

  ctx.handle("copilot:probe", (baseUrl: string) => probe({ baseUrl }));

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
          params: s.provider === "anthropic" ? { effort: s.effort, max_tokens: 64000 } : { max_tokens: 16384 },
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
