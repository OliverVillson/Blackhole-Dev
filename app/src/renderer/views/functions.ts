// Named functions: every built-in as readable source, fork into functions/, overrides shown.

import { h, clear } from "../dom";
import { bh, helper } from "../bridge";
import { toast } from "../ui";
import type { Shell } from "../shell";
import type { FunctionInfo } from "../../shared/rpc";

export async function showFunction(shell: Shell, name: string): Promise<void> {
  const src = await helper("functions.source", { name });
  await shell.openFile(src.readonly ? `builtin:${name}.py` : src.path, undefined, { readonly: src.readonly, text: src.readonly ? src.text : undefined, title: src.readonly ? `ƒ ${name} (built-in)` : undefined });
}

export async function forkFunction(shell: Shell, name: string): Promise<void> {
  const r = await helper("functions.fork", { name });
  toast(`Forked ${name} into your functions. Your copy overrides the built-in in every recipe.`);
  await shell.executeCommand("recipes.refresh");
  await shell.openFile(r.path);
}

export function functionsView(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const body = h("div", { style: "display:flex;flex-direction:column;gap:2px" });
    const q = h("input", { placeholder: "Filter functions", "aria-label": "Filter functions", style: "width:100%" });
    el.append(h("div", { class: "view" },
      h("div", { class: "view-head" }, h("span", { class: "hd" }, "Named functions"), h("button", { class: "btn sm", onclick: () => shell.executeCommand("function.new") }, "+ Function")),
      h("div", { class: "meta", style: "padding:0 4px" }, "Every preset step is a function here. Fork one to change it; a function of yours with the same name replaces the built-in."),
      q, body));
    let fns: FunctionInfo[] = [];
    const render = () => {
      clear(body);
      if (shell.helperStatus.state !== "ready") return body.append(h("div", { class: "empty" }, "Functions load when the Python helper is ready."));
      const f = q.value.trim().toLowerCase();
      for (const origin of ["override", "user", "builtin"] as const) {
        const group = fns.filter((x) => x.origin === origin && (!f || x.name.includes(f) || x.doc.toLowerCase().includes(f)));
        if (!group.length) continue;
        body.append(h("div", { class: "hd", style: "padding:8px 4px 2px" }, origin === "builtin" ? "Built-in" : origin === "user" ? "Yours" : "Yours, overriding a built-in"));
        for (const x of group) {
          body.append(h("div", { class: "card", style: "padding:8px 10px;gap:4px;border-color:" + (origin === "builtin" ? "var(--line2)" : "var(--ash)") },
            h("div", { class: "row", style: "gap:8px;flex-wrap:nowrap" },
              h("span", { class: "fn" }, "ƒ"), h("span", { class: "mono", style: "color:var(--flare)" }, x.name),
              h("span", { class: "badge", style: "margin-left:auto" }, x.per)),
            x.doc ? h("div", { class: "meta" }, x.doc.split("\n")[0]) : null,
            x.usedBy?.length ? h("div", { class: "meta" }, `used by ${x.usedBy.join(", ")}`) : null,
            h("div", { class: "row", style: "gap:6px" },
              h("button", { class: "btn sm", onclick: () => showFunction(shell, x.name).catch((e) => toast(e.message, "error")) }, origin === "builtin" ? "View source" : "Open"),
              origin === "builtin" ? h("button", { class: "btn sm", onclick: () => forkFunction(shell, x.name).catch((e) => toast(e.message, "error")) }, "Fork") : null)));
        }
      }
      if (!body.childElementCount) body.append(h("div", { class: "empty" }, "No functions match."));
    };
    const load = () => helper("functions.list", {}).then((r) => { fns = r; render(); }).catch((e) => { clear(body); body.append(h("div", { class: "empty" }, `functions.list failed: ${e.message}`)); });
    q.addEventListener("input", render);
    bh.on("helper:status", (s: { state: string }) => (s.state === "ready" ? load() : render()));
    window.addEventListener("focus", () => shell.helperStatus.state === "ready" && load());
    if (shell.helperStatus.state === "ready") load();
    else render();
  };
}
