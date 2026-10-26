// Model anatomy: open a model (headers only), browse layers/experts/heads, inspect one part,
// insert its path into the recipe.

import { h, clear } from "../dom";
import { bh, helper } from "../bridge";
import { toast } from "../ui";
import type { Shell } from "../shell";
import type { AnatomyNode, AnatomyPart, AnatomySummary } from "../../shared/rpc";

export class Anatomy {
  summary: AnatomySummary | null = null;
  part: AnatomyPart | null = null;
  private cbs = new Set<() => void>();

  constructor(private shell: Shell) {}

  on(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  private emit(): void {
    this.cbs.forEach((cb) => cb());
  }

  async open(model: string): Promise<void> {
    await helper("anatomy.open", { model });
    this.summary = await helper("anatomy.summary", {});
    this.part = null;
    this.emit();
  }

  async select(query: string): Promise<void> {
    this.part = await helper("anatomy.get", { query });
    this.emit();
    this.shell.showRight("anatomy");
  }

  sidebar(): (el: HTMLElement) => void {
    return (el) => {
      const input = h("input", { placeholder: "Hub id or local folder, e.g. Qwen/Qwen3-30B-A3B", "aria-label": "Model to open", style: "width:100%" });
      const tree = h("div", { style: "display:flex;flex-direction:column" });
      const go = () => {
        const v = input.value.trim();
        if (!v) return;
        this.open(v).catch((e) => toast(`Could not open ${v}: ${e.message}`, "error"));
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && go());
      const local = h("div", { style: "display:flex;flex-direction:column" });
      el.append(h("div", { class: "view" },
        h("div", { class: "view-head" }, h("span", { class: "hd" }, "Model anatomy")),
        h("div", { class: "row", style: "flex-wrap:nowrap" }, input, h("button", { class: "btn", onclick: go }, "Open")),
        h("div", { class: "meta", style: "padding:0 4px" }, "Opens headers only; no weights are read until a recipe runs."),
        h("div", { class: "hd", style: "padding:8px 4px 0" }, "Models folder"), local,
        h("div", { class: "hd", style: "padding:8px 4px 0" }, "Structure"), tree));
      const renderLocal = async () => {
        clear(local);
        try {
          const es = await bh.invoke<{ path: string; name: string; dir: boolean }[]>("ws:list", this.shell.paths.models);
          const dirs = es.filter((e) => e.dir);
          if (!dirs.length) local.append(h("div", { class: "empty" }, "Downloaded and finished models appear here."));
          for (const d of dirs) local.append(h("button", { class: "it", onclick: () => { input.value = d.path; go(); } }, d.name, h("span", { class: "meta" }, "local")));
        } catch { /* models folder missing */ }
      };
      const renderTree = () => {
        clear(tree);
        const s = this.summary;
        if (!s) return tree.append(h("div", { class: "empty" }, "Open a model to see its layers, routers and experts."));
        tree.append(h("div", { class: "meta", style: "padding:0 8px 4px" }, `${s.name} · ${s.layers} layers${s.expertsPerLayer ? ` · ${s.expertsPerLayer} experts/layer` : ""}${s.topK ? ` · top-${s.topK}` : ""}`));
        const node = (n: AnatomyNode, depth: number): HTMLElement => {
          const kids = h("div", { style: "display:none;flex-direction:column" });
          let open = false;
          const row = h("button", { class: "it", style: `padding-left:${8 + depth * 14}px`, title: n.path, onclick: () => {
            if (n.children?.length) {
              open = !open;
              kids.style.display = open ? "flex" : "none";
              caret.textContent = open ? "▾" : "▸";
              if (open && !kids.childElementCount) n.children.forEach((c) => kids.append(node(c, depth + 1)));
            }
            this.select(n.path).catch((e) => toast(e.message, "error"));
          } });
          const caret = h("span", { class: "meta", style: "width:10px;margin:0" }, n.children?.length ? "▸" : "");
          row.append(caret, h("span", null, n.label), h("span", { class: "meta" }, n.kind));
          return h("div", null, row, kids);
        };
        s.tree.forEach((n) => tree.append(node(n, 0)));
      };
      this.on(renderTree);
      renderTree();
      renderLocal();
    };
  }

  panel(): (el: HTMLElement) => void {
    return (el) => {
      const body = h("div", { style: "padding:14px 16px;display:flex;flex-direction:column;gap:14px" });
      el.append(body);
      const render = () => {
        clear(body);
        const s = this.summary;
        body.append(h("div", { class: "row", style: "justify-content:space-between" }, h("span", { class: "hd" }, "Anatomy"), h("span", { class: "meta" }, s?.name ?? "no model open")));
        if (!s) {
          body.append(h("div", { class: "meta", style: "line-height:18px" }, "Open a model from the Anatomy view in the activity bar. Click any layer, head, router or expert to see it here."),
            h("button", { class: "btn", onclick: () => this.shell.showActivity("anatomy") }, "Open a model"));
          return;
        }
        body.append(h("div", { class: "meta", style: "line-height:18px" }, `${s.layers} layers${s.expertsPerLayer ? ` · ${s.expertsPerLayer} experts per layer` : ""}${s.topK ? ` · top-${s.topK} routing` : ""} · ${s.kind}`));
        if (s.layerScores?.length) {
          const max = Math.max(...s.layerScores, 1e-9);
          const bars = h("div", { class: "bars", role: "img", "aria-label": "Mean REAP score per layer" });
          s.layerScores.forEach((v, i) => {
            const r = v / max;
            bars.append(h("div", { title: `L${i}: ${v.toFixed(3)}`, style: `height:${Math.max(2, Math.round(r * 70))}px;background:${r > 0.75 ? "var(--ember)" : r > 0.5 ? "var(--redshift)" : "var(--ash)"}` }));
          });
          body.append(h("div", null, h("div", { style: "font-size:12px;margin-bottom:6px" }, "Mean REAP score per layer"), bars,
            h("div", { class: "row meta", style: "justify-content:space-between;font-size:11px;margin-top:4px" }, h("span", null, "L0"), h("span", null, `L${s.layerScores.length - 1}`))));
        }
        const p = this.part;
        if (p) {
          body.append(h("div", { class: "card" },
            h("div", { class: "mono", style: "color:var(--flare)" }, p.path),
            ...p.rows.map(([k, v]) => h("div", { class: "kv" }, h("span", null, k), h("span", null, v))),
            h("div", { class: "row", style: "margin-top:4px" },
              h("button", { class: "btn", disabled: !this.shell.activeFile(), onclick: () => this.shell.editor.insertAtCursor(p.insert) }, "Insert path"),
              h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(p.insert).then(() => toast("Copied")) }, "Copy"))));
        }
        body.append(h("div", { class: "meta", style: "line-height:18px" }, "Every edit in the recipe shows up in Plan before anything runs."));
      };
      this.on(render);
      this.shell.workspace.onActiveFile(render);
      render();
    };
  }
}
