import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chat } from '../../src/chat/core/llm';
import { defaultWiredMb, readWiredLimit, recommendedWiredMb, setWiredLimit, type Shell } from '../../src/chat/core/macos';
import { readMlxFolder, scanModels } from '../../src/chat/core/models';
import { buildArgs, diagnose, resolveExecutable, shellQuote, type LocalServer } from '../../src/chat/core/server';
import { ChatSession } from '../../src/chat/core/session';
import { formatStats, splitOrphanThink, StatsMeter } from '../../src/chat/shared/stats';
import { DEFAULT_SETTINGS } from '../../src/chat/shared/types';
import { fakeModel, fakeServer, mlxFolder, settings, tmp } from './helpers';

const servers: LocalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});
const make = (o?: { readyTimeoutMs?: number }) => {
  const s = fakeServer(o);
  servers.push(s);
  return s;
};

describe('stats', () => {
  it('measures first token, generation rate and prefill from usage', () => {
    let t = 0;
    const m = new StatsMeter(() => t);
    t = 500;
    m.token('reasoning');
    for (let i = 0; i < 10; i++) {
      t += 100;
      m.token('text');
    }
    m.setUsage(1000, 11);
    const r = m.result();
    expect(r.ttftS).toBe(0.5);
    expect(r.genTokS).toBeCloseTo(10);
    expect(r.prefillTokS).toBe(2000);
    expect(r.reasoningTokens).toBe(1);
    expect(r.counted).toBe('usage');
    expect(formatStats(r)).toBe('10.0 tok/s · prefill 2000 tok/s · 11 tokens · 1 thinking · first token 0.5 s');
  });
  it('moves an orphan </think> prefix into reasoning', () => {
    expect(splitOrphanThink('plan it</think>\n\nDone')).toEqual({ reasoning: 'plan it', content: 'Done' });
    expect(splitOrphanThink('plain')).toEqual({ reasoning: '', content: 'plain' });
  });
});

describe('model discovery', () => {
  it('finds MLX folders and GGUFs two levels deep and labels their source', async () => {
    const root = tmp();
    mlxFolder(path.join(root, 'flint', 'qwen3.6-blackhole-9.8GB'), { architectures: ['Qwen3_5MoeForCausalLM'], quantization: { bits: 3, mode: 'hex' } });
    mlxFolder(path.join(root, 'dl', 'mlx-community', 'Qwen3-8B-4bit'));
    mkdirSync(path.join(root, 'gg'), { recursive: true });
    writeFileSync(path.join(root, 'gg', 'm-00001-of-00002.gguf'), Buffer.alloc(10));
    writeFileSync(path.join(root, 'gg', 'm-00002-of-00002.gguf'), Buffer.alloc(30));
    writeFileSync(path.join(root, 'gg', 'mmproj-x.gguf'), Buffer.alloc(5));
    mkdirSync(path.join(root, 'empty'));
    const ms = await scanModels([path.join(root, 'flint'), path.join(root, 'dl'), path.join(root, 'gg'), path.join(root, 'missing')], path.join(root, 'dl'));
    expect(ms.map((m) => [m.name, m.source, m.format])).toEqual([
      ['qwen3.6-blackhole-9.8GB', 'pipeline', 'mlx'],
      ['Qwen3-8B-4bit', 'download', 'mlx'],
      ['m', 'other', 'gguf'],
    ]);
    const q = ms.find((m) => m.name.startsWith('qwen'))!;
    expect(q.hex).toBe(true);
    expect(q.bits).toBe(3);
    expect(q.arch).toBe('Qwen3_5MoeForCausalLM');
    expect(ms.find((m) => m.format === 'gguf')!.sizeBytes).toBe(40);
  });
  it('ignores folders without weights', async () => {
    const d = tmp();
    writeFileSync(path.join(d, 'config.json'), '{}');
    expect(await readMlxFolder(d)).toBeUndefined();
  });
});

describe('server command', () => {
  it('passes the 16 GB M5 flags by default', () => {
    const m = fakeModel();
    const args = buildArgs(m, DEFAULT_SETTINGS('/h').server, 8080);
    expect(args).toEqual(['--model', m.path, '--host', '127.0.0.1', '--port', '8080', '--trust-remote-code', '--prompt-concurrency', '1', '--prefill-step-size', '512', '--prompt-cache-size', '2']);
    expect(shellQuote(['a b', "it's", 'x/y'])).toBe(`'a b' 'it'\\''s' x/y`);
  });
  it('finds ~/mlx-venv first and runs a python with -m mlx_lm.server', async () => {
    const home = tmp();
    mkdirSync(path.join(home, 'mlx-venv/bin'), { recursive: true });
    const exe = path.join(home, 'mlx-venv/bin/mlx_lm.server');
    writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    expect(await resolveExecutable('', home, '')).toEqual({ cmd: exe, pre: [] });
    expect(await resolveExecutable('~/venv/bin/python3', home, '')).toEqual({ cmd: path.join(home, 'venv/bin/python3'), pre: ['-m', 'mlx_lm.server'] });
    expect(await resolveExecutable('', tmp(), '')).toBeUndefined();
  });
  it('diagnoses Metal OOM', () => {
    expect(diagnose(['ok', '[METAL] Command buffer execution failed: Insufficient Memory'])?.error).toMatch(/out of memory/);
  });
});

describe('LocalServer', () => {
  it('starts, reports ready with the served model, and stops', async () => {
    const s = make();
    const m = fakeModel();
    const argsFile = path.join(tmp(), 'args.json');
    const states: string[] = [];
    s.on('state', (st) => states.push(st.phase));
    const st = await s.start(m, { ...settings(), env: { FAKE_ARGS_FILE: argsFile } });
    expect(st.phase).toBe('ready');
    expect(st.servedModel).toBe(m.path);
    expect(st.pid).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toContain('--prefill-step-size');
    expect((await s.stop()).phase).toBe('stopped');
    expect(states).toEqual(['starting', 'ready', 'stopping', 'stopped']);
  });
  it('reports a crash with a plain-English diagnosis', async () => {
    const s = make();
    const st = await s.start(fakeModel(), { ...settings(), env: { FAKE_CRASH: 'nomodule' } });
    expect(st.phase).toBe('crashed');
    expect(st.error).toMatch(/mlx_lm is not installed/);
    expect(s.logs().some((l) => l.includes('ModuleNotFoundError'))).toBe(true);
  });
  it('reuses a server already serving the same model on the port, and moves to a free port otherwise', async () => {
    const a = make();
    const m = fakeModel();
    const cfg = settings();
    await a.start(m, cfg);
    const b = make();
    const reused = await b.start(m, cfg);
    expect(reused.command).toMatch(/already running/);
    const other = await b.start(fakeModel(), cfg);
    expect(other.phase).toBe('ready');
    expect(other.baseUrl).not.toBe(reused.baseUrl);
  });
  it('connects to an external server and picks its model id', async () => {
    const a = make();
    const m = fakeModel();
    const st = await a.start(m, settings());
    const b = make();
    const ext = await b.start({ ...fakeModel(), format: 'gguf' }, { ...settings(), externalBaseUrl: st.baseUrl! });
    expect(ext.phase).toBe('ready');
    expect(ext.servedModel).toBe(m.path);
  });
  it('refuses GGUF without an external server', async () => {
    const st = await make().start({ ...fakeModel(), format: 'gguf' }, settings());
    expect(st.phase).toBe('crashed');
    expect(st.hint).toMatch(/llama-server/);
  });
});

describe('chat over the fake server', () => {
  it('streams text and reasoning, counts usage, and keeps reasoning out of history', async () => {
    const s = make();
    const st = await s.start(fakeModel(), { ...settings(), env: { FAKE_BODY_FILE: path.join(tmp(), 'b.json') } });
    const deltas: string[] = [];
    const session = new ChatSession(chat, (_t, d) => deltas.push(d.text ?? `[${d.reasoning}]`));
    const g = DEFAULT_SETTINGS('/h').generation;
    const r = await session.send('hi', { baseUrl: st.baseUrl!, model: st.servedModel! }, g);
    expect(r.content).toBe('The answer is **42**.');
    expect(r.reasoning).toBe('Let me think.');
    expect(r.stats!.counted).toBe('usage');
    expect(r.stats!.promptTokens).toBe(17);
    expect(deltas.join('')).toContain('[Let]');
    await session.send('again', { baseUrl: st.baseUrl!, model: st.servedModel! }, g);
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
  it('handles a template that opens <think> in the prompt', async () => {
    const st = await make().start(fakeModel(), { ...settings(), env: { FAKE_ORPHAN: '1' } });
    const r = await new ChatSession(chat).send('hi', { baseUrl: st.baseUrl!, model: st.servedModel! }, DEFAULT_SETTINGS('/h').generation);
    expect(r.reasoning).toBe('Let me think.');
    expect(r.content).toBe('The answer is **42**.');
  });
  it('sends enable_thinking=false and the max token limit', async () => {
    const body = path.join(tmp(), 'b.json');
    const st = await make().start(fakeModel(), { ...settings(), env: { FAKE_BODY_FILE: body } });
    const g = { ...DEFAULT_SETTINGS('/h').generation, thinking: false, maxTokens: 2 };
    const r = await new ChatSession(chat).send('hi', { baseUrl: st.baseUrl!, model: st.servedModel! }, g);
    const sent = JSON.parse(readFileSync(body, 'utf8'));
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.max_tokens).toBe(2);
    expect(r.error).toMatch(/2-token limit/);
    expect(r.reasoning).toBeUndefined();
  });
  it('stops mid-reply', async () => {
    const st = await make().start(fakeModel(), { ...settings(), env: { FAKE_TOKEN_MS: '40', FAKE_REPLY: 'one two three four five six seven eight nine ten' } });
    const session = new ChatSession(chat);
    const p = session.send('hi', { baseUrl: st.baseUrl!, model: st.servedModel! }, DEFAULT_SETTINGS('/h').generation);
    setTimeout(() => session.stop(), 150);
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(session.busy).toBe(false);
  });
  it('turns a server crash mid-request into an error turn kept out of history', async () => {
    const s = make();
    const st = await s.start(fakeModel(), { ...settings(), env: { FAKE_CRASH: 'oom' } });
    const session = new ChatSession(chat);
    const r = await session.send('hi', { baseUrl: st.baseUrl!, model: st.servedModel! }, DEFAULT_SETTINGS('/h').generation);
    expect(r.error).toBeTruthy();
    await new Promise((res) => setTimeout(res, 200));
    expect(s.state.phase).toBe('crashed');
    expect(s.state.error).toMatch(/out of memory/);
    expect(session.messages.every((m) => m.error || m.role === 'assistant')).toBe(true);
  });
});

describe('wired limit', () => {
  const sh = (out: string, totalMb = 16384): Shell & { calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, platform: 'darwin', arch: 'arm64', totalMb, exec: async (c, a) => (calls.push([c, ...a]), out) };
  };
  it('fits a 9.8 GB model under the 16 GB default and flags an 11 GB one', async () => {
    expect(recommendedWiredMb(16384)).toBe(12288);
    expect(defaultWiredMb(16384)).toBe(10922);
    const w = await readWiredLimit(sh('0\n'), 9.8e9);
    expect(w).toMatchObject({ supported: true, currentMb: 0, recommendedMb: 12288, ok: true });
    expect((await readWiredLimit(sh('0\n'), 11e9)).ok).toBe(false);
    expect((await readWiredLimit(sh('12288'), 11e9)).ok).toBe(true);
  });
  it('raises it through the macOS admin prompt and validates the number', async () => {
    const s = sh('12288');
    await setWiredLimit(12288, s);
    expect(s.calls[0][0]).toBe('/usr/bin/osascript');
    expect(s.calls[0][2]).toContain('iogpu.wired_limit_mb=12288" with administrator privileges');
    await expect(setWiredLimit(99999, s)).rejects.toThrow();
  });
  it('is a no-op off Apple silicon', async () => {
    expect(await readWiredLimit({ ...sh(''), platform: 'linux' })).toEqual({ supported: false, ok: true });
  });
});
