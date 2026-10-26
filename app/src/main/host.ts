// Routes window.bh.invoke(channel, ...) to handlers registered by the shell and by modules, and
// builds the MainContext each module gets.

import type { MainContext } from "../shared/ext";
import { CHANNEL_RE } from "../shared/ext";

export type Handler = (...args: any[]) => unknown;

export class Host {
  private handlers = new Map<string, { module: string; fn: Handler }>();

  register(module: string, channel: string, fn: Handler): void {
    if (!CHANNEL_RE.test(channel)) throw new Error(`bad channel name: ${channel}`);
    if (!channel.startsWith(module + ":")) throw new Error(`module ${module} may only register ${module}:* channels (got ${channel})`);
    if (this.handlers.has(channel)) throw new Error(`channel already registered: ${channel}`);
    this.handlers.set(channel, { module, fn });
  }

  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h.fn(...args);
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  contextFor(module: string, base: Omit<MainContext, "module" | "handle">): MainContext {
    if (!/^[a-z][a-z0-9-]*$/.test(module)) throw new Error(`bad module id: ${module}`);
    return { ...base, module, handle: (channel, fn) => this.register(module, channel, fn) };
  }
}
