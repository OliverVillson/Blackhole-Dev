// Renderer modules, activated in this order. Each workstream adds one line.
import type { RendererModule } from "./shared/ext";

export const rendererModules: [id: string, load: () => Promise<RendererModule>][] = [
  ["copilot", () => import("./copilot/renderer")],
  // ["vm", () => import("./vm/renderer")],
  // ["chat", () => import("./chat/renderer")],
];
