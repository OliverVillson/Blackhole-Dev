// Secrets (API keys, passphrases), encrypted with Electron safeStorage, whose key lives in the
// macOS Keychain. Values are readable only in the main process.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class Secrets {
  constructor(private file: string, private cipher: Cipher) {}

  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private save(all: Record<string, string>): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private check(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`bad secret name: ${name}`);
  }

  async get(name: string): Promise<string | null> {
    this.check(name);
    const v = this.load()[name];
    if (!v) return null;
    return this.cipher.decryptString(Buffer.from(v, "base64"));
  }

  async set(name: string, value: string): Promise<void> {
    this.check(name);
    if (!this.cipher.isEncryptionAvailable()) throw new Error("Keychain encryption is not available");
    const all = this.load();
    all[name] = this.cipher.encryptString(value).toString("base64");
    this.save(all);
  }

  async delete(name: string): Promise<void> {
    this.check(name);
    const all = this.load();
    delete all[name];
    this.save(all);
  }

  available(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  async has(name: string): Promise<boolean> {
    this.check(name);
    return Boolean(this.load()[name]);
  }
}
