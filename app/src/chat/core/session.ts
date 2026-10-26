import { splitOrphanThink, StatsMeter } from '../shared/stats';
import type { ChatMessage, GenerationSettings } from '../shared/types';
import type { ChatFn, LlmMessage } from './llm';

export interface SessionTarget {
  baseUrl: string;
  model: string;
}

/**
 * One conversation with the local model. Reasoning is shown but never sent back: the next
 * request carries only the visible answers, as chat templates for thinking models expect.
 */
export class ChatSession {
  readonly messages: ChatMessage[] = [];
  private abort?: AbortController;
  private turn = 0;

  constructor(
    private chat: ChatFn,
    private onDelta: (turn: number, d: { text?: string; reasoning?: string }) => void = () => {},
    saved: ChatMessage[] = [],
  ) {
    this.messages.push(...saved);
  }

  get busy(): boolean {
    return Boolean(this.abort);
  }

  stop(): void {
    this.abort?.abort();
  }

  clear(): void {
    this.stop();
    this.messages.length = 0;
  }

  async send(text: string, target: SessionTarget, g: GenerationSettings): Promise<ChatMessage> {
    if (this.abort) throw new Error('the model is still answering; stop it first');
    const turn = ++this.turn;
    this.messages.push({ role: 'user', content: text });
    const history: LlmMessage[] = this.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const ac = new AbortController();
    this.abort = ac;
    const meter = new StatsMeter();
    const reply: ChatMessage = { role: 'assistant', content: '', reasoning: '' };
    try {
      for await (const c of this.chat({
        provider: 'openai-compatible',
        baseUrl: target.baseUrl,
        model: target.model,
        messages: history,
        system: g.systemPrompt || undefined,
        signal: ac.signal,
        params: {
          max_tokens: g.maxTokens,
          temperature: g.temperature,
          top_p: g.topP,
          ...(!g.thinking && { extra: { chat_template_kwargs: { enable_thinking: false } } }),
        },
      })) {
        if (c.type === 'text') {
          meter.token('text');
          reply.content += c.text;
          this.onDelta(turn, { text: c.text });
        } else if (c.type === 'reasoning') {
          meter.token('reasoning');
          reply.reasoning += c.text;
          this.onDelta(turn, { reasoning: c.text });
        } else if (c.type === 'usage') {
          meter.setUsage(c.usage.input_tokens, c.usage.output_tokens);
        } else if (c.type === 'done') {
          if (c.finishReason === 'aborted') reply.stopped = true;
          if (c.finishReason === 'length') reply.error = `Stopped at the ${g.maxTokens}-token limit.`;
        } else if (c.type === 'error') {
          reply.error = c.message;
        }
      }
    } finally {
      this.abort = undefined;
    }
    Object.assign(reply, splitOrphanThink(reply.content, reply.reasoning));
    // Thinking models leave blank lines between </think> and the answer.
    reply.content = reply.content.replace(/^\s+/, '');
    if (!reply.reasoning) delete reply.reasoning;
    reply.stats = meter.result();
    // A failed turn with no text is shown but kept out of the next request.
    if (reply.error && !reply.content && reply.error !== `Stopped at the ${g.maxTokens}-token limit.`) {
      this.messages[this.messages.length - 1].error = reply.error;
    }
    this.messages.push(reply);
    return reply;
  }
}
