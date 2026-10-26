// Terminals for the TERMINAL panel. Uses node-pty when it is installed (real TTY, needed by the
// blackhole TUI over ssh -t); otherwise falls back to a plain pipe.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

export interface TermOpts {
  title: string;
  cwd?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface Proc {
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
}

type PtyModule = { spawn(file: string, args: string[], o: object): any };

let pty: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (pty !== undefined) return pty;
  try {
    pty = createRequire(__filename)("node-pty") as PtyModule;
  } catch {
    pty = null;
  }
  return pty;
}

export class Terminals {
  private procs = new Map<string, Proc>();

  constructor(private emit: (channel: string, payload: unknown) => void) {}

  get hasPty(): boolean {
    return loadPty() !== null;
  }

  create(o: TermOpts): string {
    const id = randomUUID();
    const shell = process.env.SHELL || "/bin/zsh";
    const cmd = o.cmd || shell;
    const args = o.cmd ? o.args ?? [] : ["-l"];
    const env = { ...process.env, ...o.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
    const cwd = o.cwd || homedir();
    const p = loadPty();
    if (p) {
      const t = p.spawn(cmd, args, { name: "xterm-256color", cols: o.cols ?? 100, rows: o.rows ?? 30, cwd, env });
      t.onData((d: string) => this.emit("term:data", { id, data: d }));
      t.onExit(({ exitCode }: { exitCode: number }) => this.exit(id, exitCode));
      this.procs.set(id, { write: (d) => t.write(d), resize: (c, r) => t.resize(c, r), kill: () => t.kill() });
    } else {
      const c = spawn(cmd, args, { cwd, env, stdio: "pipe" });
      const out = (d: Buffer) => this.emit("term:data", { id, data: d.toString("utf8").replace(/\n/g, "\r\n") });
      c.stdout.on("data", out);
      c.stderr.on("data", out);
      c.on("exit", (code) => this.exit(id, code));
      c.on("error", (e) => {
        this.emit("term:data", { id, data: `\r\n${e.message}\r\n` });
        this.exit(id, null);
      });
      this.procs.set(id, { write: (d) => c.stdin.write(d.replace(/\r/g, "\n")), resize: () => undefined, kill: () => c.kill() });
    }
    return id;
  }

  private exit(id: string, code: number | null): void {
    this.procs.delete(id);
    this.emit("term:exit", { id, code });
  }

  write(id: string, d: string): void {
    this.procs.get(id)?.write(d);
  }

  resize(id: string, cols: number, rows: number): void {
    this.procs.get(id)?.resize(cols, rows);
  }

  dispose(id: string): void {
    this.procs.get(id)?.kill();
    this.procs.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.procs.keys()]) this.dispose(id);
  }
}
