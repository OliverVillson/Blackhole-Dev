// The machines list: Host entries from ~/.ssh/config, hosts added in the app, and VMs that
// `blackhole up` made (their records in $BLACKHOLE_HOME/machines/*.json). Per-host settings the
// user sets in the app (hourly rate, venv) are kept apart, so an ssh config edit never loses them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "./shared";

export interface SshConfigHost { alias: string; hostName?: string; user?: string; port?: number; identityFile?: string }

/** Concrete Host blocks of an OpenSSH config (patterns with * ? ! are skipped; Include is followed one level). */
export function parseSshConfig(text: string, readInclude?: (pattern: string) => string[]): SshConfigHost[] {
  const out: SshConfigHost[] = [];
  let cur: SshConfigHost[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "include" && readInclude) {
      for (const t of readInclude(val)) out.push(...parseSshConfig(t));
      continue;
    }
    if (key === "host") {
      cur = val.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias }));
      out.push(...cur);
      continue;
    }
    if (key === "match") {
      cur = [];
      continue;
    }
    for (const h of cur) {
      // first value wins, as in ssh
      if (key === "hostname") h.hostName ??= val;
      else if (key === "user") h.user ??= val;
      else if (key === "port") h.port ??= Number(val) || undefined;
      else if (key === "identityfile") h.identityFile ??= val;
    }
  }
  return out;
}

export function sshConfigHosts(home = homedir()): Host[] {
  const path = join(home, ".ssh", "config");
  if (!existsSync(path)) return [];
  const include = (pattern: string): string[] => {
    const p = pattern.replace(/^~/, home);
    const full = p.startsWith("/") ? p : join(home, ".ssh", p);
    const dir = full.replace(/\/[^/]*$/, "");
    const glob = new RegExp("^" + full.slice(dir.length + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    try {
      return readdirSync(dir).filter((f) => glob.test(f)).map((f) => readFileSync(join(dir, f), "utf8"));
    } catch {
      return [];
    }
  };
  return parseSshConfig(readFileSync(path, "utf8"), include).map((h) => ({
    id: `ssh:${h.alias}`,
    label: h.alias,
    kind: "ssh",
    target: h.alias,          // ssh reads the rest of the block itself
    source: "ssh-config",
  }));
}

/** A `blackhole.cloud.Machine` record. */
interface MachineRecord {
  name: string; provider: string; gpu: string; size: string; region: string; login: string;
  created: number; address: string | null; id: string | null; state: "creating" | "running" | "stopped";
  usd_per_hour: number | null;
}

export function blackholeHome(env = process.env, home = homedir()): string {
  return env.BLACKHOLE_HOME || join(home, ".blackhole");
}

export function machineHosts(env = process.env, home = homedir()): Host[] {
  const dir = join(blackholeHome(env, home), "machines");
  if (!existsSync(dir)) return [];
  const key = (env.BLACKHOLE_SSH_KEY || "~/.ssh/id_ed25519").replace(/^~/, home);
  const out: Host[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as MachineRecord;
      out.push({
        id: `vm:${m.name}`,
        label: m.name,
        kind: "vm",
        target: m.address ? `${m.login}@${m.address}` : "",
        identityFile: existsSync(key) ? key : undefined,
        source: "blackhole-up",
        ratePerHour: m.usd_per_hour ?? undefined,
        currency: "$",
        gpu: m.gpu,
        provider: m.provider,
        state: m.state,
      });
    } catch {
      /* a record being written right now */
    }
  }
  return out;
}

export interface HostPrefs { ratePerHour?: number; currency?: string; venv?: string; label?: string; gpu?: string }

export interface HostSettings {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** user@host[:port] as typed in "Add SSH host". */
export function parseTarget(s: string): { target: string; port?: number } | null {
  const m = /^\s*(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?\s*$/.exec(s);
  if (!m) return null;
  return { target: m[1] ? `${m[1]}@${m[2]}` : m[2], port: m[3] ? Number(m[3]) : undefined };
}

export class HostStore {
  constructor(
    private readonly settings: HostSettings,
    private readonly sources = { ssh: () => sshConfigHosts(), vms: () => machineHosts() },
  ) {}

  private added(): Host[] {
    return this.settings.get<Host[]>("vm.hosts", []);
  }

  private prefs(): Record<string, HostPrefs> {
    return this.settings.get<Record<string, HostPrefs>>("vm.hostPrefs", {});
  }

  list(): Host[] {
    const prefs = this.prefs();
    const seen = new Set<string>();
    const all = [...this.sources.vms(), ...this.added(), ...this.sources.ssh()];
    return all
      .filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)))
      .map((h) => {
        const p = prefs[h.id] ?? {};
        return {
          ...h,
          label: p.label ?? h.label,
          venv: p.venv ?? h.venv,
          gpu: h.gpu ?? p.gpu,
          // a VM's provider price is a fact; the user's rate fills in for any other host
          ratePerHour: h.ratePerHour ?? p.ratePerHour,
          currency: h.currency ?? p.currency ?? (p.ratePerHour != null ? "$" : undefined),
        };
      });
  }

  get(id: string): Host {
    const h = this.list().find((x) => x.id === id);
    if (!h) throw new Error(`no machine ${id}`);
    return h;
  }

  add(spec: string, label?: string, identityFile?: string): Host {
    const t = parseTarget(spec);
    if (!t) throw new Error(`"${spec}" is not user@host or user@host:port`);
    const h: Host = {
      id: `app:${t.target}${t.port ? ":" + t.port : ""}`,
      label: label || t.target,
      kind: "ssh",
      target: t.target,
      port: t.port,
      identityFile: identityFile || undefined,
      source: "app",
    };
    this.settings.set("vm.hosts", [...this.added().filter((x) => x.id !== h.id), h]);
    return h;
  }

  update(id: string, p: HostPrefs): void {
    const all = this.prefs();
    all[id] = { ...all[id], ...p };
    this.settings.set("vm.hostPrefs", all);
  }

  /** Only app-added hosts can be removed here; ssh config entries are the user's file, VMs go with `blackhole down`. */
  remove(id: string): void {
    this.settings.set("vm.hosts", this.added().filter((x) => x.id !== id));
  }
}
