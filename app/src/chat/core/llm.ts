// The I5 provider layer is shared with the copilot and owned by WS4 (src/llm). The chat only
// uses the openai-compatible provider against the local server.
export { chat } from '../../llm';
export type { ChatRequest as LlmRequest, LlmChunk, LlmMessage } from '../../llm';
import type { ChatRequest, LlmChunk } from '../../llm';

export type ChatFn = (req: ChatRequest) => AsyncIterable<LlmChunk>;
