import { StatsMeter } from '../shared/stats';
import {
  CHANNELS,
  type ChatApi,
  type ChatEvent,
  type ChatMessage,
  type ChatSettings,
  type DownloadProgress,
  type LocalModel,
  type ServerState,
  type WiredLimit,
} from '../shared/types';

/** Builds the typed chat API on top of the shell's generic invoke/on bridge. */
export function makeApi(invoke: (ch: string, ...a: any[]) => Promise<any>, on: (ch: string, cb: (p: any) => void) => () => void): ChatApi {
  return {
    listModels: () => invoke(CHANNELS.listModels),
    rescan: () => invoke(CHANNELS.rescan),
    download: (r) => invoke(CHANNELS.download, r),
    cancelDownload: (repo) => invoke(CHANNELS.cancelDownload, repo),
    start: (id) => invoke(CHANNELS.start, id),
    stop: () => invoke(CHANNELS.stop),
    state: () => invoke(CHANNELS.state),
    logs: () => invoke(CHANNELS.logs),
    wired: (modelId?: string) => invoke(CHANNELS.wired, modelId),
    setWired: (mb) => invoke(CHANNELS.setWired, mb),
    send: (t) => invoke(CHANNELS.send, t),
    abort: () => invoke(CHANNELS.abort),
    history: (modelId) => invoke(CHANNELS.history, modelId),
    clear: (modelId) => invoke(CHANNELS.clear, modelId),
    getSettings: () => invoke(CHANNELS.getSettings),
    setSettings: (p) => invoke(CHANNELS.setSettings, p),
    onEvent: (cb) => on(CHANNELS.event, cb),
  };
}

export interface Live {
  modelId: string; // whose conversation the reply belongs to
  content: string;
  reasoning: string;
  meter: StatsMeter;
}

export interface ChatState {
  models: LocalModel[];
  server: ServerState;
  /** Conversations by model id; a model is missing until its history has been loaded. */
  histories: Record<string, ChatMessage[]>;
  live?: Live; // the reply being streamed
  pending?: string; // the user message waiting for that reply (in live.modelId's conversation)
  downloads: Record<string, DownloadProgress>;
  wired?: WiredLimit;
  settings?: ChatSettings;
  logs: string[];
  error?: string;
}

type Part = 'models' | 'server' | 'messages' | 'live' | 'downloads' | 'wired' | 'settings' | 'logs' | 'error';

/** One store per window, shared by the sidebar view, every chat tab and the status item. */
export class ChatStore {
  state: ChatState = { models: [], server: { phase: 'stopped' }, histories: {}, downloads: {}, logs: [] };
  private loading = new Map<string, Promise<void>>();
  private subs = new Set<(parts: Set<Part>) => void>();
  private ready?: Promise<void>;

  constructor(readonly api: ChatApi) {
    api.onEvent((e) => this.onEvent(e));
  }

  init(): Promise<void> {
    this.ready ??= (async () => {
      const [models, server, settings, logs] = await Promise.all([this.api.listModels(), this.api.state(), this.api.getSettings(), this.api.logs()]);
      Object.assign(this.state, { models, server, settings, logs });
      this.changed('models', 'server', 'settings', 'logs');
      if (server.modelId) void this.load(server.modelId);
      void this.refreshWired();
    })();
    return this.ready;
  }

  subscribe(fn: (parts: Set<Part>) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  changed(...parts: Part[]): void {
    const s = new Set(parts);
    for (const f of this.subs) f(s);
  }

  model(id = this.state.server.modelId): LocalModel | undefined {
    return this.state.models.find((m) => m.id === id);
  }

  /** The conversation with one model; empty until loaded, and asking starts the load. */
  messages(modelId: string | undefined): ChatMessage[] {
    if (!modelId) return [];
    const m = this.state.histories[modelId];
    if (!m) void this.load(modelId);
    return m ?? [];
  }

  load(modelId: string): Promise<void> {
    const had = this.loading.get(modelId);
    if (had) return had;
    const p = this.api.history(modelId).then(
      (msgs) => {
        this.state.histories[modelId] = msgs;
        this.changed('messages');
      },
      () => void this.loading.delete(modelId), // let the next look retry
    );
    this.loading.set(modelId, p);
    return p;
  }

  private onEvent(e: ChatEvent): void {
    const st = this.state;
    switch (e.type) {
      case 'server':
        st.server = e.state;
        this.changed('server');
        if (e.state.phase === 'starting') void this.refreshWired();
        break;
      case 'server-log':
        st.logs.push(e.line);
        if (st.logs.length > 500) st.logs.splice(0, st.logs.length - 500);
        this.changed('logs');
        break;
      case 'models':
        st.models = e.models;
        this.changed('models');
        break;
      case 'download':
        st.downloads[e.progress.repo] = e.progress;
        this.changed('downloads');
        break;
      case 'delta':
        if (!st.live) st.live = { modelId: e.modelId, content: '', reasoning: '', meter: new StatsMeter() };
        if (e.text) {
          st.live.content += e.text;
          st.live.meter.token('text');
        }
        if (e.reasoning) {
          st.live.reasoning += e.reasoning;
          st.live.meter.token('reasoning');
        }
        this.changed('live');
        break;
      case 'turn-end':
        break; // send() resolves with the same message and refreshes history
    }
  }

  async refreshWired(): Promise<void> {
    try {
      this.state.wired = await this.api.wired(this.state.server.modelId ?? this.state.models[0]?.id);
      this.changed('wired');
    } catch {
      /* not on a Mac */
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      this.state.error = undefined;
      return await fn();
    } catch (e) {
      this.state.error = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      this.changed('error');
      return undefined;
    }
  }

  start(id: string) {
    return this.run(async () => {
      this.state.server = { phase: 'starting', modelId: id };
      this.changed('server');
      this.state.server = await this.api.start(id);
      this.changed('server');
      void this.refreshWired();
    });
  }

  stop() {
    return this.run(async () => {
      this.state.server = await this.api.stop();
      this.changed('server');
    });
  }

  /** Sends to the served model; its id names the conversation the turn lands in. */
  async send(text: string): Promise<void> {
    const modelId = this.state.server.modelId;
    if (this.state.live || !text.trim() || !modelId) return;
    this.state.pending = text;
    this.state.live = { modelId, content: '', reasoning: '', meter: new StatsMeter() };
    this.changed('live', 'messages');
    await this.run(() => this.api.send(text));
    this.state.histories[modelId] = await this.api.history(modelId);
    this.state.live = undefined;
    this.state.pending = undefined;
    this.changed('live', 'messages');
  }

  abort() {
    return this.api.abort();
  }

  async clear(modelId: string) {
    await this.api.clear(modelId);
    this.state.histories[modelId] = [];
    this.changed('messages');
  }

  async saveSettings(patch: Parameters<ChatApi['setSettings']>[0]) {
    const s = await this.run(() => this.api.setSettings(patch));
    if (s) {
      this.state.settings = s;
      this.changed('settings');
    }
  }
}
