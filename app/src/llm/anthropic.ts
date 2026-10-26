// Anthropic provider: the user's own API key (from the macOS Keychain, read in main).
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_ANTHROPIC_MODEL } from "./catalog";
import type { ChatRequest, LlmBlock, LlmChunk, LlmMessage, Provider } from "./types";

// Server-side refusal fallback, routed by refusal category.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type ClientFactory = (apiKey: string) => Anthropic;
let makeClient: ClientFactory = (apiKey) => new Anthropic({ apiKey });

/** Tests point the client at a local SSE server. */
export function setAnthropicClientFactory(f: ClientFactory): void {
  makeClient = f;
}

function toBlockParam(b: LlmBlock): Anthropic.Beta.BetaContentBlockParam {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
  }
}

export function toAnthropicMessages(messages: LlmMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    // Replay assistant turns exactly as received (thinking blocks must stay unchanged).
    if (m.role === "assistant" && m.raw?.provider === "anthropic") {
      return { role: "assistant", content: m.raw.content as Anthropic.Beta.BetaContentBlockParam[] };
    }
    return {
      role: m.role,
      content: typeof m.content === "string" ? m.content : m.content.map(toBlockParam),
    };
  });
}

function errorChunk(err: unknown): LlmChunk {
  if (err instanceof Anthropic.AuthenticationError) {
    return { type: "error", message: "Anthropic rejected the API key. Check it in Settings › Copilot.", retryable: false, status: 401 };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { type: "error", message: "This API key cannot use that model.", retryable: false, status: 403 };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { type: "error", message: "Model not found.", retryable: false, status: 404 };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { type: "error", message: "Rate limited by Anthropic. Try again shortly.", retryable: true, status: 429 };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { type: "error", message: `Bad request: ${err.message}`, retryable: false, status: 400 };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { type: "error", message: "Cannot reach api.anthropic.com.", retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? undefined;
    return { type: "error", message: err.message, retryable: status === undefined || status >= 500, status };
  }
  // Tool input that is not parseable JSON (eager input streaming): re-issuing the turn fixes it.
  return { type: "error", message: err instanceof Error ? err.message : String(err), retryable: true };
}

export const anthropicProvider: Provider = {
  async *chat(req: ChatRequest): AsyncIterable<LlmChunk> {
    if (!req.apiKey) {
      yield { type: "error", message: "No Anthropic API key. Add yours in Settings › Copilot.", retryable: false };
      return;
    }
    const client = makeClient(req.apiKey);
    const p = req.params ?? {};
    const tools: Anthropic.Beta.BetaToolUnion[] | undefined = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      eager_input_streaming: true,
    }));

    let stream: ReturnType<typeof client.beta.messages.stream> | undefined;
    try {
      stream = client.beta.messages.stream(
        {
          model: req.model || DEFAULT_ANTHROPIC_MODEL,
          max_tokens: p.max_tokens ?? 64000,
          // Stable system prompt first so the prefix caches across turns.
          system: req.system ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : undefined,
          messages: toAnthropicMessages(req.messages),
          tools,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: p.effort ?? "high" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal: req.signal },
      );

      for await (const ev of stream) {
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
          else if (ev.delta.type === "thinking_delta") yield { type: "reasoning", text: ev.delta.thinking };
        }
      }
      const msg = await stream.finalMessage();

      const stop = msg.stop_reason;
      // Never hand over tool calls from a refused or truncated turn.
      if (stop !== "refusal" && stop !== "max_tokens") {
        for (const b of msg.content) {
          if (b.type === "tool_use") yield { type: "tool_use", id: b.id, name: b.name, input: b.input };
        }
      }
      yield {
        type: "usage",
        usage: {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? undefined,
        },
      };
      yield {
        type: "done",
        finishReason:
          stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "length" : stop === "refusal" ? "refusal" : "stop",
        raw: { provider: "anthropic", content: msg.content },
        model: msg.model,
      };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      yield errorChunk(err);
    }
  },
};

/** Cheap key check for the settings screen (1 output token). */
export async function testAnthropicKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    await makeClient(apiKey).models.retrieve(DEFAULT_ANTHROPIC_MODEL);
    return { ok: true, message: "Key works." };
  } catch (err) {
    const c = errorChunk(err);
    return { ok: false, message: c.type === "error" ? c.message : "Key check failed." };
  }
}
