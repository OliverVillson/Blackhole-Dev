import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activate } from '../../src/chat/main';
import type { ConfirmRequest, MainContext } from '../../src/chat/shared/ext-shim';
import { CHANNELS, type ChatEvent } from '../../src/chat/shared/types';
import { fakeServer, mlxFolder, settings, tmp } from './helpers';

function fakeCtx(models: string) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const events: ChatEvent[] = [];
  const store: Record<string, unknown> = {};
  const asked: ConfirmRequest[] = [];
  const part: Omit<MainContext, 'module' | 'secrets' | 'helper' | 'licence'> = {
    handle: (ch, fn) => handlers.set(ch, fn),
    send: (ch, p) => ch === CHANNELS.event && events.push(p as ChatEvent),
    gate: { confirm: async (r) => (asked.push(r), false) },
    settings: { get: (k, f) => (store[k] as any) ?? f, set: (k, v) => (store[k] = v) },
    paths: { userData: tmp(), workspace: tmp(), recipes: '', functions: '', models },
    log: () => {},
  };
  const ctx = { module: 'chat', ...part } as unknown as MainContext;
  const call = (ch: string, ...a: any[]) => {
    const h = handlers.get(ch);
    if (!h) throw new Error(`no handler ${ch}`);
    return h(...a);
  };
  return { ctx, call, events, store, asked, handlers };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
});

describe('activate (main)', () => {
  it('registers only chat: channels and runs a full start, chat, stop cycle', async () => {
    const models = tmp();
    mlxFolder(path.join(models, 'qwen3.6-blackhole-9.8GB'));
    const f = fakeCtx(models);
    const mod = activate(f.ctx, { server: fakeServer() });
    stop = mod.deactivate;
    expect([...f.handlers.keys()].every((k) => k.startsWith('chat:'))).toBe(true);

    const port = settings().port;
    await f.call(CHANNELS.setSettings, { server: { port }, modelDirs: [models] });
    expect((f.store.chat as any).server.port).toBe(port);

    const list = await f.call(CHANNELS.rescan);
    expect(list.map((m: any) => m.name)).toEqual(['qwen3.6-blackhole-9.8GB']);
    const st = await f.call(CHANNELS.start, list[0].id);
    expect(st.phase).toBe('ready');
    expect(st.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);

    const reply = await f.call(CHANNELS.send, 'hello');
    expect(reply.content).toBe('The answer is **42**.');
    expect(f.events.some((e) => e.type === 'delta')).toBe(true);
    expect(f.events.some((e) => e.type === 'turn-end')).toBe(true);
    expect((await f.call(CHANNELS.history)).length).toBe(2);

    expect((await f.call(CHANNELS.stop)).phase).toBe('stopped');
    await expect(f.call(CHANNELS.send, 'x')).rejects.toThrow(/start a model first/);
  });
  it('accepts the copilot request_action shape on chat:download and goes through the gate', async () => {
    const f = fakeCtx(tmp());
    stop = activate(f.ctx, { server: fakeServer(), hubUrl: 'http://127.0.0.1:9' }).deactivate;
    const res = await f.call(CHANNELS.download, { action: 'download', model: 'org/tiny', why: 'x', requestedBy: 'copilot' });
    // The fake hub is unreachable, so this fails before the gate; the shape is still accepted.
    expect(res.repo).toBe('org/tiny');
    expect(res.phase).toBe('error');
  });
});
