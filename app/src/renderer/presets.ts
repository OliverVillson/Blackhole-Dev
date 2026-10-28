// "Start from a preset": the preset recipe files that ship with blackhole_dev (plain recipe
// files built from named functions, plus recipes written from scratch), and the pipeline's
// catalog presets that have no file yet, converted on pick. The pick is copied into the user's
// recipes folder and opened.

import { helper } from "./bridge";
import { h } from "./dom";
import { showModal, toast } from "./ui";
import type { Shell } from "./shell";
import type { PresetFile } from "../shared/rpc";

interface Row { title: string; id: string; description: string; group: string; pick(): Promise<{ path: string }> }

export async function pickPreset(shell: Shell): Promise<void> {
  const [files, catalog] = await Promise.all([
    helper("recipe.presetFiles", {}).then((r) => r.presets).catch(() => [] as PresetFile[]),
    helper("recipe.presets", {}).then((r) => r.presets).catch(() => []),
  ]);
  const have = new Set(files.map((f) => f.id));
  const rows: Row[] = [
    ...files.map((f) => ({ title: f.title, id: f.id, description: f.description, group: f.group === "preset" ? "Preset recipes" : "Written from scratch",
      pick: () => helper("recipe.copyPreset", { file: f.file }) })),
    ...catalog.filter((c) => !have.has(c.id)).map((c) => ({ title: c.name, id: c.id, description: c.summary, group: "Pipeline presets (converted on pick)",
      pick: () => helper("recipe.fromPreset", { id: c.id }) })),
  ];
  if (!rows.length) return toast("No presets found: is blackhole_dev installed for the Python in Settings?", "warn");
  showModal({
    title: "Start from a preset",
    width: 640,
    render(el, close) {
      const search = h("input", { placeholder: "Filter presets", "aria-label": "Filter presets", style: "width:100%" }) as HTMLInputElement;
      const list = h("div", { class: "preset-list", role: "listbox" });
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        list.replaceChildren();
        let group = "";
        for (const r of rows) {
          if (q && !`${r.title} ${r.id} ${r.description}`.toLowerCase().includes(q)) continue;
          if (r.group !== group) list.append(h("div", { class: "preset-group" }, (group = r.group)));
          list.append(h("button", {
            class: "preset", role: "option", title: r.description,
            onclick: async () => {
              close();
              const out = await r.pick().catch((e) => toast(String((e as Error).message ?? e), "error"));
              if (!out) return;
              await shell.executeCommand("recipes.refresh");
              shell.openFile(out.path);
            },
          }, h("span", { class: "preset-title" }, r.title, h("span", { class: "meta" }, ` ${r.id}`)),
          h("span", { class: "preset-desc" }, r.description)));
        }
        if (!list.childElementCount) list.append(h("div", { class: "meta" }, "No preset matches."));
      };
      search.addEventListener("input", draw);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") (list.querySelector(".preset") as HTMLButtonElement | null)?.click();
      });
      draw();
      el.append(search, list);
    },
  });
}
