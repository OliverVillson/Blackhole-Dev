// I1 client: owns the Python helper process (`python -m blackhole_dev.rpc`), speaks
// JSON-RPC 2.0 with one JSON object per line on stdio, restarts it on crash.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { HelperStatus, InitializeParams, InitializeResult } from "../shared/rpc";
import { RPC_ERRORS } from "../shared/rpc";

export interface HelperOptions {
  python: () => string;
  args?: string[];
  cwd: string;
  init: InitializeParams;
  /** Extra environment; a function is read at every (re)start, so a new token takes effect on restart. */
  env?: Record<string, string> | (() => Record<string, string>);
  timeoutMs?: number;
  backoffMs?: number[];
  spawnFn?: typeof spawn;
}

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer?: NodeJS.Timeout;
}

export class HelperClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private ready: Promise<void> | null = null;
  private crashes = 0;
  private stopping = false;
  private _status: HelperStatus = { state: "down" };

  constructor(private opts: HelperOptions) {
    super();
  }

  status(): HelperStatus {
    return this._status;
  }

  private setStatus(s: HelperStatus): void {
    this._status = s;
    this.emit("status", s);
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.stopping = false;
    this.ready = this.boot();
    return this.ready;
  }

  private boot(): Promise<void> {
    const python = this.opts.python();
    const args = this.opts.args ?? ["-m", "blackhole_dev.rpc"];
    this.setStatus({ state: "starting" });
    const proc = (this.opts.spawnFn ?? spawn)(python, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(typeof this.opts.env === "function" ? this.opts.env() : this.opts.env), PYTHONUNBUFFERED: "1", BLACKHOLE_DEV_RPC: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    this.buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => this.onData(d));
    proc.stderr.on("data", (d: string) => this.emit("stderr", d));
    const exited = new Promise<never>((_, reject) => {
      proc.on("error", (e) => reject(e));
      proc.on("exit", (code, signal) => reject(new Error(`helper exited (${code ?? signal})`)));
    });
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal));
    proc.on("error", (e) => this.onExit(proc, null, null, e));
    const init = this.request<InitializeResult>("initialize", this.opts.init, 30_000).then((r) => {
      this.crashes = 0;
      this.setStatus({ state: "ready", version: r.version, python: r.python });
      this.emit("ready", r);
    });
    return Promise.race([init, exited]);
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (proc !== this.proc) return;
    this.proc = null;
    this.ready = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(-32000, "helper stopped"));
    }
    this.pending.clear();
    if (this.stopping) {
      this.setStatus({ state: "down" });
      return;
    }
    const missing = (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    const backoff = this.opts.backoffMs ?? [1000, 2000, 4000];
    const reason = err ? err.message : `exited with ${code ?? signal}`;
    if (missing || this.crashes >= backoff.length) {
      this.setStatus({ state: missing ? "missing" : "down", error: missing ? `Python not found: ${this.opts.python()}` : reason });
      return;
    }
    const wait = backoff[this.crashes++];
    this.setStatus({ state: "starting", error: `${reason}; restarting in ${wait / 1000}s` });
    setTimeout(() => {
      if (!this.stopping && !this.proc) this.start().catch(() => undefined);
    }, wait);
  }

  /** Forget earlier crashes and start again (status-bar "retry"). */
  restart(): Promise<void> {
    this.crashes = 0;
    if (this.proc) {
      this.stopping = true;
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
    return this.start();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("stderr", `[stdout, not JSON] ${line}\n`);
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && (("result" in msg) || ("error" in msg))) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        this.emit("notify", msg.method, msg.params);
        this.emit(`notify:${msg.method}`, msg.params);
      }
    }
  }

  private write(obj: object): void {
    if (!this.proc) throw new RpcError(-32000, "helper not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request<T>(method: string, params: object | undefined, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          this.notify("$/cancel", { id });
          reject(new RpcError(RPC_ERRORS.cancelled, `${method} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(e);
      }
    });
  }

  notify(method: string, params?: object): void {
    try {
      this.write({ jsonrpc: "2.0", method, params: params ?? {} });
    } catch {
      /* helper down: notifications are best effort */
    }
  }

  async call<T = unknown>(method: string, params?: object, timeoutMs = this.opts.timeoutMs ?? 120_000): Promise<T> {
    await this.start();
    return this.request<T>(method, params, timeoutMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    const gone = new Promise<void>((r) => proc.once("exit", () => r()));
    try {
      await Promise.race([this.request("shutdown", {}, 2000), gone]);
    } catch {
      /* ignore */
    }
    proc.stdin.end();
    const t = setTimeout(() => proc.kill("SIGKILL"), 2000);
    await gone;
    clearTimeout(t);
  }
}
