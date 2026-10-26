// The link to a host: the system's OpenSSH and rsync, so ~/.ssh/config, ProxyJump, ssh-agent and
// keys in the macOS keychain work exactly as in the user's own terminal. One master connection per
// host (ControlMaster) makes each later command a ~50 ms round trip instead of a new handshake.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface SshTarget { target: string; port?: number; identityFile?: string }
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface Stream { close(): void }

export interface Remote {
  exec(t: SshTarget, cmd: string, o?: { input?: string | Buffer; timeoutMs?: number }): Promise<ExecResult>;
  stream(t: SshTarget, cmd: string, onData: (chunk: string) => void, onExit: (code: number | null, stderr: string) => void): Stream;
  rsync(args: string[], onLine?: (line: string) => void): Promise<ExecResult>;
  /** ssh options for this target without the host, for `rsync -e` and the terminal. */
  sshOptions(t: SshTarget): string[];
}

/** Turns ssh's own failure text into a sentence the dialog can show. */
export function explainSshError(stderr: string, code: number | null): string {
  const s = stderr.trim();
  if (/Permission denied \(publickey/i.test(s)) {
    return "the host refused the key. If the key has a passphrase, add it once with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`; otherwise check the user name and IdentityFile";
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
    return "the host's key changed since you last connected (a new VM at an old address?). Remove the old entry with `ssh-keygen -R <host>` if you expect this";
  }
  if (/Could not resolve hostname/i.test(s)) return "the host name does not resolve";
  if (/Connection timed out|Operation timed out|No route to host/i.test(s)) return "no answer from the host (is the VM running, and port 22 open?)";
  if (/Connection refused/i.test(s)) return "the host refused the connection (sshd not running, or another port)";
  if (code === 255 && s) return s.split("\n").slice(-1)[0];
  return s || `ssh exited with ${code}`;
}

export class OpenSsh implements Remote {
  private readonly controlDir: string;

  constructor(private readonly bin = { ssh: "ssh", rsync: "rsync" }, controlDir?: string) {
    // Unix socket paths are capped at 104 bytes on macOS, so not under ~/Library/Application Support
    this.controlDir = controlDir ?? join(process.platform === "darwin" ? "/tmp" : tmpdir(), `bhd-${userInfo().uid}`);
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
  }

  sshOptions(t: SshTarget): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=4",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${join(this.controlDir, "%C")}`,
      "-o", "ControlPersist=600",
      ...(t.port ? ["-p", String(t.port)] : []),
      ...(t.identityFile ? ["-i", t.identityFile, "-o", "IdentitiesOnly=yes"] : []),
    ];
  }

  exec(t: SshTarget, cmd: string, o: { input?: string | Buffer; timeoutMs?: number } = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const p = spawn(this.bin.ssh, [...this.sshOptions(t), t.target, cmd], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = o.timeoutMs ? setTimeout(() => p.kill("SIGTERM"), o.timeoutMs) : undefined;
      p.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${e.message}` });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      p.stdin.on("error", () => {});
      p.stdin.end(o.input ?? "");
    });
  }

  stream(t: SshTarget, cmd: string, onData: (chunk: string) => void, onExit: (code: number | null, stderr: string) => void): Stream {
    const p = spawn(this.bin.ssh, [...this.sshOptions(t), t.target, cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let closed = false;
    p.stdout.setEncoding("utf8").on("data", onData);
    p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    p.on("error", (e) => (stderr += e.message));
    p.on("close", (code) => {
      if (!closed) onExit(code, stderr);
    });
    return {
      close() {
        closed = true;
        p.kill("SIGTERM");
      },
    };
  }

  rsync(args: string[], onLine?: (line: string) => void): Promise<ExecResult> {
    return new Promise((resolve) => {
      const p = spawn(this.bin.rsync, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let buf = "";
      p.stdout.setEncoding("utf8").on("data", (d: string) => {
        stdout = (stdout + d).slice(-20000);
        // --progress redraws its line with \r
        buf += d;
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) onLine?.(line);
      });
      p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-8000)));
      p.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
      p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}
