// Full-tab pages the shell owns: Welcome (checks, quick start) and Recipe overview.

import { h, clear, basename } from "./dom";
import { helper } from "./bridge";
import { renderChecks } from "./views/settings";
import { stepChain } from "./panels/plan";
import type { Shell } from "./shell";

const LOGO = String.raw`
        .  *   .        .
    .      _.--""--._       *
  *     .'   .--.    '.   .
       /   .'    '.    \
  .   ;   :  ()  :   ;    .
       \   '.    .'   /
    *   '.   '--'   .'  *
   .      '-.____.-'     .
`;

export function welcomeTab(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const checks = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
    el.append(h("div", { class: "page" },
      h("div", { class: "row", style: "gap:28px;align-items:center;flex-wrap:nowrap" },
        h("pre", { class: "logo-ascii", "aria-hidden": "true" }, LOGO),
        h("div", null, h("div", { class: "hd" }, "BlackHole-Harness"), h("h1", null, "BlackHole-Dev"),
          h("div", { class: "meta", style: "font-size:14px" }, "Write recipes in Python. Plan them on headers alone. Run them on your own VM."))),
      h("div", { class: "row" },
        h("button", { class: "btn pri", onclick: () => shell.executeCommand("recipe.new") }, "New recipe"),
        h("button", { class: "btn", onclick: () => shell.executeCommand("recipe.importToml") }, "Import TOML schema"),
        h("button", { class: "btn", onclick: () => shell.executeCommand("recipe.fromPreset") }, "Start from a preset"),
        h("button", { class: "btn", onclick: () => shell.showActivity("functions") }, "Browse built-in functions")),
      h("div", null, h("div", { class: "hd", style: "margin-bottom:10px" }, "Checks"), checks),
      h("div", { class: "meta" }, `Workspace: ${shell.paths.workspace}`)));
    renderChecks(checks);
  };
}

export function overviewTab(shell: Shell): (el: HTMLElement, state: { path: string }) => () => void {
  return (el, state) => {
    const page = h("div", { class: "page" });
    el.append(page);
    const disposers: (() => void)[] = [];
    const draw = async () => {
      clear(page);
      const name = basename(state.path).replace(/\.py$/, "");
      page.append(h("div", { class: "row", style: "align-items:flex-end;gap:16px" },
        h("div", { style: "flex:1;min-width:280px" }, h("div", { class: "hd" }, "Recipe overview"), h("h1", null, name), h("div", { class: "meta overview-doc", style: "font-size:14px" }, "")),
        h("button", { class: "btn", onclick: () => shell.openFile(state.path) }, "Open code"),
        h("button", { class: "btn", onclick: async () => { await shell.openFile(state.path); shell.executeCommand("recipe.plan"); } }, "Plan"),
        shell.commands.has("blackhole.runOnVm") ? h("button", { class: "btn pri", onclick: () => shell.executeCommand("blackhole.runOnVm", state.path) }, "Run on VM ▸") : null));
      const steps = h("div", null, h("div", { class: "hd", style: "margin-bottom:10px" }, "Steps (read from the recipe file)"));
      page.append(steps);
      try {
        const text = await shell.workspace.readFile(state.path);
        const r = await helper("recipe.steps", { path: state.path, text });
        (page.querySelector(".overview-doc") as HTMLElement).textContent = [r.doc?.split("\n")[0], [r.base, r.target].filter(Boolean).join(" → ")].filter(Boolean).join(" · ");
        steps.append(stepChain(shell, state.path, r.steps));
      } catch (e) {
        steps.append(h("div", { class: "empty" }, `Steps unavailable: ${(e as Error).message}`));
      }
      for (const s of [...shell.overviewSections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))) {
        const box = h("div");
        page.append(h("div", null, h("div", { class: "hd", style: "margin-bottom:10px" }, s.title), box));
        const d = s.render(box, state.path);
        if (typeof d === "function") disposers.push(d);
      }
    };
    draw();
    return () => disposers.forEach((d) => d());
  };
}
