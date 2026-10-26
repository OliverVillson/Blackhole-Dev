// Recipe sidebar: my recipes (cards with base model and description), my functions, built-ins.
// Right click a recipe for its actions; modules add actions with registerRecipeAction.

import { h, clear, basename } from "../dom";
import { bh, helper } from "../bridge";
import { contextMenu, prompt, toast, type MenuItem } from "../ui";
import type { Shell } from "../shell";
import type { FunctionInfo, StepsResult } from "../../shared/rpc";
import { STARTER } from "../../shared/starter";

interface Entry { path: string; name: string; dir: boolean; children?: Entry[] }

const flat = (es: Entry[]): Entry[] => es.flatMap((e) => (e.dir ? flat(e.children ?? []) : [e]));

export function recipesView(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const list = h("div", { style: "display:flex;flex-direction:column;gap:2px" });
    const fnList = h("div", { style: "display:flex;flex-direction:column" });
    const builtinList = h("div", { style: "display:flex;flex-direction:column" });
    const search = h("input", { placeholder: "Search recipes, functions, base models", "aria-label": "Search recipes", style: "width:100%" });
    const recipeHead = h("div", { class: "hd", style: "padding:6px 4px 0" }, "My recipes");
    const fnHead = h("div", { class: "hd", style: "padding:8px 4px 0" }, "Named functions");
    let builtinOpen = false;
    const builtinToggle = h("button", { class: "it", style: "color:var(--dim)", "aria-expanded": "false", onclick: () => { builtinOpen = !builtinOpen; render(); } });
    const meta = new Map<string, StepsResult | null>();
    let recipes: Entry[] = [];
    let functions: FunctionInfo[] = [];
    let userFns: Entry[] = [];

    el.append(h("div", { class: "view" },
      h("div", { class: "view-head" }, h("span", { class: "hd" }, "Recipes"),
        h("div", { class: "row", style: "gap:6px" },
          h("button", { class: "btn sm", onclick: () => shell.executeCommand("recipe.new") }, "+ Recipe"),
          h("button", { class: "btn sm", onclick: () => shell.executeCommand("function.new") }, "+ Function"))),
      search, recipeHead, list, fnHead, fnList, builtinToggle, builtinList));

    const matchesQ = (...s: (string | undefined)[]) => {
      const q = search.value.trim().toLowerCase();
      return !q || s.some((x) => x?.toLowerCase().includes(q));
    };

    const render = () => {
      clear(list);
      const active = shell.activeFile();
      const shown = recipes.filter((r) => matchesQ(r.name, meta.get(r.path)?.base, meta.get(r.path)?.doc));
      recipeHead.textContent = `My recipes · ${recipes.length}`;
      if (!recipes.length) list.append(h("div", { class: "empty" }, "No recipes yet. + Recipe starts one, or File > Import TOML Schema."));
      for (const r of shown) {
        const m = meta.get(r.path);
        const title = m?.doc?.split("\n")[0];
        list.append(h("button", {
          class: `rc${r.path === active ? " sel" : ""}`,
          onclick: () => shell.openFile(r.path),
          oncontextmenu: (e: MouseEvent) => { e.preventDefault(); recipeMenu(shell, r.path, e.clientX, e.clientY, refresh); },
          title: r.path,
        },
          h("div", { class: "row", style: "gap:8px;flex-wrap:nowrap" }, h("span", { class: "nm" }, r.name), shell.editor.isDirty(r.path) ? h("span", { class: "badge hot" }, "unsaved") : null),
          m ? h("div", { class: "meta" }, [m.base, m.target].filter(Boolean).join(" → ") || "no base model") : null,
          title ? h("div", { class: "meta", style: "color:var(--text)" }, title) : null));
      }
      clear(fnList);
      const userByName = new Map(functions.filter((f) => f.origin !== "builtin").map((f) => [f.path, f]));
      if (!userFns.length) fnList.append(h("div", { class: "empty" }, "Your functions live in functions/. Fork a built-in to start from its source."));
      for (const f of userFns.filter((f) => matchesQ(f.name))) {
        const info = userByName.get(f.path);
        fnList.append(h("button", { class: "it", onclick: () => shell.openFile(f.path), title: f.path,
          oncontextmenu: (e: MouseEvent) => { e.preventDefault(); fileMenu(shell, f.path, e.clientX, e.clientY, refresh); } },
          h("span", { class: "fn" }, "ƒ"), f.name.replace(/\.py$/, ""),
          info ? h("span", { class: "meta" }, info.origin === "override" ? "overrides built-in" : info.per) : null));
      }
      const builtins = functions.filter((f) => f.origin === "builtin");
      clear(builtinToggle);
      builtinToggle.setAttribute("aria-expanded", String(builtinOpen));
      builtinToggle.append(h("span", null, builtinOpen ? "▾" : "▸"), `Built-in functions`, h("span", { class: "meta" }, String(builtins.length || "")));
      clear(builtinList);
      if (builtinOpen) {
        if (!builtins.length) builtinList.append(h("div", { class: "empty" }, shell.helperStatus.state === "ready" ? "The helper lists no built-ins." : "Built-ins load when the Python helper is ready."));
        for (const f of builtins.filter((x) => matchesQ(x.name, x.doc))) {
          builtinList.append(h("button", { class: "it", style: "padding-left:22px", title: f.doc, onclick: () => shell.executeCommand("function.show", f.name),
            oncontextmenu: (e: MouseEvent) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
              { label: "View source", run: () => shell.executeCommand("function.show", f.name) },
              { label: "Fork to my functions", run: () => shell.executeCommand("function.fork", f.name) },
            ]); } },
            h("span", { class: "fn" }, "ƒ"), h("span", { class: "mono" }, f.name), h("span", { class: "meta" }, f.per)));
        }
      }
    };

    const refresh = async () => {
      try {
        recipes = flat(await bh.invoke<Entry[]>("ws:list", shell.paths.recipes));
        userFns = flat(await bh.invoke<Entry[]>("ws:list", shell.paths.functions));
      } catch (e) {
        toast(`Could not read the workspace: ${(e as Error).message}`, "error");
      }
      render();
      if (shell.helperStatus.state === "ready") {
        helper("functions.list", {}).then((f) => { functions = f; render(); }).catch(() => undefined);
        for (const r of recipes) {
          helper("recipe.steps", { path: r.path }).then((m) => { meta.set(r.path, m); render(); }).catch(() => meta.set(r.path, null));
        }
      }
    };

    search.addEventListener("input", render);
    shell.workspace.onActiveFile(render);
    bh.on("helper:status", (s: { state: string }) => s.state === "ready" && refresh());
    shell.registerCommand({ id: "recipes.refresh", title: "Refresh recipes", run: refresh });
    window.addEventListener("focus", () => refresh());
    refresh();
  };
}

export function recipeMenu(shell: Shell, path: string, x: number, y: number, refresh: () => unknown): void {
  const items: MenuItem[] = [
    { label: "Open", hint: "↵", run: () => shell.openFile(path) },
    { label: "Overview", run: () => shell.openTab("recipe-overview", { path }) },
    { label: "Plan (dry run)", hint: "⌘⇧P", run: async () => { await shell.openFile(path); shell.executeCommand("recipe.plan"); } },
    ...shell.recipeActions.map((a) => ({ label: a.title, hint: a.keybinding?.replace("Cmd+", "⌘"), run: () => a.run(path) })),
    { label: "Export bundle (.bhr)", run: () => shell.executeCommand("recipe.bundle", path) },
    { sep: true, label: "" },
    { label: "Duplicate", run: async () => { const t = await shell.workspace.readFile(path); const p = await bh.invoke<string>("ws:create", shell.paths.recipes, basename(path).replace(/\.py$/, "-copy.py"), t); await refresh(); shell.openFile(p); } },
  ];
  items.push(...fileItems(shell, path, refresh));
  contextMenu(x, y, items);
}

function fileItems(shell: Shell, path: string, refresh: () => unknown): MenuItem[] {
  return [
    { label: "Rename…", run: async () => {
      const name = await prompt("Rename", "New file name", basename(path), "Rename");
      if (!name) return;
      try {
        const to = await bh.invoke<string>("ws:rename", path, name.endsWith(".py") ? name : name + ".py");
        shell.fileRenamed(path, to);
        refresh();
      } catch (e) { toast((e as Error).message, "error"); }
    } },
    { label: "Reveal in Finder", run: () => bh.invoke("app:reveal", path) },
    { sep: true, label: "" },
    { label: "Move to Trash", run: async () => {
      if (!confirm(`Move ${basename(path)} to the Trash?`)) return;
      await bh.invoke("ws:trash", path);
      shell.fileRemoved(path);
      refresh();
    } },
  ];
}

function fileMenu(shell: Shell, path: string, x: number, y: number, refresh: () => unknown): void {
  contextMenu(x, y, [{ label: "Open", run: () => shell.openFile(path) }, ...fileItems(shell, path, refresh)]);
}

export async function newRecipe(shell: Shell): Promise<void> {
  const name = await prompt("New recipe", "File name (in recipes/)", "my-recipe.py", "Create");
  if (!name) return;
  const p = await bh.invoke<string>("ws:create", shell.paths.recipes, name, STARTER.recipe(name.replace(/\.py$/, "")));
  await shell.executeCommand("recipes.refresh");
  shell.openFile(p);
}

export async function newFunction(shell: Shell): Promise<void> {
  const name = await prompt("New function", "Function name (what recipes call it)", "my-function", "Create");
  if (!name) return;
  const slug = name.replace(/\.py$/, "").replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  const p = await bh.invoke<string>("ws:create", shell.paths.functions, slug.replace(/-/g, "_") + ".py", STARTER.fn(slug));
  await shell.executeCommand("recipes.refresh");
  shell.openFile(p);
}
