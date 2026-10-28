// The main window's only bridge. Renderer code (shell and modules) reaches main through
// registered channels; it never gets ipcRenderer itself.
import { contextBridge, ipcRenderer } from "electron";
import { unwrap, type InvokeResult } from "../shared/invoke";

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
  // Main answers with an InvokeResult (shared/invoke.ts) so expected helper errors do not print
  // stacks in the terminal; the error is rethrown here with its code. Electron still wraps the
  // rare throw outside it as "Error invoking remote method 'bh:invoke': Error: <msg>"; panels
  // show only <msg>.
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke("bh:invoke", channel, ...args).then(
      (r: InvokeResult) => unwrap(r),
      (e: unknown) => {
        const msg = String((e as Error)?.message ?? e).replace(/^(?:Error: )?Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error: )+/, "");
        throw new Error(msg || "failed with no message");
      },
    ),
  on: (channel: string, cb: Cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(cb);
    return () => listeners.get(channel)?.delete(cb);
  },
  platform: process.platform,
});
