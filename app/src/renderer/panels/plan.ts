// PLAN panel: dry run of the active recipe on a chosen device (headers only).

import { h, clear, basename } from "../dom";
import { helper } from "../bridge";
import { toast } from "../ui";
import type { Shell } from "../shell";
import type { Device, PlanResult, StepInfo } from "../../shared/rpc";

export function stepChain(shell: Shell, file: string, steps: StepInfo[]): HTMLElement {
  const box = h("div", { class: "steps" });
  steps.forEach((s, i) => {
    if (i) box.append(h("span", { class: "arr", "aria-hidden": "true" }, "→"));
    box.append(h("button", { class: `step${s.user ? " user" : ""}`, title: s.line ? `line ${s.line}` : undefined, onclick: () => s.line && shell.openFile(file, s.line) },
      h("b", null, s.kind === "function" || s.user ? `ƒ ${s.fn}` : s.name), h("span", null, s.user ? "your function" : s.detail || s.fn)));
  });
  return box;
}

export class PlanPanel {
  private device = h("select", { "aria-label": "Plan for device", style: "height:24px" });
  private body = h("div", { style: "padding:10px 16px 14px;display:flex;flex-direction:column;gap:10px" });
  private last: { file: string; result: PlanResult; ms: number } | null = null;

  constructor(private shell: Shell) {}

  render(el: HTMLElement): void {
    el.append(h("div", { class: "row", style: "padding:8px 16px 0;gap:10px" },
      h("span", { class: "meta" }, "device"), this.device,
      h("button", { class: "btn sm", onclick: () => this.run() }, "Plan now")), this.body);
    this.device.addEventListener("change", () => this.run());
    this.loadDevices();
    this.draw();
  }

  async loadDevices(): Promise<void> {
    if (this.shell.helperStatus.state !== "ready") return;
    try {
      const { devices } = await helper("recipe.devices", {});
      this.setDevices(devices);
    } catch {
      this.setDevices([{ id: "mac16", label: "Mac 16 GB", memGb: 16 }]);
    }
  }

  private setDevices(ds: Device[]): void {
    const keep = this.device.value;
    clear(this.device);
    for (const d of ds) this.device.append(h("option", { value: d.id }, `${d.label} (${d.memGb} GB)`));
    if (keep && ds.some((d) => d.id === keep)) this.device.value = keep;
  }

  async run(): Promise<void> {
    const file = this.shell.activeFile();
    if (!this.shell.isRecipe(file)) return toast("Open a recipe to plan it.", "warn");
    this.shell.showPanel("plan");
    if (this.shell.helperStatus.state !== "ready") return toast("The Python helper is not ready yet.", "warn");
    if (!this.device.value) await this.loadDevices();
    const b = this.shell.editor.buffers.get(file);
    clear(this.body);
    this.body.append(h("div", { class: "meta" }, `planning ${basename(file)}…`));
    const t0 = performance.now();
    try {
      const result = await helper("recipe.plan", { path: file, text: b?.model.getValue(), device: this.device.value || "mac16" });
      this.last = { file, result, ms: performance.now() - t0 };
      this.shell.setProblems(file, result.problems);
    } catch (e) {
      this.last = null;
      clear(this.body);
      this.body.append(h("div", { class: "tone-bad" }, `Plan failed: ${(e as Error).message}`));
      return;
    }
    this.draw();
  }

  private draw(): void {
    clear(this.body);
    const l = this.last;
    if (!l) {
      this.shell.panelNote.textContent = "";
      this.body.append(h("div", { class: "empty" }, "Plan runs the recipe as a dry run: size, fit, KV cache and time, from headers only. Cmd+Shift+P."));
      return;
    }
    this.shell.panelNote.textContent = `dry run · headers only, no weights read · ${(l.ms / 1000).toFixed(1)} s`;
    const r = l.result;
    for (const row of r.rows) this.body.append(h("div", { class: "kv" }, h("span", null, row.label), h("span", { class: row.tone ? `tone-${row.tone}` : undefined }, row.value)));
    if (r.fits !== null && r.fits !== undefined && !r.rows.some((x) => /fit/i.test(x.label)))
      this.body.append(h("div", { class: "kv" }, h("span", null, "fits"), h("span", { class: r.fits ? "tone-ok" : "tone-bad" }, r.fits ? "✓ yes" : "✕ no")));
    if (r.steps?.length) this.body.append(stepChain(this.shell, l.file, r.steps));
    if (r.problems.length) this.body.append(h("button", { class: "btn sm", style: "align-self:flex-start", onclick: () => this.shell.showPanel("problems") }, `${r.problems.length} problem${r.problems.length > 1 ? "s" : ""}`));
  }
}

export function problemsPanel(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const draw = () => {
      clear(el);
      const all = [...shell.problems.entries()];
      if (!all.length) return el.append(h("div", { class: "empty", style: "padding:10px 16px" }, "No problems in open recipes."));
      for (const [file, ps] of all) {
        el.append(h("div", { class: "meta", style: "padding:6px 16px 2px" }, basename(file)));
        for (const p of ps)
          el.append(h("button", { class: "prob", onclick: () => shell.openFile(file, p.line) },
            h("span", { class: `sev-${p.severity}` }, p.severity === "error" ? "✕" : p.severity === "warning" ? "⚠" : "ℹ"),
            h("span", null, p.message), h("span", { class: "meta" }, `${p.code ? p.code + " · " : ""}line ${p.line}`)));
      }
    };
    shell.onProblems(draw);
    draw();
  };
}
