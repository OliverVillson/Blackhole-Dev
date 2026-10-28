// The main window's only bridge. Renderer code (shell and modules) reaches main through
// registered channels; it never gets ipcRenderer itself.
import { contextBridge, ipcRenderer } from "electron";

type Cb = (payload: unknown) => void;
const listeners = new Map<string, Set<Cb>>();

ipcRenderer.on("bh:event", (_e, channel: string, payload: unknown) => {
  for (const cb of listeners.get(channel) ?? []) {
    try {
      cb(payload);
    } catch (err) {
      console.error(err);
    }
  }
});

contextBridge.exposeInMainWorld("bh", {
  // Electron wraps a handler's error as "Error invoking remote method 'bh:invoke': Error: <msg>";
  // every panel shows only <msg>.
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke("bh:invoke", channel, ...args).catch((e: unknown) => {
      const msg = String((e as Error)?.message ?? e).replace(/^(?:Error: )?Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error: )+/, "");
      throw new Error(msg || "failed with no message");
    }),
  on: (channel: string, cb: Cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(cb);
    return () => listeners.get(channel)?.delete(cb);
  },
  platform: process.platform,
});
