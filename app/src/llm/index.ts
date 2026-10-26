// I5 entry point: `import { chat } from "../llm"`. Main process only.
import { anthropicProvider } from "./anthropic";
import { openAiCompatProvider } from "./openaiCompat";
import { claudeCodeProvider } from "./claudeCode";
import type { ChatRequest, LlmChunk } from "./types";

export * from "./types";
export * from "./catalog";
export { testAnthropicConnection, testAnthropicKey, type ConnectionReport } from "./anthropic";
export { listModels, probe } from "./openaiCompat";
export { claudeCodeStatus, testClaudeCode, type ClaudeCodeStatus } from "./claudeCode";

export function chat(req: ChatRequest): AsyncIterable<LlmChunk> {
  switch (req.provider) {
    case "anthropic":
      return anthropicProvider.chat(req);
    case "openai-compatible":
      return openAiCompatProvider.chat(req);
    case "claude-code":
      return claudeCodeProvider.chat(req);
    default:
      return (async function* () {
        yield { type: "error", message: `Unknown provider ${String((req as ChatRequest).provider)}`, retryable: false } as LlmChunk;
      })();
  }
}
