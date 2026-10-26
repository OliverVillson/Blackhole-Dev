// Types shared by the chat main process, preload bridge and renderer panel.
// Nothing in here may import Node or Electron: the renderer bundles it too.

export type ModelFormat = 'mlx' | 'gguf';

/** A model folder (MLX) or file (GGUF) found on this Mac. */
export interface LocalModel {
  id: string; // absolute path, stable across scans
  name: string; // folder or file name
  path: string;
  format: ModelFormat;
  sizeBytes: number;
  /** "pipeline" when the folder carries a BlackHole receipt or lives in a pipeline output folder. */
  source: 'pipeline' | 'download' | 'other';
  arch?: string; // config.json architectures[0] or model_type
  bits?: number; // quantization.bits when the config has it
  /** HEX-packed experts need the BlackHole Metal kernels (runtime) loaded by the server. */
  hex: boolean;
}

export type ServerPhase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed';

export interface ServerState {
  phase: ServerPhase;
  modelId?: string;
  baseUrl?: string; // e.g. http://127.0.0.1:8080/v1
  /** The model id to put in requests (the folder path for mlx_lm.server, the server's own id otherwise). */
  servedModel?: string;
  pid?: number;
  startedAt?: number;
  /** Plain-English reason when phase is "crashed", e.g. Metal out of memory. */
  error?: string;
  hint?: string;
  /** The exact command line, shown in the panel so it can be copied into a terminal. */
  command?: string;
}

export interface WiredLimit {
  supported: boolean; // false off Apple silicon
  currentMb?: number; // 0 means the macOS default
  recommendedMb?: number;
  totalMb?: number;
  ok: boolean;
}

export interface ServerSettings {
  /** mlx_lm.server executable or a python that has mlx_lm installed. Empty = auto-detect. */
  executable: string;
  host: string;
  port: number;
  trustRemoteCode: boolean;
  promptConcurrency: number;
  prefillStepSize: number;
  promptCacheSize: number;
  extraArgs: string[];
  /** Extra environment for the server, e.g. BLACKHOLE_HEX_PROMPT=matvec for the low-memory HEX path. */
  env: Record<string, string>;
  /** Point at a server you already run (llama.cpp, Ollama, LM Studio) instead of starting one. */
  externalBaseUrl: string;
}

export interface GenerationSettings {
  maxTokens: number;
  temperature: number;
  topP: number;
  /** false sends chat_template_kwargs.enable_thinking=false (Qwen3 style templates). */
  thinking: boolean;
  systemPrompt: string;
}

export interface ChatSettings {
  modelDirs: string[];
  downloadDir: string;
  server: ServerSettings;
  generation: GenerationSettings;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Assistant only: text between <think> and </think>, kept out of the next request. */
  reasoning?: string;
  stats?: ChatStats;
  stopped?: boolean;
  error?: string;
}

export interface ChatStats {
  promptTokens?: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Seconds from send to first streamed token (prefill + queue). */
  ttftS: number;
  /** completion tokens / seconds spent generating after the first token. */
  genTokS: number;
  /** prompt tokens / ttft, only when the server reports prompt_tokens. */
  prefillTokS?: number;
  totalS: number;
  /** "usage" when token counts came from the server, "chunks" when counted from stream chunks. */
  counted: 'usage' | 'chunks';
}

export interface DownloadRequest {
  repo: string; // e.g. mlx-community/Qwen3-8B-4bit
  revision?: string;
  /** "copilot" when the copilot's request_action asked for it; shown on the confirm dialog. */
  requestedBy?: 'user' | 'copilot';
  why?: string;
}

export interface DownloadProgress {
  repo: string;
  file: string;
  doneBytes: number;
  totalBytes: number;
  phase: 'listing' | 'waiting-confirm' | 'downloading' | 'verifying' | 'done' | 'cancelled' | 'error';
  error?: string;
  /** false only when the confirm gate was shown and the user declined (the copilot reads this). */
  approved?: boolean;
}

/** Events pushed from main to the renderer on CHAT_EVENT. */
export type ChatEvent =
  | { type: 'server'; state: ServerState }
  | { type: 'server-log'; line: string }
  | { type: 'models'; models: LocalModel[] }
  | { type: 'download'; progress: DownloadProgress }
  | { type: 'delta'; turn: number; text?: string; reasoning?: string }
  | { type: 'turn-end'; turn: number; message: ChatMessage };

/** Every IPC channel the chat feature uses, so the shell can audit them in one place. */
export const CHANNELS = {
  event: 'chat:event',
  listModels: 'chat:models.list',
  rescan: 'chat:models.rescan',
  download: 'chat:download',
  cancelDownload: 'chat:models.cancelDownload',
  start: 'chat:server.start',
  stop: 'chat:server.stop',
  state: 'chat:server.state',
  logs: 'chat:server.logs',
  wired: 'chat:wired.get',
  setWired: 'chat:wired.set',
  send: 'chat:send',
  abort: 'chat:abort',
  history: 'chat:history',
  clear: 'chat:clear',
  getSettings: 'chat:settings.get',
  setSettings: 'chat:settings.set',
} as const;

/** What the preload bridge exposes as window.bh.chat. */
export interface ChatApi {
  listModels(): Promise<LocalModel[]>;
  rescan(): Promise<LocalModel[]>;
  download(req: DownloadRequest): Promise<DownloadProgress>;
  cancelDownload(repo: string): Promise<void>;
  start(modelId: string): Promise<ServerState>;
  stop(): Promise<ServerState>;
  state(): Promise<ServerState>;
  logs(): Promise<string[]>;
  wired(modelId?: string): Promise<WiredLimit>;
  setWired(mb: number): Promise<WiredLimit>;
  send(text: string): Promise<ChatMessage>;
  abort(): Promise<void>;
  history(): Promise<ChatMessage[]>;
  clear(): Promise<void>;
  getSettings(): Promise<ChatSettings>;
  setSettings(patch: DeepPartial<ChatSettings>): Promise<ChatSettings>;
  onEvent(cb: (e: ChatEvent) => void): () => void;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export const DEFAULT_SETTINGS = (home: string): ChatSettings => ({
  modelDirs: [`${home}/flint`, `${home}/keep`, `${home}/.blackhole/models`, `${home}/BlackHole/models`],
  downloadDir: `${home}/.blackhole/models`,
  server: {
    executable: '',
    host: '127.0.0.1',
    port: 8080,
    trustRemoteCode: true,
    // Measured on a 16 GB MacBook Air M5: one prompt at a time, 512-token prefill steps and a
    // two-entry prompt cache keep a 9.8 GB model inside the 12 GB wired limit.
    promptConcurrency: 1,
    prefillStepSize: 512,
    promptCacheSize: 2,
    extraArgs: [],
    env: {},
    externalBaseUrl: '',
  },
  generation: {
    maxTokens: 32768,
    temperature: 0.6,
    topP: 0.95,
    thinking: true,
    systemPrompt: '',
  },
});
