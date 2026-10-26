// Quick open (Cmd+P): recipes, functions, built-ins; ">" switches to commands (Cmd+Shift+P).
// Find in files (Cmd+Shift+F). One popover at a time: pressing the same shortcut again closes
// it, the other one switches it.

import { h, clear, basename, debounce } from "./dom";
import { bh, helper } from "./bridge";
import { matches, prettyKeys } from "./keys";
import { KEYMAP, EDITOR_KEYS } from "./shortcuts";
import { fuzzy } from "./editor/complete";
import type { Shell } from "./shell";

interface Item { label: string; detail: string; keys?: string; run: () => unknown }

// Commands that take arguments and make no sense from the palette.
const INTERNAL = new Set(["terminal.attach", "terminal.focus", "function.show", "function.fork", "workbench.view", "group.focus", "recipes.overviewActive"]);
const recent: string[] = [];

let current: { kind: "open" | "search"; overlay: HTMLElement; input: HTMLInputElement; close: () => void } | null = null;

/** Keys shown next to a command: the shell keymap, a module's own binding, or the editor's. */
export function keysFor(shell: Shell, id: string): string | undefined {
  const k = KEYMAP.find((b) => b.command === id && !b.args)?.keys ?? shell.commands.get(id)?.keybinding;
  if (k) return k;
  const title = shell.commands.get(id)?.title;
  return EDITOR_KEYS.find(([, what]) => what === title)?.[0];
}

function popover(kind: "open" | "search", placeholder: string, label: string, onKeyExtra?: (e: KeyboardEvent) => void) {
  current?.close();
  const input = h("input", { placeholder, "aria-label": label, spellcheck: false });
  const list = h("div", { class: "palette-list", role: "listbox" });
  const box = h("div", { class: "modal palette" }, input, list);
  const overlay = h("div", { class: "overlay palette-overlay", onmousedown: (e: MouseEvent) => e.target === overlay && close() }, box);
  const prevFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    overlay.remove();
    if (current?.overlay === overlay) current = null;
    prevFocus?.focus?.();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return close();
    onKeyExtra?.(e);
  });
  document.body.append(overlay);
  current = { kind, overlay, input, close };
  input.focus();
  return { input, list, close };
}

export function openPalette(shell: Shell, initial = ""): void {
  const wantCommands = initial.startsWith(">");
  // Same shortcut again: close. The other mode: switch the open palette instead of stacking one.
  if (current?.kind === "open") {
    const isCommands = current.input.value.startsWith(">");
    if (isCommands === wantCommands) return current.close();
    current.input.value = initial;
    current.input.dispatchEvent(new Event("input"));
    current.input.focus();
    return;
  }
  let items: Item[] = [];
  let sel = 0;
  const { input, list, close } = popover("open", "Search recipes and functions, or > for commands", "Quick open", (e) => {
    const shown = filtered();
    if (matches("Cmd+P", e)) (e.preventDefault(), e.stopPropagation(), openPalette(shell, ""));
    else if (matches("Cmd+Shift+P", e)) (e.preventDefault(), e.stopPropagation(), openPalette(shell, ">"));
    else if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); close(); shown[sel].run(); }
  });
  input.value = initial;
  const commands = (): Item[] => [...shell.commands.values()]
    .filter((c) => !INTERNAL.has(c.id))
    .sort((a, b) => {
      const ra = recent.indexOf(a.id), rb = recent.indexOf(b.id);
      return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb) || a.title.localeCompare(b.title);
    })
    .map((c) => ({
      label: c.title, detail: recent.includes(c.id) ? "recently used" : c.id, keys: keysFor(shell, c.id),
      run: () => {
        const at = recent.indexOf(c.id);
        if (at >= 0) recent.splice(at, 1);
        recent.unshift(c.id);
        return shell.executeCommand(c.id);
      },
    }));
  const filtered = () => {
    const raw = input.value;
    const cmd = raw.startsWith(">");
    const q = (cmd ? raw.slice(1) : raw).trim().toLowerCase();
    const pool = cmd ? commands() : items;
    return pool.filter((i) => !q || fuzzy(q, i.label.toLowerCase()) || i.detail.toLowerCase().includes(q)).slice(0, 80);
  };
  const draw = () => {
    clear(list);
    const shown = filtered();
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    shown.forEach((it, i) => list.append(h("button", { class: `it${i === sel ? " sel" : ""}`, role: "option", "aria-selected": String(i === sel), onclick: () => { close(); it.run(); } },
      h("span", { class: "pl-label" }, it.label), h("span", { class: "meta" }, it.detail), it.keys ? h("kbd", null, prettyKeys(it.keys)) : null)));
    if (!shown.length) list.append(h("div", { class: "empty" }, "Nothing matches."));
    (list.querySelector(".sel") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  };
  input.addEventListener("input", () => { sel = 0; draw(); });
  const flat = (es: any[]): any[] => es.flatMap((e) => (e.dir ? flat(e.children ?? []) : [e]));
  Promise.all([
    bh.invoke("ws:list", shell.paths.recipes).then(flat).catch(() => []),
    bh.invoke("ws:list", shell.paths.functions).then(flat).catch(() => []),
    shell.helperStatus.state === "ready" ? helper("functions.list", {}).catch(() => []) : Promise.resolve([]),
  ]).then(([recipes, fns, builtins]) => {
    items = [
      ...recipes.map((r: any) => ({ label: basename(r.path), detail: inFolder("recipe", shell.paths.recipes, r.path), run: () => shell.openFile(r.path) })),
      ...fns.map((f: any) => ({ label: basename(f.path), detail: inFolder("my function", shell.paths.functions, f.path), run: () => shell.openFile(f.path) })),
      ...builtins.filter((b) => b.origin === "builtin").map((b) => ({ label: `ƒ ${b.name}`, detail: `built-in · ${b.per}`, run: () => shell.executeCommand("function.show", b.name) })),
    ];
    draw();
  });
  draw();
}

/** "recipe · qwen/" for a file in a subfolder, plain "recipe" at the top level. */
function inFolder(kind: string, root: string, path: string): string {
  const rel = path.slice(root.length + 1);
  const i = rel.lastIndexOf("/");
  return i < 0 ? kind : `${kind} · ${rel.slice(0, i)}/`;
}

/** Find in files: every line in recipes and functions that contains the query. */
export function openSearch(shell: Shell): void {
  if (current?.kind === "search") return current.close();
  let sel = 0;
  let hits: { path: string; line: number; text: string }[] = [];
  const { input, list, close } = popover("search", "Find in recipes and functions", "Find in files", (e) => {
    if (matches("Cmd+Shift+F", e)) (e.preventDefault(), e.stopPropagation(), close());
    else if (e.key === "ArrowDown") { sel = Math.min(sel + 1, hits.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); close(); shell.openFile(hits[sel].path, hits[sel].line); }
  });
  const sel0 = shell.editor.view()?.editor.getModel() ? shell.editor.view()!.editor.getModel()!.getValueInRange(shell.editor.view()!.editor.getSelection()!) : "";
  if (sel0 && !sel0.includes("\n")) input.value = sel0;
  const draw = () => {
    clear(list);
    hits.slice(0, 200).forEach((x, i) => list.append(h("button", { class: `it${i === sel ? " sel" : ""}`, role: "option", onclick: () => { close(); shell.openFile(x.path, x.line); } },
      h("span", { class: "pl-label mono" }, x.text.trim().slice(0, 120)), h("span", { class: "meta" }, `${basename(x.path)}:${x.line}`))));
    if (input.value.trim() && !hits.length) list.append(h("div", { class: "empty" }, "No matches."));
    if (hits.length > 200) list.append(h("div", { class: "empty" }, `${hits.length - 200} more not shown.`));
    (list.querySelector(".sel") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  };
  const flat = (es: any[]): any[] => es.flatMap((e) => (e.dir ? flat(e.children ?? []) : [e]));
  let files: string[] | null = null;
  const run = debounce(async () => {
    const q = input.value.trim().toLowerCase();
    sel = 0;
    if (!q) return (hits = []), draw();
    files ??= [
      ...(await bh.invoke("ws:list", shell.paths.recipes).then(flat).catch(() => [])),
      ...(await bh.invoke("ws:list", shell.paths.functions).then(flat).catch(() => [])),
    ].map((f: any) => f.path).filter((p: string) => /\.(py|toml|md|json|txt)$/.test(p));
    const out: typeof hits = [];
    for (const path of files) {
      const text = await shell.workspace.readFile(path).catch(() => "");
      text.split("\n").forEach((t, i) => t.toLowerCase().includes(q) && out.push({ path, line: i + 1, text: t }));
    }
    if (input.value.trim().toLowerCase() === q) (hits = out), draw();
  }, 150);
  input.addEventListener("input", run);
  if (input.value) run();
  draw();
}
