// I5 entry point: `import { chat } from "../llm"`. Main process only.
import { anthropicProvider } from "./anthropic";
import { openAiCompatProvider } from "./openaiCompat";
import type { ChatRequest, LlmChunk } from "./types";

export * from "./types";
export * from "./catalog";
export { testAnthropicKey } from "./anthropic";
export { listModels, probe } from "./openaiCompat";

export function chat(req: ChatRequest): AsyncIterable<LlmChunk> {
  switch (req.provider) {
    case "anthropic":
      return anthropicProvider.chat(req);
    case "openai-compatible":
      return openAiCompatProvider.chat(req);
    default:
      return (async function* () {
        yield { type: "error", message: `Unknown provider ${String((req as ChatRequest).provider)}`, retryable: false } as LlmChunk;
      })();
  }
}
