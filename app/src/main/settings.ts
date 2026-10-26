import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class Settings {
  private data: Record<string, unknown>;

  constructor(private file: string) {
    this.data = existsSync(file) ? safeParse(readFileSync(file, "utf8")) : {};
  }

  get<T>(key: string, fallback: T): T {
    return (key in this.data ? (this.data[key] as T) : fallback);
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  all(): Record<string, unknown> {
    return { ...this.data };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
