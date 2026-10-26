import "./fonts";
import "./styles.css";
import { Shell } from "./shell";
import { bh, helper } from "./bridge";
import { ICONS, basename } from "./dom";
import { prompt, toast } from "./ui";
import { recipesView, newRecipe, newFunction } from "./views/recipes";
import { functionsView, showFunction, forkFunction } from "./views/functions";
import { Anatomy } from "./views/anatomy";
import { settingsView } from "./views/settings";
import { PlanPanel, problemsPanel } from "./panels/plan";
import { TerminalPanel, outputPanel } from "./panels/terminal";
import { welcomeTab, overviewTab } from "./tabs";
import { openPalette } from "./palette";
import { rendererModules } from "../modules.renderer";
import type { AppPaths } from "../shared/ext";
import type { HelperStatus } from "../shared/rpc";

async function boot(): Promise<void> {
  const shell = new Shell(document.getElementById("app")!);
  shell.paths = await bh.invoke<AppPaths>("ws:paths");
  shell.initStatus();
  const report = (e: unknown) => toast(String((e as Error)?.message ?? e), "error");

  // Activities and their sidebar views.
  shell.registerActivity({ id: "recipes", title: "Recipes", icon: ICONS.recipes, order: 10 });
  shell.registerActivity({ id: "functions", title: "Named functions", icon: ICONS.functions, order: 20 });
  shell.registerActivity({ id: "anatomy", title: "Model anatomy", icon: ICONS.anatomy, order: 30 });
  shell.registerActivity({ id: "settings", title: "Settings", icon: ICONS.settings, order: 1000 }, true);
  shell.registerSidebarView("recipes", { render: recipesView(shell) });
  shell.registerSidebarView("functions", { render: functionsView(shell) });
  const anatomy = new Anatomy(shell);
  shell.registerSidebarView("anatomy", { render: anatomy.sidebar() });
  shell.registerSidebarView("settings", { render: settingsView(shell) });
  shell.registerRightPanel({ id: "anatomy", title: "ANATOMY", order: 10, render: anatomy.panel() });

  // Bottom panels.
  const plan = new PlanPanel(shell);
  const terms = new TerminalPanel(shell);
  shell.registerPanel({ id: "plan", title: "PLAN", order: 10, render: (el) => plan.render(el) });
  shell.registerPanel({ id: "problems", title: "PROBLEMS 0", order: 20, render: problemsPanel(shell) });
  shell.registerPanel({ id: "terminal", title: "TERMINAL", order: 30, render: (el) => terms.render(el) });
  shell.registerPanel({ id: "output", title: "OUTPUT", order: 40, render: outputPanel() });
  bh.on("helper:status", (s: HelperStatus) => s.state === "ready" && plan.loadDevices());

  // Tabs.
  shell.registerTabType({ id: "welcome", title: () => "Welcome", key: () => "welcome", render: welcomeTab(shell) });
  shell.registerTabType<{ path: string }>({ id: "recipe-overview", title: (s) => `${basename(s.path)} · overview`, key: (s) => s.path, render: overviewTab(shell) });

  // Commands (ids are what menus, keybindings and modules call).
  const cmd = (id: string, title: string, run: (...a: any[]) => unknown, keybinding?: string) => shell.registerCommand({ id, title, run, keybinding });
  cmd("palette.open", "Quick open", () => openPalette(shell));
  cmd("recipe.new", "New recipe", () => newRecipe(shell).catch(report));
  cmd("function.new", "New function", () => newFunction(shell).catch(report));
  cmd("function.show", "Show function source", (name: string) => showFunction(shell, name).catch(report));
  cmd("function.fork", "Fork built-in function", (name: string) => forkFunction(shell, name).catch(report));
  cmd("recipe.importToml", "Import TOML schema", async () => {
    const r = await bh.invoke<{ path: string } | null>("ws:importToml").catch(report);
    if (!r) return;
    await shell.executeCommand("recipes.refresh");
    shell.openFile(r.path);
  });
  cmd("recipe.fromPreset", "New recipe from a preset", async () => {
    const id = await prompt("Start from a preset", "Preset id (for example qwen-mac-qhex, mac-qhex, moe-prune-int4)", "qwen-mac-qhex", "Create");
    if (!id) return;
    const r = await helper("recipe.fromPreset", { id, out: shell.paths.recipes }).catch(report);
    if (!r) return;
    await shell.executeCommand("recipes.refresh");
    shell.openFile(r.path);
  });
  cmd("file.save", "Save", async () => {
    const p = shell.activeFile();
    if (p) await shell.editor.save(p).catch(report);
  });
  cmd("tab.close", "Close tab", () => shell.closeActiveTab());
  cmd("recipe.plan", "Plan (dry run)", () => plan.run().catch(report));
  cmd("recipe.lint", "Lint recipe", () => {
    const p = shell.activeFile();
    if (p) shell.lint(p);
    shell.showPanel("problems");
  });
  cmd("recipe.overview", "Recipe overview", () => {
    const p = shell.activeFile();
    if (shell.isRecipe(p)) shell.openTab("recipe-overview", { path: p });
  });
  cmd("recipe.bundle", "Export bundle (.bhr)", async (path?: string) => {
    const p = path ?? shell.activeFile();
    if (!shell.isRecipe(p)) return toast("Open a recipe first.", "warn");
    if (shell.editor.isDirty(p)) await shell.editor.save(p);
    const r = await helper("recipe.bundle", { path: p }).catch(report);
    if (r) {
      toast(`Bundle written: ${basename(r.bundle)} (sha256 ${r.sha256.slice(0, 12)}…)`);
      bh.invoke("app:reveal", r.bundle).catch(() => undefined);
    }
  });
  cmd("view.sidebar", "Toggle sidebar", () => shell.toggleActivity("recipes"));
  cmd("view.panel", "Toggle panel", () => shell.togglePanel());
  cmd("view.inspector", "Toggle inspector", () => shell.toggleRight(), "Cmd+Alt+B");
  cmd("panel.problems", "Show problems", () => shell.showPanel("problems"));
  cmd("helper.restart", "Restart Python helper", () => bh.invoke("helper:restart").catch(report));
  cmd("terminal.new", "New terminal", () => terms.newShell(), "Ctrl+`");
  cmd("terminal.attach", "Attach terminal", (id: string, title: string) => terms.attach(id, title));
  cmd("terminal.focus", "Focus terminal", (id: string) => terms.focus(id));
  cmd("workbench.view", "Show a sidebar view", (activityId: string) => shell.showActivity(activityId));
  cmd("workbench.right", "Show a right-hand panel", (panelId: string) => shell.showRight(panelId));
  cmd("workspace.choose", "Choose workspace folder", () => bh.invoke("ws:chooseFolder"));
  cmd("app.welcome", "Welcome and checks", () => shell.openTab("welcome", {}));
  cmd("app.logs", "Show logs", () => shell.showPanel("output"));
  cmd("recipes.overviewActive", "Overview of the active recipe", () => shell.executeCommand("recipe.overview"));

  shell.showActivity("recipes");
  shell.openTab("welcome", {});

  // Workstream modules (copilot, vm, chat, ...).
  for (const [id, load] of rendererModules) {
    try {
      const mod = await load();
      await mod.activate(shell.contextFor(id));
    } catch (e) {
      console.error(e);
      toast(`Module ${id} failed to load: ${(e as Error).message}`, "error");
    }
  }
  bh.invoke<HelperStatus>("helper:status").then((s) => s && shell.setHelperStatus(s));
  (window as unknown as { __shell: Shell }).__shell = shell; // handy in DevTools and for UI tests
}

boot().catch((e) => {
  document.body.textContent = `BlackHole-Dev failed to start: ${e?.stack ?? e}`;
});
