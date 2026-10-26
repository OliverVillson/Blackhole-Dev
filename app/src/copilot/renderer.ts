// Copilot, renderer side: the right-hand panel, the activity icon, Cmd+I and a status item.
import type { RendererContext } from "../shared/ext";
import { focusCopilot, renderCopilotPanel } from "./panel";
import { CopilotSession, type CopilotState } from "./session";
import { makeTurnTransport } from "./transport";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M11 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 15v4M17 17h4"/></svg>`;

const STATUS: Record<CopilotState, string> = {
  idle: "Copilot: ready",
  thinking: "Copilot: thinking",
  writing: "Copilot: streaming",
  paused: "Copilot: paused",
  tools: "Copilot: checking",
  error: "Copilot: error",
};

export function activate(ctx: RendererContext): void {
  const session = new CopilotSession({
    editor: ctx.editor,
    activeFile: () => ctx.workspace.activeFile(),
    ...makeTurnTransport(ctx),
    invoke: (channel, payload) => ctx.invoke(channel, payload),
    readFile: (path) => ctx.workspace.readFile(path),
    listFiles: () => ctx.workspace.listRecipes(),
    openFile: async (path, opts) => {
      await ctx.workspace.open(path, undefined, opts);
    },
  });

  let panelEl: HTMLElement | null = null;
  ctx.registerActivity({ id: "copilot", title: "Copilot", icon: ICON, order: 50, run: () => void ctx.executeCommand("copilot.ask") });
  ctx.registerRightPanel({
    id: "copilot",
    title: "Copilot",
    render(el) {
      panelEl = el;
      const off = renderCopilotPanel(el, {
        session,
        invoke: (c, ...a) => ctx.invoke(c, ...a),
        activeFile: () => ctx.workspace.activeFile(),
        onActiveFile: (cb) => ctx.workspace.onActiveFile(cb),
      });
      return () => {
        panelEl = null;
        off();
      };
    },
  });

  const status = ctx.registerStatusItem({ id: "copilot", side: "right", text: STATUS.idle, command: "copilot.ask" });
  session.on((e) => {
    if (e.type === "state") status.update(STATUS[e.state]);
  });

  ctx.registerCommand({
    id: "copilot.ask",
    title: "Ask Copilot",
    keybinding: "Cmd+I",
    run: async () => {
      await ctx.executeCommand("workbench.right", "copilot");
      if (panelEl) focusCopilot(panelEl);
    },
  });
  ctx.registerCommand({ id: "copilot.pause", title: "Copilot: Pause or Resume", run: () => (session.state === "paused" ? session.resume() : session.pause()) });
  ctx.registerCommand({ id: "copilot.stop", title: "Copilot: Stop", keybinding: "Cmd+.", run: () => session.stop() });
  ctx.registerCommand({ id: "copilot.acceptAll", title: "Copilot: Accept All Changes", run: () => session.acceptAll() });
  ctx.registerCommand({ id: "copilot.rejectAll", title: "Copilot: Reject All Changes", run: () => session.rejectAll() });
  ctx.registerRecipeAction({
    id: "copilot.explain",
    title: "Ask Copilot about this recipe",
    run: (path) => {
      ctx.workspace.open(path);
      void session.ask(`Explain what ${path} does, step by step, and point out anything that looks wrong. Do not change the file.`);
    },
  });
}
