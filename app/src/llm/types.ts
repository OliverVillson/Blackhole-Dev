// I5 LLM provider API. Shared by the copilot (WS4) and local chat (WS6).
// Runs in the Electron main process: the Anthropic key is only readable there.

export type ProviderId = "anthropic" | "openai-compatible";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A provider-neutral content block. `raw` on an assistant message carries the
 *  provider's own content array (Anthropic thinking blocks included) so it can be
 *  sent back unchanged on the next turn. */
export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmBlock[];
  /** Provider-native assistant content, replayed verbatim to the same provider. */
  raw?: { provider: ProviderId; content: unknown };
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema object. */
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ChatParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  /** Anthropic only. */
  effort?: Effort;
  /** openai-compatible: the chat template opens <think> in the prompt, so the stream starts inside reasoning. */
  startsInThink?: boolean;
  /** Merged verbatim into the request body (openai-compatible only). */
  extra?: Record<string, unknown>;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: LlmMessage[];
  system?: string;
  tools?: LlmTool[];
  /** openai-compatible: e.g. http://127.0.0.1:8080/v1 */
  baseUrl?: string;
  /** anthropic: the user's own key. openai-compatible: optional bearer token. */
  apiKey?: string;
  signal?: AbortSignal;
  params?: ChatParams;
}

export type FinishReason = "stop" | "length" | "tool_use" | "refusal" | "aborted";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export type LlmChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Emitted once per tool call, when its input is complete and parsed. */
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  /** Last chunk of a successful (or aborted) turn. `raw` is the assistant content to replay. */
  | { type: "done"; finishReason: FinishReason; raw?: LlmMessage["raw"]; model?: string }
  | { type: "error"; message: string; retryable: boolean; status?: number };

export interface Provider {
  chat(req: ChatRequest): AsyncIterable<LlmChunk>;
}
