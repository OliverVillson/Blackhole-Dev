import type { ChatStats } from './types';

/**
 * Times one streamed reply. Every text or reasoning chunk counts as one token unless the
 * server later reports usage (mlx_lm.server streams one token per chunk, so the two agree).
 */
export class StatsMeter {
  private t0: number;
  private tFirst?: number;
  private tLast?: number;
  private chunks = 0;
  private reasoningChunks = 0;
  private usage?: { input: number; output: number };

  constructor(private now: () => number = () => performance.now()) {
    this.t0 = now();
  }

  token(kind: 'text' | 'reasoning'): void {
    const t = this.now();
    if (this.tFirst === undefined) this.tFirst = t;
    this.tLast = t;
    this.chunks++;
    if (kind === 'reasoning') this.reasoningChunks++;
  }

  setUsage(input: number, output: number): void {
    this.usage = { input, output };
  }

  result(): ChatStats {
    const end = this.tLast ?? this.now();
    const first = this.tFirst ?? end;
    const ttftS = (first - this.t0) / 1000;
    const completion = this.usage?.output || this.chunks;
    const genS = (end - first) / 1000;
    // The first token comes out of prefill, so the generation rate covers the tokens after it.
    const genTokS = genS > 0 && completion > 1 ? (completion - 1) / genS : 0;
    const prompt = this.usage?.input;
    return {
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: this.reasoningChunks,
      ttftS,
      genTokS,
      prefillTokS: prompt && ttftS > 0 ? prompt / ttftS : undefined,
      totalS: (end - this.t0) / 1000,
      counted: this.usage?.output ? 'usage' : 'chunks',
    };
  }

  /** Live rate while streaming, for the status line. */
  liveTokS(): number {
    if (this.tFirst === undefined || this.tLast === undefined || this.chunks < 2) return 0;
    const s = (this.tLast - this.tFirst) / 1000;
    return s > 0 ? (this.chunks - 1) / s : 0;
  }
}

export function formatStats(s: ChatStats): string {
  const parts = [`${s.genTokS.toFixed(1)} tok/s`];
  if (s.prefillTokS) parts.push(`prefill ${Math.round(s.prefillTokS)} tok/s`);
  parts.push(`${s.completionTokens} tokens`);
  if (s.reasoningTokens) parts.push(`${s.reasoningTokens} thinking`);
  parts.push(`first token ${s.ttftS.toFixed(1)} s`);
  return parts.join(' · ');
}

/**
 * Some chat templates (Qwen3.6) open <think> inside the prompt, so the reply starts with the
 * reasoning and only ever emits </think>. Move text before an orphan </think> into reasoning.
 */
export function splitOrphanThink(content: string, reasoning = ''): { content: string; reasoning: string } {
  if (content.includes('<think>')) return { content, reasoning };
  const i = content.indexOf('</think>');
  if (i < 0) return { content, reasoning };
  return {
    reasoning: reasoning + content.slice(0, i),
    content: content.slice(i + '</think>'.length).replace(/^\s+/, ''),
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
