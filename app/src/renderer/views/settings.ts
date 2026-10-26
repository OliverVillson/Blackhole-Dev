// Settings: Python, workspace, keys (Keychain), licence, first-run checks, module sections.

import { h, clear } from "../dom";
import { bh } from "../bridge";
import { toast } from "../ui";
import { prettyKeys } from "../keys";
import { KEYMAP, EDITOR_KEYS } from "../shortcuts";
import type { Shell } from "../shell";
import type { Licence } from "../../shared/ext";

interface Check { id: string; label: string; ok: boolean; detail: string; fix?: string }

export function renderChecks(el: HTMLElement): Promise<void> {
  clear(el);
  el.classList.add("checks");
  el.append(h("div", { class: "meta" }, "Checking…"));
  return bh.invoke<Check[]>("app:checks").then((cs) => {
    clear(el);
    for (const c of cs)
      el.append(h("div", { class: "check" },
        h("span", { class: c.ok ? "tone-ok" : "tone-bad", "aria-label": c.ok ? "ok" : "problem" }, c.ok ? "✓" : "✕"),
        h("span", null, c.label),
        h("span", { class: "meta" }, c.detail, !c.ok && c.fix ? h("span", { style: "color:var(--text)" }, ` · fix: ${c.fix}`) : null)));
  });
}

export function settingsView(shell: Shell): (el: HTMLElement) => void {
  return (el) => {
    const view = h("div", { class: "view", style: "gap:14px" });
    el.append(view);
    const section = (title: string, ...children: (Node | null)[]) => h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("div", { class: "hd", style: "padding:0 4px" }, title), ...children);

    const python = h("input", { placeholder: "python3 (bundled runtime when empty)", "aria-label": "Python path", style: "width:100%" });
    bh.invoke<string>("settings:get", "python.path", "").then((v) => (python.value = v));
    const keyState = h("span", { class: "meta" });
    const key = h("input", { type: "password", placeholder: "sk-ant-…", "aria-label": "Anthropic API key", style: "width:100%", autocomplete: "off" });
    const refreshKey = () => bh.invoke<boolean>("secrets:has", "anthropic-api-key").then((has) => (keyState.textContent = has ? "key set (stored in the macOS Keychain)" : "no key yet"));
    const licence = h("div", { class: "meta" });
    bh.invoke<{ licence: Licence; version: string }>("app:info").then((i) => (licence.textContent = `BlackHole-Dev ${i.version} · licence: ${i.licence.ok ? "active" : "inactive"} (${i.licence.reason ?? i.licence.tier})`));
    const checks = h("div", { style: "display:flex;flex-direction:column;gap:4px;padding:0 4px" });

    view.append(
      h("div", { class: "view-head" }, h("span", { class: "hd" }, "Settings")),
      section("Python helper", python,
        h("div", { class: "row" },
          h("button", { class: "btn sm", onclick: async () => { await bh.invoke("settings:set", "python.path", python.value.trim()); toast("Restarting the helper with this Python"); } }, "Save and restart"),
          h("button", { class: "btn sm", onclick: () => bh.invoke("helper:restart") }, "Restart helper"))),
      section("Workspace", h("div", { class: "mono", style: "padding:0 4px;word-break:break-all" }, shell.paths.workspace),
        h("div", { class: "row" }, h("button", { class: "btn sm", onclick: () => bh.invoke("ws:chooseFolder") }, "Choose folder… (restarts)"),
          h("button", { class: "btn sm", onclick: () => bh.invoke("app:reveal", shell.paths.recipes) }, "Reveal in Finder"))),
      section("Copilot key (bring your own)", key, h("div", { class: "row" },
        h("button", { class: "btn sm", onclick: async () => {
          if (!key.value.trim()) return;
          await bh.invoke("secrets:set", "anthropic-api-key", key.value.trim());
          key.value = "";
          refreshKey();
          toast("Key saved to the Keychain");
        } }, "Save key"),
        h("button", { class: "btn sm", onclick: async () => { await bh.invoke("secrets:delete", "anthropic-api-key"); refreshKey(); } }, "Remove")), keyState,
        h("div", { class: "meta", style: "padding:0 4px" }, "Your key never leaves this Mac except in requests to Anthropic. There is no billing through the app.")),
      section("Keyboard shortcuts", shortcutsList(shell)),
      section("Licence", licence),
      section("Checks", checks, h("div", { class: "row" }, h("button", { class: "btn sm", onclick: () => renderChecks(checks) }, "Run checks again"))),
    );
    const sorted = [...shell.settingsSections].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    for (const s of sorted) {
      const box = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
      view.append(section(s.title, box));
      s.render(box);
    }
    refreshKey();
    renderChecks(checks);
  };
}

function shortcutsList(shell: Shell): HTMLElement {
  const filter = h("input", { placeholder: "Filter shortcuts", "aria-label": "Filter shortcuts", style: "width:100%" });
  const list = h("div", { class: "keys-list" });
  const rows: [string, string, string?][] = [
    ...KEYMAP.map((b) => [b.keys, b.label ?? shell.commands.get(b.command)?.title ?? b.command, b.note] as [string, string, string?]),
    ...[...shell.commands.values()].filter((c) => c.keybinding && !KEYMAP.some((b) => b.keys === c.keybinding)).map((c) => [c.keybinding!, c.title] as [string, string]),
    ...EDITOR_KEYS.map(([k, what]) => [k, what, "editor"] as [string, string, string]),
  ];
  const draw = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    for (const [keys, what, note] of rows) {
      if (q && !what.toLowerCase().includes(q) && !keys.toLowerCase().includes(q)) continue;
      list.append(h("div", { class: "keys-row", title: note && note !== "editor" ? note : "" },
        h("span", { class: "keys-what" }, what, note && note !== "editor" ? h("span", { class: "meta" }, " *") : null),
        h("kbd", null, prettyKeys(keys))));
    }
  };
  filter.addEventListener("input", draw);
  draw();
  return h("div", { style: "display:flex;flex-direction:column;gap:6px;padding:0 4px" }, filter, list,
    h("div", { class: "meta" }, "* hover for a note. macOS keeps Cmd+Tab for its app switcher, so use Cmd+Ctrl+Tab or Cmd+1…9 to move between editor groups."));
}
