// Copilot side panel (plain DOM, like the shell). Layout follows the "copilot streaming"
// sketch: provider picker, control bar (Pause / Stop / Reject all / Accept all), the
// conversation with tool rows and "you changed …" notes, and the steer box.
import { ANTHROPIC_MODELS, LOCAL_PRESETS } from "../llm/catalog";
import type { ProviderSettings } from "./main";
import type { CopilotEvent, CopilotSession, CopilotState } from "./session";

export interface PanelDeps {
  session: CopilotSession;
  invoke(channel: string, ...args: any[]): Promise<any>;
  activeFile(): string | null;
  onActiveFile(cb: (f: string | null) => void): () => void;
}

const CSS = `
.cp{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg2);color:var(--text);font:13px/20px var(--font-ui)}
.cp-hd{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
.cp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cp-title{font:500 11px var(--font-display);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-right:auto}
.cp select,.cp input{height:26px;background:var(--void);color:var(--text);border:1px solid #3a1206;border-radius:4px;font:12px var(--font-ui);padding:0 6px;min-width:0}
.cp-chip{font:11px var(--font-mono);padding:3px 7px;border-radius:3px;background:#1a0703;color:var(--flare);border:1px solid #3a1206}
.cp-bar{display:none;align-items:center;gap:8px;padding:8px 16px;background:#1a0703;border-bottom:1px solid var(--ash);flex-wrap:wrap}
.cp-bar.on{display:flex}
.cp-bar .msg{font-size:12px;color:var(--photon);margin-right:auto}
.cp-dot{width:8px;height:8px;border-radius:50%;background:var(--ember);animation:cp-blink 1s steps(1) infinite}
@keyframes cp-blink{50%{opacity:0}}
.cp-btn{height:28px;padding:0 10px;border-radius:4px;border:1px solid var(--ash);background:#120603;color:var(--text);font:500 12px var(--font-ui);cursor:pointer}
.cp-btn:hover{border-color:var(--ember)}
.cp-btn.pri{background:var(--ember);border-color:var(--ember);color:var(--void)}
.cp-btn:disabled{opacity:.45;cursor:default}
.cp-log{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.cp-me{align-self:flex-end;max-width:85%;background:#1a0703;border:1px solid #3a1206;border-radius:8px;padding:8px 12px;white-space:pre-wrap}
.cp-me.steer{border-color:var(--flare)}
.cp-ai{white-space:pre-wrap;color:var(--photon)}
.cp-think{font-size:12px;color:var(--dim);font-style:italic}
.cp-tool{font:12px var(--font-mono);border:1px solid var(--line2);border-radius:5px;padding:6px 10px;background:var(--bg1);color:var(--dim)}
.cp-tool.ok::before{content:"✓ ";color:var(--flare)}
.cp-tool.error{border-color:var(--redshift);color:var(--text)}
.cp-tool.error::before{content:"✕ ";color:var(--redshift)}
.cp-tool.running::before,.cp-tool.waiting::before{content:"… ";color:var(--ember)}
.cp-tool.waiting{border-color:var(--ember);color:var(--text)}
.cp-edit{font:12px var(--font-mono);border:1px solid var(--flare);border-radius:5px;padding:6px 10px;color:var(--text)}
.cp-edit b{color:var(--flare);font-weight:600}
.cp-err{border:1px solid var(--redshift);border-radius:5px;padding:6px 10px;color:var(--text)}
.cp-ft{padding:12px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.cp-ft label{font-size:12px;color:var(--dim)}
.cp-ft textarea{resize:none;background:var(--void);color:var(--text);border:1px solid #3a1206;border-radius:6px;padding:8px 10px;font:13px var(--font-ui)}
.cp-ft textarea:focus,.cp input:focus,.cp select:focus{outline:1px solid var(--ember)}
.cp-note{font-size:11px;color:var(--dim);margin-right:auto}
.cp-key{display:none;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--ash);border-radius:6px;background:var(--bg1)}
.cp-key.on{display:flex}
.cp-key p{margin:0;font-size:12px;color:var(--dim)}
`;

const STATE_TEXT: Record<CopilotState, string> = {
  idle: "",
  thinking: "Copilot is thinking",
  writing: "Copilot is writing",
  paused: "Paused. Nothing more lands until you resume",
  tools: "Copilot is checking its work",
  error: "Copilot stopped with an error",
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderCopilotPanel(el: HTMLElement, deps: PanelDeps): () => void {
  const { session } = deps;
  const style = h("style", {}, CSS);
  const root = h("div", { class: "cp" });
  el.append(style, root);

  // Header: provider picker and context chips
  const hd = h("div", { class: "cp-hd" });
  const top = h("div", { class: "cp-row" });
  top.append(h("span", { class: "cp-title" }, "Copilot"));
  const provLabel = h("label", { class: "cp-row", style: "font-size:12px;color:var(--dim)" }, "Model ");
  const prov = h("select", { "aria-label": "Copilot model" });
  for (const m of ANTHROPIC_MODELS) prov.append(h("option", { value: `anthropic:${m.id}` }, `${m.label} · your API key`));
  for (const [id, p] of Object.entries(LOCAL_PRESETS)) prov.append(h("option", { value: `local:${id}` }, `Local · ${p.label} ${new URL(p.baseUrl).port ? ":" + new URL(p.baseUrl).port : ""}`));
  provLabel.append(prov);
  top.append(provLabel);

  const local = h("div", { class: "cp-row", style: "display:none" });
  const baseUrl = h("input", { "aria-label": "Local server URL", style: "flex:1" });
  const localModel = h("select", { "aria-label": "Local model", style: "flex:1" });
  const probeBtn = h("button", { class: "cp-btn" }, "Connect");
  local.append(baseUrl, localModel, probeBtn);

  const key = h("div", { class: "cp-key" });
  key.append(h("p", {}, "Paste your own Anthropic API key. It is stored in the macOS Keychain and only used from this Mac; BlackHole-Dev never bills you."));
  const keyRow = h("div", { class: "cp-row" });
  const keyIn = h("input", { type: "password", "aria-label": "Anthropic API key", placeholder: "sk-ant-…", style: "flex:1" });
  const keySave = h("button", { class: "cp-btn pri" }, "Save to Keychain");
  keyRow.append(keyIn, keySave);
  const keyMsg = h("p");
  key.append(keyRow, keyMsg);

  const chips = h("div", { class: "cp-row" });
  hd.append(top, local, key, chips);

  // Control bar
  const bar = h("div", { class: "cp-bar", role: "status" });
  const dot = h("span", { class: "cp-dot" });
  const barMsg = h("span", { class: "msg" });
  const pauseBtn = h("button", { class: "cp-btn" }, "Pause");
  const stopBtn = h("button", { class: "cp-btn" }, "Stop");
  // Accept / reject (per hunk and all) live in the shell's bar above the editor.
  bar.append(dot, barMsg, pauseBtn, stopBtn);

  const log = h("div", { class: "cp-log", "aria-live": "polite" });
  log.append(h("div", { class: "cp-think" }, "Ask for a recipe, e.g. “Make a recipe like qwen-mac-hex for Qwen3-30B-A3B: drop the weakest 25% of experts, keep the router frozen, int4 attention, bench on LCB.” You can type in the file while it writes; your lines are kept."));

  const ft = h("div", { class: "cp-ft" });
  const lab = h("label", { for: "cp-steer" }, "Ask the copilot");
  const ta = h("textarea", { id: "cp-steer", rows: "3", placeholder: "Describe the recipe you want" });
  const ftRow = h("div", { class: "cp-row" });
  ftRow.append(h("span", { class: "cp-note" }, "Copilot can read, plan and edit. Starting a VM or a run always needs your click."));
  const send = h("button", { class: "cp-btn pri" }, "Send");
  ftRow.append(send);
  ft.append(lab, ta, ftRow);

  root.append(hd, bar, log, ft);

  // ---- state ----
  let settings: ProviderSettings | null = null;
  let aiEl: HTMLElement | null = null;
  let thinkEl: HTMLElement | null = null;
  const toolEls = new Map<string, HTMLElement>();
  let writingFile = "";

  const scroll = () => (log.scrollTop = log.scrollHeight);
  const add = (e: HTMLElement) => {
    log.append(e);
    scroll();
    return e;
  };

  function refreshChips() {
    chips.textContent = "";
    const f = deps.activeFile();
    if (f) chips.append(h("span", { class: "cp-chip" }, `@${f.split("/").pop()}`));
    chips.append(h("span", { class: "cp-chip" }, "@functions"), h("span", { class: "cp-chip" }, "@anatomy"));
  }

  function setBar(state: CopilotState, detail?: string) {
    const busy = session.busy;
    bar.classList.toggle("on", busy || state === "error");
    dot.style.visibility = busy && state !== "paused" ? "visible" : "hidden";
    const where = state === "writing" && (detail || writingFile) ? ` · ${(detail || writingFile).split("/").pop()}` : "";
    barMsg.textContent = busy ? `${STATE_TEXT[state]}${where}` : STATE_TEXT.error;
    pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
    pauseBtn.disabled = !busy;
    stopBtn.disabled = !busy;
    lab.textContent = busy ? "Steer while it writes" : "Ask the copilot";
    ta.placeholder = busy ? "e.g. use 64 calibration samples from my own data" : "Describe the recipe you want";
    send.textContent = busy ? "Steer" : "Send";
  }

  function onEvent(e: CopilotEvent) {
    switch (e.type) {
      case "state":
        if (e.state === "writing" && e.detail) writingFile = e.detail;
        setBar(e.state, e.detail);
        if (e.state !== "thinking") thinkEl = null;
        break;
      case "user-message":
        aiEl = null;
        thinkEl = null;
        add(h("div", { class: e.steer ? "cp-me steer" : "cp-me" }, e.text));
        break;
      case "prose":
        if (!e.text.trim() && !aiEl) break;
        if (!aiEl) aiEl = add(h("div", { class: "cp-ai" }));
        aiEl.textContent += e.text;
        scroll();
        break;
      case "reasoning":
        if (!thinkEl) thinkEl = add(h("div", { class: "cp-think" }, "Thinking… "));
        break;
      case "write":
        aiEl = null;
        if (e.status === "start") add(h("div", { class: "cp-tool running" }, `writing ${e.file}`));
        else add(h("div", { class: e.status === "done" ? "cp-tool ok" : "cp-tool error" }, `${e.status === "done" ? "wrote" : "stopped writing"} ${e.file}`));
        break;
      case "tool": {
        aiEl = null;
        let t = toolEls.get(e.id);
        if (!t) {
          t = add(h("div"));
          toolEls.set(e.id, t);
        }
        t.className = `cp-tool ${e.status}`;
        t.textContent = e.summary;
        scroll();
        break;
      }
      case "user-edit": {
        aiEl = null;
        const row = add(h("div", { class: "cp-edit" }));
        const b = h("b", {}, `↻ you changed line${e.endLine > e.startLine ? `s ${e.startLine}-${e.endLine}` : ` ${e.startLine}`}`);
        row.append(b, document.createTextNode(session.busy ? " · kept, the copilot will adapt when it finishes" : " · kept"));
        break;
      }
      case "error":
        add(h("div", { class: "cp-err" }, e.message));
        break;
      case "usage":
        break;
    }
  }

  // ---- provider settings ----
  async function loadSettings() {
    settings = await deps.invoke("copilot:settings");
    if (!settings) return;
    if (settings.provider === "anthropic") prov.value = `anthropic:${settings.model}`;
    else {
      prov.value = settings.preset === "custom" ? "local:mlx" : `local:${settings.preset}`;
      baseUrl.value = settings.baseUrl;
      localModel.replaceChildren(h("option", { value: settings.model }, settings.model || "(pick a model)"));
    }
    await syncProviderUi();
  }

  async function syncProviderUi() {
    const isLocal = prov.value.startsWith("local:");
    local.style.display = isLocal ? "flex" : "none";
    key.classList.toggle("on", !isLocal && !(await deps.invoke("copilot:hasKey")));
  }

  async function saveSettings(s: ProviderSettings) {
    settings = await deps.invoke("copilot:setSettings", s);
  }

  prov.addEventListener("change", async () => {
    const [kind, id] = prov.value.split(":");
    if (kind === "anthropic") {
      await saveSettings({ provider: "anthropic", model: id, effort: settings?.provider === "anthropic" ? settings.effort : "high" });
    } else {
      const preset = id as keyof typeof LOCAL_PRESETS;
      baseUrl.value = LOCAL_PRESETS[preset].baseUrl;
      await saveSettings({ provider: "openai-compatible", preset, baseUrl: baseUrl.value, model: localModel.value || "" });
      void connectLocal();
    }
    await syncProviderUi();
  });

  async function connectLocal() {
    probeBtn.disabled = true;
    probeBtn.textContent = "Connecting…";
    const r = await deps.invoke("copilot:probe", baseUrl.value);
    probeBtn.disabled = false;
    probeBtn.textContent = r.ok ? `Connected · ${r.latencyMs} ms` : "Retry";
    if (r.ok) {
      const cur = settings?.provider === "openai-compatible" ? settings.model : "";
      localModel.replaceChildren(...r.models.map((m: string) => h("option", { value: m }, m)));
      if (cur && r.models.includes(cur)) localModel.value = cur;
      await saveLocal();
    } else {
      add(h("div", { class: "cp-err" }, `No local server at ${baseUrl.value} (${r.message ?? "unreachable"}). Start mlx_lm.server, llama.cpp or Ollama, then Retry.`));
    }
  }

  async function saveLocal() {
    const id = prov.value.split(":")[1] as keyof typeof LOCAL_PRESETS;
    await saveSettings({ provider: "openai-compatible", preset: baseUrl.value === LOCAL_PRESETS[id]?.baseUrl ? id : "custom", baseUrl: baseUrl.value, model: localModel.value });
  }

  probeBtn.addEventListener("click", () => void connectLocal());
  localModel.addEventListener("change", () => void saveLocal());
  baseUrl.addEventListener("change", () => void saveLocal());

  keySave.addEventListener("click", async () => {
    keySave.disabled = true;
    keyMsg.textContent = "Checking the key…";
    const r = await deps.invoke("copilot:setKey", keyIn.value);
    keySave.disabled = false;
    keyIn.value = "";
    keyMsg.textContent = r.ok ? "Saved to Keychain." : r.message;
    if (r.ok) setTimeout(() => void syncProviderUi(), 800);
  });

  // ---- controls ----
  function submit() {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    if (session.busy) session.steer(text);
    else void session.ask(text);
  }
  send.addEventListener("click", submit);
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });
  pauseBtn.addEventListener("click", () => (session.state === "paused" ? session.resume() : session.pause()));
  stopBtn.addEventListener("click", () => session.stop());

  const offEv = session.on(onEvent);
  const offFile = deps.onActiveFile(refreshChips);
  refreshChips();
  setBar(session.state);
  void loadSettings();

  return () => {
    offEv();
    offFile();
    el.replaceChildren();
  };
}

/** Focus the ask box (Cmd+I). */
export function focusCopilot(el: HTMLElement): void {
  el.querySelector<HTMLTextAreaElement>("#cp-steer")?.focus();
}
