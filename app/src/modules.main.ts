// Main-process modules, activated in this order. Each workstream adds one line.
import type { MainModule } from "./shared/ext";

export const mainModules: [id: string, load: () => Promise<MainModule>][] = [
  ["copilot", () => import("./copilot/main")],
  ["vm", () => import("./vm/main")],
  // ["chat", () => import("./chat/main")],
];
