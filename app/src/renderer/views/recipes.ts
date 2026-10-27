// Recipe sidebar: my recipes (cards with base model and description), my functions, built-ins.
// Subfolders of recipes/ and functions/ show as collapsible groups; drag a row onto a folder (or
// the list background for the top level) to move it. Right click a recipe for its actions;
// modules add actions with registerRecipeAction.

import { h, clear, basename, dirname, FILE_DRAG } from "../dom";
import { bh, helper } from "../bridge";
import { contextMenu, prompt, toast, type MenuItem } from "../ui";
import { prettyKeys } from "../keys";
import type { Shell } from "../shell";
import type { FunctionInfo, StepsResult } from "../../shared/rpc";
import { STARTER } from "../../shared/starter";

interface Entry { path: string; name: string; dir: boolean; children?: Entry[] }

const flat = (es: Entry[]): Entry[] => es.flatMap((e) => (e.dir ? flat(e.children ?? []) : [e]));

const FOLDED_KEY = "bh.recipes.folded";
const loadFolded = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]")); } catch { return new Set(); }
};
const saveFolded = (s: Set<string>) => {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...s])); } catch { /* per-viewer convenience only */ }
};

const ICON = {
  recipe: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/></svg>',
  fn: '<svg viewBox="0 0 24 24"><path d="M13 4c-3 0-4 1.5-4.5 4L6 20"/><path d="M5 10h7"/><path d="M18 12v6M15 15h6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/><path d="M12 11v6M9 14h6"/></svg>',
};
const iconBtn = (icon: string, label: string, onclick: () => unknown) =>
  h("button", { class: "btn sm icon", title: label, "aria-label": label, html: icon, onclick });

// Drag state shared by both trees: what is being dragged and from which root.
let dragging: { path: string; root: string } | null = null;

export function recipesView(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const list = h("div", { class: "tree", style: "display:flex;flex-direction:column;gap:2px" });
    const fnList = h("div", { class: "tree", style: "display:flex;flex-direction:column" });
    const builtinList = h("div", { style: "display:flex;flex-direction:column" });
    const search = h("input", { placeholder: "Search recipes, functions, base models", "aria-label": "Search recipes", style: "width:100%" });
    const recipeCount = h("span", { class: "hd" }, "My recipes");
    const recipeHead = h("div", { class: "view-head", style: "padding:6px 4px 0" }, recipeCount,
      iconBtn(ICON.folder, "New recipe folder", () => shell.executeCommand("recipe.newFolder", shell.paths.recipes)));
    const fnHead = h("div", { class: "view-head", style: "padding:8px 4px 0" }, h("span", { class: "hd" }, "Named functions"),
      iconBtn(ICON.folder, "New function folder", () => shell.executeCommand("function.newFolder", shell.paths.functions)));
    let builtinOpen = false;
    const builtinToggle = h("button", { class: "it", style: "color:var(--dim)", "aria-expanded": "false", onclick: () => { builtinOpen = !builtinOpen; render(); } });
    const meta = new Map<string, StepsResult | null>();
    const folded = loadFolded();
    let recipes: Entry[] = [];
    let functions: FunctionInfo[] = [];
    let userFns: Entry[] = [];

    el.append(h("div", { class: "view" },
      h("div", { class: "view-head" }, h("span", { class: "hd" }, "Recipes"),
        h("div", { class: "row", style: "gap:4px;flex-wrap:nowrap" },
          iconBtn(ICON.recipe, "New recipe", () => shell.executeCommand("recipe.new")),
          iconBtn(ICON.fn, "New function", () => shell.executeCommand("function.new")))),
      search, recipeHead, list, fnHead, fnList, builtinToggle, builtinList));

    const query = () => search.value.trim().toLowerCase();
    const matchesQ = (...s: (string | undefined)[]) => {
      const q = query();
      return !q || s.some((x) => x?.toLowerCase().includes(q));
    };
    const rel = (root: string, p: string) => p.slice(root.length + 1);

    const moved = async (from: string, toDir: string) => {
      try {
        const to = await bh.invoke<string>("ws:move", from, toDir);
        if (to !== from) {
          shell.pathMoved(from, to);
          if (folded.delete(from)) { folded.add(to); saveFolded(folded); }
        }
      } catch (e) { toast((e as Error).message, "error"); }
      refresh();
    };

    /** Let `el` take drops of entries from `root` into folder `dir`. */
    const dropTarget = (target: HTMLElement, rootOf: string | (() => string), dirOf: string | (() => string)) => {
      const val = (x: string | (() => string)) => (typeof x === "function" ? x() : x);
      const ok = () => {
        const root = val(rootOf), dir = val(dirOf);
        return !!dragging && dragging.root === root && dragging.path !== dir && !dir.startsWith(dragging.path + "/")
        && dirname(dragging.path) !== dir;
      };
      target.addEventListener("dragover", (e) => {
        if (!ok()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer!.dropEffect = "move";
        target.classList.add("drop");
      });
      target.addEventListener("dragleave", (e) => { if (!target.contains(e.relatedTarget as Node)) target.classList.remove("drop"); });
      target.addEventListener("drop", (e) => {
        target.classList.remove("drop");
        if (!ok()) return;
        e.preventDefault();
        e.stopPropagation();
        const from = dragging!.path;
        dragging = null;
        moved(from, val(dirOf));
      });
    };
    const draggable = (row: HTMLElement, root: string, path: string, file = true) => {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        dragging = { path, root };
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", path);
        if (file) {
          e.dataTransfer!.setData(FILE_DRAG, path);
          e.dataTransfer!.effectAllowed = "copyMove";
          // the editors' drop zones show for any drag that can land there, tab or file
          requestAnimationFrame(() => document.body.classList.add("tab-drag"));
        }
      });
      row.addEventListener("dragend", () => {
        dragging = null;
        document.body.classList.remove("tab-drag");
        document.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      });
    };

    /** Folders of a tree (for Move to…), as absolute paths, top level first. */
    const folders = (root: string, es: Entry[]): string[] => [root, ...es.filter((e) => e.dir).flatMap((e) => folders(e.path, e.children ?? []))];

    const moveMenu = (root: string, tree: Entry[], path: string, x: number, y: number) => {
      const here = dirname(path);
      const dests = folders(root, tree).filter((d) => d !== here && d !== path && !d.startsWith(path + "/"));
      if (!dests.length) return toast("Make a folder first (the folder button next to the list title).");
      contextMenu(x, y, dests.map((d) => ({ label: d === root ? `${basename(root)}/ (top level)` : `${rel(root, d)}/`, run: () => moved(path, d) })));
    };

    interface TreeKind {
      root: string;
      entries: Entry[];
      fileMatches(e: Entry): boolean;
      file(e: Entry, depth: number): HTMLElement;
      fileMenu(e: Entry): MenuItem[];
      newFile(dir: string): unknown;
      newFolder(dir: string): unknown;
    }

    const folderMenu = (k: TreeKind, e: Entry): MenuItem[] => [
      { label: k.root === shell.paths.recipes ? "New recipe here" : "New function here", run: () => k.newFile(e.path) },
      { label: "New folder here", run: () => k.newFolder(e.path) },
      { sep: true, label: "" },
      { label: "Move to…", run: () => { const r = el.getBoundingClientRect(); moveMenu(k.root, k.entries, e.path, r.left + 40, r.top + 80); } },
      ...fileItems(shell, e.path, refresh, true),
    ];

    /** Draw one tree level; returns how many files under it are shown. */
    const drawTree = (k: TreeKind, into: HTMLElement, es: Entry[], depth: number): number => {
      const searching = !!query();
      let shown = 0;
      for (const e of [...es.filter((x) => x.dir), ...es.filter((x) => !x.dir)]) {
        if (!e.dir) {
          if (!k.fileMatches(e)) continue;
          const row = k.file(e, depth);
          draggable(row, k.root, e.path);
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const at = { x: ev.clientX, y: ev.clientY };
            contextMenu(at.x, at.y, k.fileMenu(e).map((it) => it.label === "Move to…" ? { ...it, run: () => moveMenu(k.root, k.entries, e.path, at.x, at.y) } : it));
          });
          into.append(row);
          shown++;
          continue;
        }
        const kids = h("div", { style: "display:flex;flex-direction:column;gap:2px" });
        const n = drawTree(k, kids, e.children ?? [], depth + 1);
        const folderHit = searching && e.name.toLowerCase().includes(query());
        if (searching && !n && !folderHit) continue;
        const open = searching || !folded.has(e.path);
        const total = flat(e.children ?? []).length;
        const row = h("button", {
          class: "it folder", style: `padding-left:${8 + depth * 14}px`, title: rel(k.root, e.path) + "/", "aria-expanded": String(open),
          onclick: () => { if (folded.has(e.path)) folded.delete(e.path); else folded.add(e.path); saveFolded(folded); render(); },
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            const at = { x: ev.clientX, y: ev.clientY };
            contextMenu(at.x, at.y, folderMenu(k, e).map((it) => it.label === "Move to…" ? { ...it, run: () => moveMenu(k.root, k.entries, e.path, at.x, at.y) } : it));
          },
        }, h("span", { class: "tw" }, open ? "▾" : "▸"), h("span", { class: "fi", html: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>' }),
          h("span", { class: "fname" }, e.name), h("span", { class: "meta" }, String(total)));
        draggable(row, k.root, e.path, false);
        const group = h("div", { class: "fgroup" }, row);
        dropTarget(group, k.root, e.path);
        if (open) {
          if (!total) kids.append(h("div", { class: "empty", style: `padding-left:${22 + (depth + 1) * 14}px` }, "Empty. Drag files here."));
          group.append(kids);
        }
        into.append(group);
        shown += n;
      }
      return shown;
    };

    const recipeKind: TreeKind = {
      root: "", entries: [],
      fileMatches: (r) => matchesQ(r.name, meta.get(r.path)?.base, meta.get(r.path)?.doc, rel(shell.paths.recipes, r.path)),
      file: (r, depth) => {
        const m = meta.get(r.path);
        const title = m?.doc?.split("\n")[0];
        return h("button", {
          class: `rc${r.path === shell.activeFile() ? " sel" : ""}`, style: depth ? `padding-left:${12 + depth * 14}px` : undefined,
          onclick: () => shell.openFile(r.path), title: r.path,
        },
          h("div", { class: "row", style: "gap:8px;flex-wrap:nowrap" }, h("span", { class: "nm" }, r.name), shell.editor.isDirty(r.path) ? h("span", { class: "badge hot" }, "unsaved") : null),
          m ? h("div", { class: "meta" }, [m.base, m.target].filter(Boolean).join(" → ") || "no base model") : null,
          title ? h("div", { class: "meta", style: "color:var(--text)" }, title) : null);
      },
      fileMenu: (r) => recipeItems(shell, r.path, refresh),
      newFile: (dir) => shell.executeCommand("recipe.new", dir),
      newFolder: (dir) => shell.executeCommand("recipe.newFolder", dir),
    };
    const fnKind: TreeKind = {
      root: "", entries: [],
      fileMatches: (f) => matchesQ(f.name, rel(shell.paths.functions, f.path)),
      file: (f, depth) => {
        const info = functions.find((x) => x.origin !== "builtin" && x.path === f.path);
        return h("button", { class: `it${f.path === shell.activeFile() ? " sel" : ""}`, style: `padding-left:${8 + depth * 14}px`, onclick: () => shell.openFile(f.path), title: f.path },
          h("span", { class: "fn" }, "ƒ"), f.name.replace(/\.py$/, ""),
          info ? h("span", { class: "meta" }, info.origin === "override" ? "overrides built-in" : info.per) : null);
      },
      fileMenu: (f) => [{ label: "Open", run: () => shell.openFile(f.path) }, { label: "Move to…" }, ...fileItems(shell, f.path, refresh)],
      newFile: (dir) => shell.executeCommand("function.new", dir),
      newFolder: (dir) => shell.executeCommand("function.newFolder", dir),
    };

    const listMenu = (k: TreeKind) => (ev: MouseEvent) => {
      ev.preventDefault();
      contextMenu(ev.clientX, ev.clientY, [
        { label: k === recipeKind ? "New recipe" : "New function", run: () => k.newFile(k.root) },
        { label: "New folder", run: () => k.newFolder(k.root) },
      ]);
    };
    list.addEventListener("contextmenu", listMenu(recipeKind));
    fnList.addEventListener("contextmenu", listMenu(fnKind));

    const render = () => {
      recipeKind.root = shell.paths.recipes;
      recipeKind.entries = recipes;
      fnKind.root = shell.paths.functions;
      fnKind.entries = userFns;
      clear(list);
      const nRecipes = flat(recipes).length;
      recipeCount.textContent = `My recipes · ${nRecipes}`;
      if (!recipes.length) list.append(h("div", { class: "empty" }, "No recipes yet. + Recipe starts one, or File > Import TOML Schema."));
      else if (!drawTree(recipeKind, list, recipes, 0) && query()) list.append(h("div", { class: "empty" }, "No recipe matches."));
      clear(fnList);
      if (!userFns.length) fnList.append(h("div", { class: "empty" }, "Your functions live in functions/. Fork a built-in to start from its source."));
      else drawTree(fnKind, fnList, userFns, 0);
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

    // Drops on the list itself (outside any folder) move to the top level.
    dropTarget(list, () => shell.paths.recipes, () => shell.paths.recipes);
    dropTarget(fnList, () => shell.paths.functions, () => shell.paths.functions);

    const refresh = async () => {
      try {
        recipes = await bh.invoke<Entry[]>("ws:list", shell.paths.recipes);
        userFns = await bh.invoke<Entry[]>("ws:list", shell.paths.functions);
      } catch (e) {
        toast(`Could not read the workspace: ${(e as Error).message}`, "error");
      }
      render();
      if (shell.helperStatus.state === "ready") {
        helper("functions.list", {}).then((f) => { functions = f; render(); }).catch(() => undefined);
        for (const r of flat(recipes)) {
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

function recipeItems(shell: Shell, path: string, refresh: () => unknown): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Open", hint: "↵", run: () => shell.openFile(path) },
    { label: "Overview", run: () => shell.openTab("recipe-overview", { path }) },
    { label: "Plan (dry run)", hint: prettyKeys("Cmd+Alt+P"), run: async () => { await shell.openFile(path); shell.executeCommand("recipe.plan"); } },
    ...shell.recipeActions.map((a) => ({ label: a.title, hint: a.keybinding?.replace("Cmd+", "⌘"), run: () => a.run(path) })),
    { label: "Export bundle (.bhr)", run: () => shell.executeCommand("recipe.bundle", path) },
    { sep: true, label: "" },
    { label: "Duplicate", run: async () => { const t = await shell.workspace.readFile(path); const p = await bh.invoke<string>("ws:create", dirname(path), basename(path).replace(/\.py$/, "-copy.py"), t); await refresh(); shell.openFile(p); } },
    { label: "Move to…" },
  ];
  items.push(...fileItems(shell, path, refresh));
  return items;
}

function fileItems(shell: Shell, path: string, refresh: () => unknown, folder = false): MenuItem[] {
  return [
    { label: "Rename…", run: async () => {
      const name = await prompt("Rename", folder ? "New folder name" : "New file name", basename(path), "Rename");
      if (!name) return;
      try {
        const to = await bh.invoke<string>("ws:rename", path, folder || name.endsWith(".py") ? name : name + ".py");
        shell.pathMoved(path, to);
        refresh();
      } catch (e) { toast((e as Error).message, "error"); }
    } },
    { label: "Reveal in Finder", run: () => bh.invoke("app:reveal", path) },
    { sep: true, label: "" },
    { label: "Move to Trash", run: async () => {
      if (!confirm(folder ? `Move the folder ${basename(path)} and everything in it to the Trash?` : `Move ${basename(path)} to the Trash?`)) return;
      await bh.invoke("ws:trash", path);
      shell.fileRemoved(path);
      refresh();
    } },
  ];
}

const where = (root: string, dir: string) => (dir === root ? `${basename(root)}/` : `${basename(root)}/${dir.slice(root.length + 1)}/`);

/** New recipe in `dir` (default: recipes/). The name may include folders, like qwen/int4.py. */
export async function newRecipe(shell: Shell, dir = shell.paths.recipes): Promise<void> {
  const name = await prompt("New recipe", `File name (in ${where(shell.paths.recipes, dir)}; add folder/ to group it)`, "my-recipe.py", "Create");
  if (!name) return;
  const p = await bh.invoke<string>("ws:create", dir, name, STARTER.recipe(basename(name).replace(/\.py$/, "")));
  await shell.executeCommand("recipes.refresh");
  shell.openFile(p);
}

export async function newFunction(shell: Shell, dir = shell.paths.functions): Promise<void> {
  const name = await prompt("New function", "Function name (what recipes call it)", "my-function", "Create");
  if (!name) return;
  const slug = basename(name).replace(/\.py$/, "").replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  const p = await bh.invoke<string>("ws:create", dir, slug.replace(/-/g, "_") + ".py", STARTER.fn(slug));
  await shell.executeCommand("recipes.refresh");
  shell.openFile(p);
}

export async function newFolder(shell: Shell, parent: string): Promise<void> {
  const root = parent.startsWith(shell.paths.functions) ? shell.paths.functions : shell.paths.recipes;
  const name = await prompt("New folder", `Folder name (in ${where(root, parent)})`, "", "Create");
  if (!name) return;
  await bh.invoke<string>("ws:mkdir", parent, name);
  await shell.executeCommand("recipes.refresh");
}
