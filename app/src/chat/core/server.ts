import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { LocalModel, ServerSettings, ServerState } from '../shared/types';

const LOG_LINES = 500;

/** Known failure lines from mlx_lm.server and what to tell the user. */
const DIAGNOSES: { re: RegExp; error: string; hint: string }[] = [
  {
    re: /Insufficient Memory|OutOfMemory|out of memory|kIOGPUCommandBufferCallbackError/i,
    error: 'The GPU ran out of memory (Metal).',
    hint: 'Raise the GPU wired limit, close other large apps, or set BLACKHOLE_HEX_PROMPT=matvec in the server environment for the low-memory HEX prompt path.',
  },
  {
    re: /No module named ['"]?mlx_lm/i,
    error: 'mlx_lm is not installed for this Python.',
    hint: 'Run `python3 -m pip install mlx-lm` in the venv you use (e.g. ~/mlx-venv), or set the server executable in Chat settings.',
  },
  {
    re: /Address already in use|EADDRINUSE/i,
    error: 'The port is already taken.',
    hint: 'Another server is using this port. Stop it or pick another port in Chat settings.',
  },
  {
    re: /trust_remote_code|trust-remote-code/i,
    error: 'The model needs custom code.',
    hint: 'Turn on "Trust remote code" in Chat settings for models built with custom architectures.',
  },
];

export function diagnose(lines: string[]): { error: string; hint: string } | undefined {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 80); i--) {
    const d = DIAGNOSES.find((x) => x.re.test(lines[i]));
    if (d) return { error: d.error, hint: d.hint };
  }
  return undefined;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executable to start: setting, then ~/mlx-venv, then PATH. A python runs `-m mlx_lm.server`. */
export async function resolveExecutable(setting: string, home = os.homedir(), envPath = process.env.PATH ?? ''): Promise<{ cmd: string; pre: string[] } | undefined> {
  const asCmd = (p: string) => (/python[\d.]*$/.test(path.basename(p)) ? { cmd: p, pre: ['-m', 'mlx_lm.server'] } : { cmd: p, pre: [] });
  if (setting) return asCmd(setting.replace(/^~(?=\/)/, home));
  const candidates = [
    path.join(home, 'mlx-venv/bin/mlx_lm.server'),
    ...envPath.split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'mlx_lm.server')),
    path.join(home, 'mlx-venv/bin/python'),
  ];
  for (const c of candidates) if (await isExecutable(c)) return asCmd(c);
  return undefined;
}

export function buildArgs(model: LocalModel, s: ServerSettings, port: number): string[] {
  const args = ['--model', model.path, '--host', s.host, '--port', String(port)];
  if (s.trustRemoteCode) args.push('--trust-remote-code');
  if (s.promptConcurrency > 0) args.push('--prompt-concurrency', String(s.promptConcurrency));
  if (s.prefillStepSize > 0) args.push('--prefill-step-size', String(s.prefillStepSize));
  if (s.promptCacheSize > 0) args.push('--prompt-cache-size', String(s.promptCacheSize));
  return [...args, ...s.extraArgs];
}

export function shellQuote(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** GET /v1/models; returns the model ids or undefined when nothing answers. */
export async function probe(baseUrl: string, timeoutMs = 1500): Promise<string[] | undefined> {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    return Array.isArray(j?.data) ? j.data.map((m: any) => String(m.id)) : [];
  } catch {
    return undefined;
  }
}

export interface ServerOptions {
  readyTimeoutMs?: number;
  pollMs?: number;
  resolve?: typeof resolveExecutable;
}

/**
 * Owns one local mlx_lm.server process. Emits "state" (ServerState) and "log" (line).
 * Only one model is served at a time: starting another model stops the current one first.
 */
export class LocalServer extends EventEmitter {
  private child?: ChildProcess;
  private _state: ServerState = { phase: 'stopped' };
  private lines: string[] = [];
  private gen = 0;

  constructor(private opts: ServerOptions = {}) {
    super();
  }

  get state(): ServerState {
    return this._state;
  }

  logs(): string[] {
    return [...this.lines];
  }

  private set(s: ServerState): void {
    this._state = s;
    this.emit('state', s);
  }

  private log(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    this.emit('log', line);
  }

  async start(model: LocalModel, s: ServerSettings): Promise<ServerState> {
    if (s.externalBaseUrl) {
      const base = s.externalBaseUrl.replace(/\/$/, '');
      const ids = await probe(base);
      if (!ids) return this.fail(model, `Nothing answers at ${base}.`, 'Start your server first, or clear "External server" in Chat settings.');
      // Ollama and llama.cpp name models their own way: use a matching id, else the first one served.
      const servedModel = ids.find((id) => id === model.name || id.includes(model.name)) ?? ids[0] ?? model.name;
      this.set({ phase: 'ready', modelId: model.id, baseUrl: base, servedModel, startedAt: Date.now(), command: `external server at ${base}` });
      return this._state;
    }
    if (model.format !== 'mlx')
      return this.fail(model, 'GGUF models need a llama.cpp or Ollama server.', 'Start llama-server with this file and set "External server" in Chat settings to its /v1 URL.');
    if (this.child || this._state.phase === 'ready') await this.stop();

    const gen = ++this.gen;
    let port = s.port;
    const base = (p: number) => `http://${s.host}:${p}/v1`;
    // A server the user already started on this port (e.g. for opencode) with this model is reused.
    const ids = await probe(base(port), 800);
    const running = ids?.find((id) => id === model.path || path.resolve(id.replace(/^~(?=\/)/, os.homedir())) === model.path);
    if (running) {
      this.set({ phase: 'ready', modelId: model.id, baseUrl: base(port), servedModel: running, startedAt: Date.now(), command: `already running on port ${port}` });
      return this._state;
    }
    for (let tries = 0; tries < 20 && !(await portFree(s.host, port)); tries++) port++;

    const exe = await (this.opts.resolve ?? resolveExecutable)(s.executable);
    if (!exe)
      return this.fail(model, 'mlx_lm.server was not found.', 'Install it with `python3 -m pip install mlx-lm` (e.g. in ~/mlx-venv) or set the executable in Chat settings.');

    const args = [...exe.pre, ...buildArgs(model, s, port)];
    const command = shellQuote([exe.cmd, ...args]);
    this.lines = [];
    this.log(`$ ${command}`);
    // mlx_lm.server accepts the path it was started with as the request's model id.
    this.set({ phase: 'starting', modelId: model.id, baseUrl: base(port), servedModel: model.path, startedAt: Date.now(), command });

    const child = spawn(exe.cmd, args, { env: { ...process.env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const onData = (buf: Buffer) => {
      for (const l of buf.toString('utf8').split(/\r?\n/)) if (l.trim()) this.log(l);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (e) => {
        this.log(`spawn failed: ${e.message}`);
        resolve(-1);
      });
      child.once('exit', (code, sig) => {
        if (this.child === child) this.child = undefined;
        this.log(`server exited (${sig ?? code})`);
        resolve(code ?? -1);
        if (gen !== this.gen) return;
        if (this._state.phase === 'stopping') this.set({ phase: 'stopped' });
        else if (this._state.phase !== 'stopped') {
          const d = diagnose(this.lines);
          this.set({ ...this._state, phase: 'crashed', pid: undefined, error: d?.error ?? `The server stopped (exit ${sig ?? code}).`, hint: d?.hint ?? 'Open the server log for details.' });
        }
      });
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 10 * 60_000);
    let ready = false;
    while (Date.now() < deadline && this.child === child) {
      const done = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), this.opts.pollMs ?? 500))]);
      if (done) break;
      if (await probe(base(port), 1000)) {
        ready = true;
        break;
      }
    }
    if (gen !== this.gen) return this._state;
    if (ready) this.set({ ...this._state, phase: 'ready', pid: child.pid });
    else if (this.child === child) {
      await this.stop();
      this.set({ ...this._state, phase: 'crashed', error: 'The server did not answer in time.', hint: 'Large models can take minutes to load from disk; close other apps and try again.' });
    }
    return this._state;
  }

  async stop(): Promise<ServerState> {
    const child = this.child;
    if (!child) {
      if (this._state.phase !== 'stopped') this.set({ phase: 'stopped' });
      return this._state;
    }
    this.set({ ...this._state, phase: 'stopping' });
    const gone = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    await gone;
    clearTimeout(t);
    this.child = undefined;
    if (this._state.phase !== 'stopped') this.set({ phase: 'stopped' });
    return this._state;
  }

  private fail(model: LocalModel, error: string, hint: string): ServerState {
    this.set({ phase: 'crashed', modelId: model.id, error, hint });
    return this._state;
  }
}
