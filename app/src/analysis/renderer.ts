// Analysis module, renderer side: an Analysis activity (models + forks, analyses, scripts),
// analysis tabs that draw a report's charts, palette commands and a settings section.
import type { RendererContext } from "../shared/ext";
import "./analysis.css";
import { CH, DEFAULT_SETTINGS, type AnalysisSettings } from "./shared";
import { AnalysisStore, renderSidebar, renderTab, type AnalysisTabState } from "./ui";

const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4"/><path d="M12 16V8"/><path d="M16 16v-6"/><path d="M20 16V6"/></svg>';

export function activate(ctx: RendererContext): void {
  const store = new AnalysisStore(ctx);
  const open = (s: AnalysisTabState) => ctx.openTab("analysis", s);

  ctx.registerActivity({ id: "analysis", title: "Analysis", icon: ICON, order: 45 });
  ctx.registerSidebarView("analysis", { render: (el) => renderSidebar(el, ctx, store, open) });
  ctx.registerTabType<AnalysisTabState>({
    id: "analysis",
    title: (s) => `Analysis · ${s?.name ? store.get(s.name)?.title ?? s.name : (s?.path ?? "").split(/[\\/]/).pop()}`,
    key: (s) => `${s?.name ?? s?.path ?? ""}@${s?.model ?? ""}`,
    render: (el, s) => renderTab(el, ctx, store, s ?? {}),
  });

  ctx.registerCommand({ id: "analysis.open", title: "Analysis: Open an analysis", run: (name?: string) => open({ name: name ?? "overview", model: store.model || undefined }) });
  ctx.registerCommand({
    id: "analysis.compareWithParent",
    title: "Analysis: Compare the model with its parent",
    run: () => open({ name: "compare", model: store.model || undefined }),
  });
  ctx.registerCommand({
    id: "analysis.runActiveFile",
    title: "Analysis: Run the open file as an analysis",
    run: () => {
      const f = ctx.workspace.activeFile();
      if (!f || !f.endsWith(".py")) return ctx.notify("Open an analysis script (.py) in the editor first.", "warn");
      open({ path: f, model: store.model || undefined });
    },
  });
  ctx.registerCommand({
    id: "analysis.newScript",
    title: "Analysis: New analysis script",
    run: async () => {
      const name = prompt("Name of the analysis", "my-analysis");
      if (name === null) return;
      const path = await ctx.invoke<string>(CH.newScript, name);
      await ctx.workspace.open(path);
      await store.refresh();
    },
  });
  ctx.registerCommand({ id: "analysis.refresh", title: "Analysis: Reload analyses and models", run: () => store.refresh() });

  ctx.registerSettingsSection({
    id: "analysis",
    title: "Analysis",
    order: 60,
    render: (el) => {
      const wrap = document.createElement("div");
      wrap.className = "an-bar";
      const field = (label: string, key: keyof AnalysisSettings, hint: string) => {
        const f = document.createElement("label");
        f.className = "an-field";
        f.append(document.createTextNode(label));
        const i = document.createElement("input");
        i.type = "number";
        i.min = "0";
        i.step = "any";
        i.value = String(DEFAULT_SETTINGS[key]);
        i.title = hint;
        i.addEventListener("change", () => {
          ctx.invoke(CH.setSettings, { [key]: Number(i.value) }).catch((e: Error) => ctx.notify(e.message, "error"));
        });
        f.append(i);
        wrap.append(f);
        return i;
      };
      const gb = field("Ask before reading (GB, local)", "confirmGb", "An analysis that reads more weights than this asks first");
      const mb = field("Ask before downloading (MB, Hub models)", "remoteConfirmMb", "Reading a Hub model in place downloads what it reads");
      void ctx.invoke<AnalysisSettings>(CH.settings).then((s) => {
        gb.value = String(s.confirmGb);
        mb.value = String(s.remoteConfirmMb);
      });
      el.append(wrap);
    },
  });
}
