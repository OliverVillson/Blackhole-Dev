// Quick open (Cmd+P): recipes, functions, built-ins; ">" switches to commands.

import { h, clear, basename } from "./dom";
import { bh, helper } from "./bridge";
import type { Shell } from "./shell";

interface Item { label: string; detail: string; run: () => unknown }

export function openPalette(shell: Shell): void {
  const input = h("input", { placeholder: "Search recipes and functions, or > for commands", "aria-label": "Quick open" });
  const list = h("div", { class: "palette-list", role: "listbox" });
  let items: Item[] = [];
  let sel = 0;
  const overlay = h("div", { class: "overlay", onmousedown: (e: MouseEvent) => e.target === overlay && close() }, h("div", { class: "modal palette" }, input, list));
  const close = () => overlay.remove();
  const filtered = () => {
    const raw = input.value;
    const cmd = raw.startsWith(">");
    const q = (cmd ? raw.slice(1) : raw).trim().toLowerCase();
    const pool = cmd
      ? [...shell.commands.values()].map((c) => ({ label: c.title, detail: c.keybinding ?? c.id, run: () => shell.executeCommand(c.id) }))
      : items;
    return pool.filter((i) => !q || i.label.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q)).slice(0, 60);
  };
  const draw = () => {
    clear(list);
    const shown = filtered();
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    shown.forEach((it, i) => list.append(h("button", { class: `it${i === sel ? " sel" : ""}`, role: "option", "aria-selected": String(i === sel), onclick: () => { close(); it.run(); } },
      h("span", null, it.label), h("span", { class: "meta" }, it.detail))));
    if (!shown.length) list.append(h("div", { class: "empty" }, "Nothing matches."));
  };
  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    const shown = filtered();
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[sel]) { close(); shown[sel].run(); }
    else if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  input.focus();
  const flat = (es: any[]): any[] => es.flatMap((e) => (e.dir ? flat(e.children ?? []) : [e]));
  Promise.all([
    bh.invoke("ws:list", shell.paths.recipes).then(flat).catch(() => []),
    bh.invoke("ws:list", shell.paths.functions).then(flat).catch(() => []),
    shell.helperStatus.state === "ready" ? helper("functions.list", {}).catch(() => []) : Promise.resolve([]),
  ]).then(([recipes, fns, builtins]) => {
    items = [
      ...recipes.map((r: any) => ({ label: basename(r.path), detail: "recipe", run: () => shell.openFile(r.path) })),
      ...fns.map((f: any) => ({ label: basename(f.path), detail: "my function", run: () => shell.openFile(f.path) })),
      ...builtins.filter((b) => b.origin === "builtin").map((b) => ({ label: `ƒ ${b.name}`, detail: `built-in · ${b.per}`, run: () => shell.executeCommand("function.show", b.name) })),
    ];
    draw();
  });
  draw();
}
