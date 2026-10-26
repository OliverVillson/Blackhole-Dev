// WS6 local chat, main process side. The shell calls activate(ctx) at startup (src/modules.ts).
import os from 'node:os';
import { downloadRepo } from './core/download';
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
  const session = new ChatSession(deps.chat ?? defaultChat, (turn, d) => emit({ type: 'delta', turn, ...d }));

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
    session.stop();
    return server.start(find(id), settings.server);
  });
  ctx.handle(CHANNELS.stop, () => {
    session.stop();
    return server.stop();
  });
  ctx.handle(CHANNELS.state, () => server.state);
  ctx.handle(CHANNELS.logs, () => server.logs());

  ctx.handle(CHANNELS.wired, (modelId?: string) => readWiredLimit(shell, modelId ? models.find((m) => m.id === modelId)?.sizeBytes : 0));
  ctx.handle(CHANNELS.setWired, (mb: number) => setWiredLimit(mb, shell));

  ctx.handle(CHANNELS.send, async (text: string) => {
    const st = server.state;
    if (st.phase !== 'ready' || !st.baseUrl || !st.servedModel) throw new Error('start a model first');
    const msg = await session.send(text, { baseUrl: st.baseUrl, model: st.servedModel }, settings.generation);
    emit({ type: 'turn-end', turn: session.messages.length, message: msg });
    return msg;
  });
  ctx.handle(CHANNELS.abort, () => session.stop());
  ctx.handle(CHANNELS.history, () => session.messages);
  ctx.handle(CHANNELS.clear, () => session.clear());

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
      session.stop();
      await server.stop();
    },
  };
}
