// WS6 local chat, main process side. The shell calls activate(ctx) at startup (src/modules.ts).
import os from 'node:os';
import path from 'node:path';
import { downloadRepo } from './core/download';
import { HistoryFiles } from './core/history';
import { chat as defaultChat, type ChatFn } from './core/llm';
import { readWiredLimit, realShell, setWiredLimit, type Shell } from './core/macos';
import { scanModels } from './core/models';
import { LocalServer } from './core/server';
import { ChatSession } from './core/session';
import type { MainContext } from './shared/ext-shim';
import { CHANNELS, DEFAULT_SETTINGS, type ChatEvent, type ChatSettings, type DeepPartial, type DownloadRequest, type LocalModel } from './shared/types';

const SETTINGS_KEY = 'chat';

export interface ChatDeps {
  chat?: ChatFn; // I5 from src/llm once WS4 lands
  shell?: Shell;
  hubUrl?: string;
  server?: LocalServer;
}

function merge<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge((base as any)?.[k] ?? {}, v) : v;
  return out;
}

export function activate(ctx: MainContext, deps: ChatDeps = {}) {
  const home = os.homedir();
  const defaults = DEFAULT_SETTINGS(home);
  if (ctx.paths.models && !defaults.modelDirs.includes(ctx.paths.models)) defaults.modelDirs.unshift(ctx.paths.models);
  let settings: ChatSettings = merge(defaults, ctx.settings.get<DeepPartial<ChatSettings>>(SETTINGS_KEY, {}));
  const shell = deps.shell ?? realShell;
  const server = deps.server ?? new LocalServer();
  let models: LocalModel[] = [];
  const downloads = new Map<string, AbortController>();

  const emit = (e: ChatEvent) => ctx.send(CHANNELS.event, e);
  server.on('state', (state) => emit({ type: 'server', state }));
  server.on('log', (line) => emit({ type: 'server-log', line }));
  // Each model has its own conversation, loaded from disk the first time it is asked for.
  const files = new HistoryFiles(path.join(ctx.paths.userData, 'chat-history'));
  const sessions = new Map<string, ChatSession>();
  const sessionFor = (modelId: string) => {
    let s = sessions.get(modelId);
    if (!s) {
      s = new ChatSession(deps.chat ?? defaultChat, (turn, d) => emit({ type: 'delta', modelId, turn, ...d }), files.load(modelId));
      sessions.set(modelId, s);
    }
    return s;
  };
  const stopAll = () => sessions.forEach((s) => s.stop());

  const rescan = async () => {
    models = await scanModels([...new Set([...settings.modelDirs, settings.downloadDir])], settings.downloadDir);
    emit({ type: 'models', models });
    return models;
  };
  const find = (id: string) => {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`model ${id} is not in the list; rescan first`);
    return m;
  };

  ctx.handle(CHANNELS.listModels, () => (models.length ? models : rescan()));
  ctx.handle(CHANNELS.rescan, rescan);

  // Also the target of the copilot's request_action "download": { action, why, model, requestedBy }.
  ctx.handle(CHANNELS.download, async (raw: DownloadRequest & { model?: string }) => {
    const req: DownloadRequest = { repo: raw.repo ?? raw.model ?? '', revision: raw.revision, requestedBy: raw.requestedBy, why: raw.why };
    if (downloads.has(req.repo)) throw new Error(`${req.repo} is already downloading`);
    const ac = new AbortController();
    downloads.set(req.repo, ac);
    let last = 0;
    try {
      const res = await downloadRepo(
        req,
        settings.downloadDir,
        {
          // Main calls the gate itself, so a renderer that skips the dialog still hits it.
          confirm: (r) => ctx.gate.confirm(r),
          progress: (p) => {
            const now = Date.now();
            if (p.phase === 'downloading' && now - last < 200) return;
            last = now;
            emit({ type: 'download', progress: p });
          },
          hubUrl: deps.hubUrl,
        },
        ac.signal,
      );
      emit({ type: 'download', progress: res });
      if (res.phase === 'done') await rescan();
      return res;
    } finally {
      downloads.delete(req.repo);
    }
  });
  ctx.handle(CHANNELS.cancelDownload, (repo: string) => downloads.get(repo)?.abort());

  ctx.handle(CHANNELS.start, async (id: string) => {
    if (!models.length) await rescan();
    stopAll();
    return server.start(find(id), settings.server);
  });
  ctx.handle(CHANNELS.stop, () => {
    stopAll();
    return server.stop();
  });
  ctx.handle(CHANNELS.state, () => server.state);
  ctx.handle(CHANNELS.logs, () => server.logs());

  ctx.handle(CHANNELS.wired, (modelId?: string) => readWiredLimit(shell, modelId ? models.find((m) => m.id === modelId)?.sizeBytes : 0));
  ctx.handle(CHANNELS.setWired, (mb: number) => setWiredLimit(mb, shell));

  ctx.handle(CHANNELS.send, async (text: string) => {
    const st = server.state;
    if (st.phase !== 'ready' || !st.baseUrl || !st.servedModel || !st.modelId) throw new Error('start a model first');
    const modelId = st.modelId;
    const session = sessionFor(modelId);
    try {
      const msg = await session.send(text, { baseUrl: st.baseUrl, model: st.servedModel }, settings.generation);
      emit({ type: 'turn-end', modelId, turn: session.messages.length, message: msg });
      return msg;
    } finally {
      persist(modelId);
    }
  });
  const persist = (modelId: string) => {
    try {
      files.save(modelId, sessionFor(modelId).messages);
    } catch (e) {
      ctx.log(`chat: could not save the history for ${modelId}: ${(e as Error).message}`);
    }
  };
  ctx.handle(CHANNELS.abort, () => stopAll());
  ctx.handle(CHANNELS.history, (modelId: string) => (modelId ? sessionFor(modelId).messages : []));
  ctx.handle(CHANNELS.clear, (modelId: string) => {
    if (!modelId) return;
    sessionFor(modelId).clear();
    persist(modelId);
  });

  ctx.handle(CHANNELS.getSettings, () => settings);
  ctx.handle(CHANNELS.setSettings, (patch: DeepPartial<ChatSettings>) => {
    settings = merge(settings, patch);
    ctx.settings.set(SETTINGS_KEY, settings);
    return settings;
  });

  return {
    /** The shell calls this on quit so the model server never outlives the app. */
    async deactivate() {
      for (const ac of downloads.values()) ac.abort();
      stopAll();
      await server.stop();
    },
  };
}
