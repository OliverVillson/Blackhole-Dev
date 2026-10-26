// A scripted ChatApi for the UI test and the standalone preview: no Electron, no server.
import type { ChatApi, ChatEvent, ChatMessage, ChatSettings, LocalModel, ServerState } from '../../../src/chat/shared/types';
import { DEFAULT_SETTINGS } from '../../../src/chat/shared/types';

export const MODELS: LocalModel[] = [
  { id: '/Users/me/flint/qwen3.6-blackhole-9.8GB', name: 'qwen3.6-blackhole-9.8GB', path: '/Users/me/flint/qwen3.6-blackhole-9.8GB', format: 'mlx', sizeBytes: 9.76e9, source: 'pipeline', arch: 'Qwen3_5MoeForCausalLM', bits: 3, hex: true },
  { id: '/Users/me/flint/flint-REAP-128e-MLX-9.1GB', name: 'flint-REAP-128e-MLX-9.1GB', path: '/Users/me/flint/flint-REAP-128e-MLX-9.1GB', format: 'mlx', sizeBytes: 9.1e9, source: 'pipeline', bits: 3, hex: false },
  { id: '/Users/me/.blackhole/models/mlx-community/Qwen3-8B-4bit', name: 'Qwen3-8B-4bit', path: '/Users/me/.blackhole/models/mlx-community/Qwen3-8B-4bit', format: 'mlx', sizeBytes: 4.6e9, source: 'download', bits: 4, hex: false },
];

export function fakeApi(opts: { tokenMs?: number; reply?: string; think?: string } = {}): ChatApi & { emit(e: ChatEvent): void } {
  const subs = new Set<(e: ChatEvent) => void>();
  const emit = (e: ChatEvent) => subs.forEach((f) => f(e));
  let state: ServerState = { phase: 'stopped' };
  let settings: ChatSettings = DEFAULT_SETTINGS('/Users/me');
  const histories = new Map<string, ChatMessage[]>();
  const historyOf = (id: string) => histories.get(id) ?? (histories.set(id, []), histories.get(id)!);
  let aborted = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const api: ChatApi & { emit(e: ChatEvent): void } = {
    emit,
    listModels: async () => MODELS,
    rescan: async () => MODELS,
    download: async (r) => ({ repo: r.repo, file: '', doneBytes: 0, totalBytes: 0, phase: 'cancelled', approved: false }),
    cancelDownload: async () => {},
    start: async (id) => {
      state = { phase: 'starting', modelId: id };
      emit({ type: 'server', state });
      await sleep(20);
      state = { phase: 'ready', modelId: id, baseUrl: 'http://127.0.0.1:8080/v1', servedModel: id, command: `~/mlx-venv/bin/mlx_lm.server --model ${id} --port 8080 --trust-remote-code --prompt-concurrency 1 --prefill-step-size 512 --prompt-cache-size 2` };
      emit({ type: 'server', state });
      return state;
    },
    stop: async () => ((state = { phase: 'stopped' }), emit({ type: 'server', state }), state),
    state: async () => state,
    logs: async () => ['Fetching 12 files: 100%', 'Starting httpd at 127.0.0.1 on port 8080...'],
    wired: async () => ({ supported: true, currentMb: 0, recommendedMb: 12288, totalMb: 16384, ok: false }),
    setWired: async (mb) => ({ supported: true, currentMb: mb, recommendedMb: 12288, totalMb: 16384, ok: true }),
    send: async (text) => {
      aborted = false;
      const modelId = state.modelId!;
      const history = historyOf(modelId);
      history.push({ role: 'user', content: text });
      const think = (opts.think ?? 'The user wants a quick check. Keep it short.').split(/(?<=\s)/);
      const reply = (opts.reply ?? 'Here you go:\n\n```python\nprint("hello from a 9.8 GB model")\n```').split(/(?<=\s)/);
      const t0 = Date.now();
      let tFirst = 0;
      for (const t of think) {
        if (aborted) break;
        tFirst ||= Date.now();
        emit({ type: 'delta', modelId, turn: 1, reasoning: t });
        await sleep(opts.tokenMs ?? 1);
      }
      for (const t of reply) {
        if (aborted) break;
        emit({ type: 'delta', modelId, turn: 1, text: t });
        await sleep(opts.tokenMs ?? 1);
      }
      const n = think.length + reply.length;
      const m: ChatMessage = {
        role: 'assistant',
        content: reply.join(''),
        reasoning: think.join(''),
        stopped: aborted || undefined,
        stats: { promptTokens: 412, completionTokens: n, reasoningTokens: think.length, ttftS: 0.38, genTokS: 67.8, prefillTokS: 1076, totalS: (Date.now() - t0) / 1000, counted: 'usage' },
      };
      void tFirst;
      history.push(m);
      return m;
    },
    abort: async () => {
      aborted = true;
    },
    history: async (id) => [...historyOf(id)],
    clear: async (id) => {
      histories.delete(id);
    },
    getSettings: async () => settings,
    setSettings: async (p) => (settings = { ...settings, ...(p as any) }),
    onEvent: (cb) => (subs.add(cb), () => subs.delete(cb)),
  };
  return api;
}
