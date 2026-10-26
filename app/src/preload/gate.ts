// The confirm-gate window's bridge: receive one request, send one answer.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gate", {
  onRequest: (cb: (req: unknown) => void) => ipcRenderer.once("gate:request", (_e, req) => cb(req)),
  answer: (a: { id: string; approved: boolean; trusted: boolean }) => ipcRenderer.send("gate:answer", a),
});
