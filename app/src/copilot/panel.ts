// Copilot side panel (plain DOM, like the shell). Layout follows the "copilot streaming"
// sketch: provider picker, control bar (Pause / Stop / Reject all / Accept all), the
// conversation with tool rows and "you changed …" notes, and the steer box.
import { ANTHROPIC_MODELS, CLAUDE_CODE_MODELS, EFFORTS, LOCAL_PRESETS, anthropicModel, claudeCodeModel } from "../llm/catalog";
import type { ClaudeCodeStatus } from "../llm/claudeCode";
// Same Markdown and highlighter as the chat tab; both escape all model text.
import { highlight } from "../chat/ui/highlight";
import { escapeHtml, renderMarkdown } from "../chat/ui/markdown";
import type { Effort } from "../llm/types";
import type { KeyStatus, ProviderSettings } from "./main";
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
.cp select,.cp input{height:26px;background:var(--void);color:var(--text);border:1px solid var(--edge,#3a1206);border-radius:4px;font:12px var(--font-ui);padding:0 6px;min-width:0}
.cp-chip{font:11px var(--font-mono);padding:3px 7px;border-radius:3px;background:var(--tint-bg,#1a0703);color:var(--flare);border:1px solid var(--edge,#3a1206)}
.cp-bar{display:none;align-items:center;gap:8px;padding:8px 16px;background:var(--tint-bg,#1a0703);border-bottom:1px solid var(--ash);flex-wrap:wrap}
.cp-bar.on{display:flex}
.cp-bar .msg{font-size:12px;color:var(--photon);margin-right:auto}
.cp-dot{width:8px;height:8px;border-radius:50%;background:var(--ember);animation:cp-blink 1s steps(1) infinite}
@keyframes cp-blink{50%{opacity:0}}
.cp-btn{height:28px;padding:0 10px;border-radius:4px;border:1px solid var(--ash);background:var(--btn,#120603);color:var(--text);font:500 12px var(--font-ui);cursor:pointer}
.cp-btn:hover{border-color:var(--ember)}
.cp-btn.pri{background:var(--ember);border-color:var(--ember);color:var(--on-accent)}
.cp-btn:disabled{opacity:.45;cursor:default}
.cp-log{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.cp-me{align-self:flex-end;max-width:85%;background:var(--tint-bg,#1a0703);border:1px solid var(--edge,#3a1206);border-radius:8px;padding:8px 12px;white-space:pre-wrap}
.cp-me.steer{border-color:var(--flare)}
.cp-log>*{flex:none}
.cp-ai{color:var(--photon);line-height:20px;overflow-wrap:anywhere;min-width:0}
.cp-ai p{margin:0 0 8px}.cp-ai p:last-child{margin-bottom:0}
.cp-ai ul,.cp-ai ol{margin:0 0 8px;padding-left:20px}
.cp-ai h3,.cp-ai h4,.cp-ai h5,.cp-ai h6{margin:4px 0 6px;font:600 13px var(--font-display);letter-spacing:.04em;color:var(--photon)}
.cp-ai a{color:var(--flare)}
.cp-ai code{font:12px var(--font-mono);background:var(--inline-bg,#2a0c04);border:1px solid var(--inline-line,#5a1a08);border-radius:3px;padding:0 4px;color:var(--inline-fg,#ffc46b)}
.cp .bhc-code,.cp-box{margin:0 0 8px;border:1px solid var(--edge,#3a1206);border-left:3px solid var(--ember);border-radius:6px;background:var(--code-bg,#030100);overflow:hidden;min-width:0}
.cp .bhc-code:last-child,.cp-box:last-child{margin-bottom:0}
.cp .bhc-code-hd,.cp-box-hd{display:flex;align-items:center;gap:8px;height:26px;padding:0 6px 0 10px;background:var(--code-hd,#120502);border-bottom:1px solid var(--line2,#2b0d05);font:600 10.5px var(--font-mono);letter-spacing:.08em;color:var(--ember)}
.cp .bhc-code-hd{justify-content:space-between;text-transform:uppercase}
.cp-box-hd .path{color:var(--photon);letter-spacing:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.cp-box-hd .tag{text-transform:uppercase;color:var(--ember)}
.cp-box-hd .st{font:500 11px var(--font-ui);letter-spacing:0;color:var(--dim);white-space:nowrap}
.cp-box.writing .st{color:var(--flare)}
.cp-box.stopped{border-left-color:var(--redshift)}
.cp .bhc-copy,.cp-copy{height:20px;padding:0 8px;border:1px solid transparent;border-radius:3px;background:none;color:var(--dim);font:500 11px var(--font-ui);letter-spacing:0;text-transform:none;cursor:pointer;flex:none}
.cp .bhc-copy:hover,.cp-copy:hover{border-color:var(--ash);color:var(--photon)}
.cp pre{margin:0;padding:8px 12px;overflow:auto;max-height:340px;background:none;font:12px/18px var(--font-mono);color:var(--syn-text,#f3e3d3);white-space:pre;tab-size:4}
.cp pre code{font:inherit;background:none;border:0;padding:0;color:inherit}
.cp .d-del{color:var(--del-fg,#ff7d6e);background:var(--del-bg,rgba(215,38,30,.12));display:block}
.cp .d-add{color:var(--add-fg,#ffd9a0);background:var(--add-bg,rgba(255,174,66,.10));display:block}
.cp .t-kw{color:var(--syn-kw,#ff7a1a);font-weight:var(--syn-kw-weight,600)}.cp .t-str{color:var(--syn-str,#ffd27a)}.cp .t-key{color:var(--syn-key,#ffb070)}
.cp .t-num,.cp .t-lit{color:var(--syn-num,#ff5a45)}.cp .t-lit{font-weight:600}.cp .t-com{color:var(--syn-com,#8a5e48);font-style:italic}
.cp .t-fn{color:var(--syn-fn,#fff6ea);font-weight:600}.cp .t-type{color:var(--syn-type,#ffae42)}.cp .t-deco{color:var(--syn-deco,#ff9a3c)}.cp .t-op{color:var(--syn-op,#e2452f)}
.cp-think{font-size:12px;color:var(--dim);font-style:italic}
.cp-tool{font:12px var(--font-mono);border:1px solid var(--line2);border-radius:5px;padding:6px 10px;background:var(--bg1);color:var(--dim)}
.cp-tool.ok::before{content:"✓ ";color:var(--ok)}
.cp-tool.error{border-color:var(--redshift);color:var(--text)}
.cp-tool.error::before{content:"✕ ";color:var(--redshift)}
.cp-tool.running::before,.cp-tool.waiting::before{content:"… ";color:var(--ember)}
.cp-tool.waiting{border-color:var(--ember);color:var(--text)}
.cp-edit{font:12px var(--font-mono);border:1px solid var(--flare);border-radius:5px;padding:6px 10px;color:var(--text)}
.cp-edit b{color:var(--flare);font-weight:600}
.cp-err{border:1px solid var(--redshift);border-radius:5px;padding:6px 10px;color:var(--text)}
.cp-ft{padding:12px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.cp-ft label{font-size:12px;color:var(--dim)}
.cp-ft textarea{resize:none;background:var(--void);color:var(--text);border:1px solid var(--edge,#3a1206);border-radius:6px;padding:8px 10px;font:13px var(--font-ui)}
.cp-ft textarea:focus,.cp input:focus,.cp select:focus{outline:1px solid var(--ember)}
.cp-note{font-size:11px;color:var(--dim);margin-right:auto}
.cp-key{display:none;flex-direction:column;gap:6px}
.cp-key.on{display:flex}
.cp-key p{margin:0;font-size:12px;color:var(--dim)}
.cp-keyform{display:none;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--ash);border-radius:6px;background:var(--bg1)}
.cp-key.edit .cp-keyform{display:flex}
.cp-key.edit .cp-keyname,.cp-key.edit>.cp-row>.cp-btn{display:none}
.cp-keyname{font:11px var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;color:var(--dim);margin-right:auto}
.cp-keyname b{color:var(--text);font-weight:500}
.cp-btn.sm{height:24px;padding:0 8px;font-size:11px}
.cp-blurb{font-size:11px;color:var(--dim);margin-top:-4px}
.cp-testmsg{font-size:12px;color:var(--dim);flex:1;min-width:0}
.cp-testmsg.ok{color:var(--flare)}
.cp-testmsg.bad{color:var(--redshift)}
.cp-conn{width:8px;height:8px;border-radius:50%;background:var(--line2)}
.cp-conn.ok{background:var(--flare)}
.cp-conn.bad{background:var(--redshift)}
.cp-cc{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--ash);border-radius:6px;background:var(--bg1)}
.cp-ccmsg{font-size:12px;color:var(--dim);flex:1;min-width:0}
.cp-ccmsg.ok{color:var(--flare)}
.cp-ccmsg.bad{color:var(--redshift)}
.cp-cchelp{margin:0;font-size:11px;line-height:16px;color:var(--dim)}
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

  // Header: model + effort picker, API key, test connection, context chips
  const hd = h("div", { class: "cp-hd" });
  const top = h("div", { class: "cp-row" });
  const conn = h("span", { class: "cp-conn", title: "Not tested yet" });
  top.append(h("span", { class: "cp-title" }, "Copilot"), conn);

  const pick = h("div", { class: "cp-row" });
  const prov = h("select", { "aria-label": "Copilot model", style: "flex:1" });
  const claudeGroup = h("optgroup", { label: "Claude · your API key" });
  for (const m of ANTHROPIC_MODELS) claudeGroup.append(h("option", { value: `anthropic:${m.id}` }, m.label));
  const ccGroup = h("optgroup", { label: "Claude · your Claude Code sign-in" });
  for (const m of CLAUDE_CODE_MODELS) ccGroup.append(h("option", { value: `claude-code:${m.id}` }, m.label));
  const localGroup = h("optgroup", { label: "Local server · free" });
  for (const [id, p] of Object.entries(LOCAL_PRESETS)) localGroup.append(h("option", { value: `local:${id}` }, `${p.label} :${new URL(p.baseUrl).port}`));
  prov.append(claudeGroup, ccGroup, localGroup);
  const effort = h("select", { "aria-label": "Effort", title: "Effort: how hard the model thinks. Higher is slower and uses more tokens." });
  for (const e of EFFORTS) effort.append(h("option", { value: e.id }, e.label));
  pick.append(prov, effort);
  const blurb = h("div", { class: "cp-blurb" });

  const local = h("div", { class: "cp-row", style: "display:none" });
  const baseUrl = h("input", { "aria-label": "Local server URL", style: "flex:1" });
  const localModel = h("select", { "aria-label": "Local model", style: "flex:1" });
  const probeBtn = h("button", { class: "cp-btn" }, "Connect");
  local.append(baseUrl, localModel, probeBtn);

  // API key: saved state (hint + Change / Remove) or the entry form.
  const key = h("div", { class: "cp-key" });
  const keySaved = h("div", { class: "cp-row" });
  const keyLabel = h("span", { class: "cp-keyname", title: "Encrypted with your macOS Keychain; the key never leaves the main process except to call Anthropic." });
  const keyChange = h("button", { class: "cp-btn sm" }, "Change");
  const keyRemove = h("button", { class: "cp-btn sm" }, "Remove");
  keySaved.append(keyLabel, keyChange, keyRemove);
  const keyForm = h("div", { class: "cp-keyform" });
  const keyHelp = h("p", {}, "Paste your own Anthropic API key (Console › API keys). It is encrypted with your Mac user's Keychain, only this app on this account can read it, and BlackHole-Dev never bills you.");
  const keyRow = h("div", { class: "cp-row" });
  const keyIn = h("input", { type: "password", "aria-label": "Anthropic API key", placeholder: "sk-ant-…", autocomplete: "off", spellcheck: "false", style: "flex:1" });
  const keySave = h("button", { class: "cp-btn pri" }, "Save");
  const keyCancel = h("button", { class: "cp-btn" }, "Cancel");
  keyRow.append(keyIn, keySave, keyCancel);
  keyForm.append(keyHelp, keyRow);
  key.append(keySaved, keyForm);

  // Claude Code: install / sign-in status. The app never sees the login; `claude` handles it.
  const cc = h("div", { class: "cp-cc", style: "display:none" });
  const ccRow = h("div", { class: "cp-row" });
  const ccMsg = h("span", { class: "cp-ccmsg", role: "status" }, "Checking for Claude Code…");
  const ccCheck = h("button", { class: "cp-btn sm" }, "Check");
  ccRow.append(ccMsg, ccCheck);
  const ccHelp = h("p", { class: "cp-cchelp" }, "Runs the Claude Code you installed and signed into yourself, so turns count against your own Claude plan (or the key Claude Code is set up with). BlackHole-Dev never sees your login. Claude Code's own tools are switched off: it can only use the copilot's tools, and starting a VM or a run still needs your click.");
  cc.append(ccRow, ccHelp);

  const testRow = h("div", { class: "cp-row" });
  const testBtn = h("button", { class: "cp-btn sm" }, "Test connection");
  const testMsg = h("span", { class: "cp-testmsg", role: "status" });
  testRow.append(testBtn, testMsg);

  const chips = h("div", { class: "cp-row" });
  hd.append(top, pick, blurb, local, key, cc, testRow, chips);

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
  let aiText = "";
  /** Code boxes for files being written, by path. */
  const boxes = new Map<string, { el: HTMLElement; code: HTMLElement; st: HTMLElement; text: string; lang: string }>();
  let thinkEl: HTMLElement | null = null;
  const toolEls = new Map<string, HTMLElement>();
  let writingFile = "";

  // Follow the stream only while the user is at the bottom; scrolling up to read stops it.
  let follow = true;
  log.addEventListener("scroll", () => (follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48));
  const scroll = () => {
    if (follow) log.scrollTop = log.scrollHeight;
  };
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
        follow = true;
        aiEl = null;
        thinkEl = null;
        add(h("div", { class: e.steer ? "cp-me steer" : "cp-me" }, e.text));
        break;
      case "prose":
        if (!e.text.trim() && !aiEl) break;
        if (!aiEl) {
          aiEl = add(h("div", { class: "cp-ai" }));
          aiText = "";
        }
        aiText += e.text;
        aiEl.innerHTML = renderMarkdown(aiText); // renderMarkdown escapes all model text
        scroll();
        break;
      case "reasoning":
        if (!thinkEl) thinkEl = add(h("div", { class: "cp-think" }, "Thinking… "));
        break;
      case "write": {
        aiEl = null;
        if (e.status === "start") {
          const lang = e.lang || langOf(e.file);
          const b = codeBox(lang, e.file, e.mode === "new" ? "writing…" : e.mode === "rewrite" ? "rewriting…" : "continuing…");
          b.el.classList.add("writing");
          boxes.set(e.file, { ...b, text: "", lang });
          add(b.el);
          break;
        }
        const b = boxes.get(e.file);
        if (!b) break;
        b.el.classList.remove("writing");
        b.el.classList.toggle("stopped", e.status === "stopped");
        b.st.textContent = e.status === "done" ? "written · pending your accept" : "stopped";
        boxes.delete(e.file);
        break;
      }
      case "code": {
        const b = boxes.get(e.file);
        if (!b) break;
        b.text += e.text;
        b.code.innerHTML = highlight(b.text, b.lang);
        scroll();
        break;
      }
      case "edit": {
        aiEl = null;
        const b = codeBox("edit", e.file, `${e.edits.length} change${e.edits.length === 1 ? "" : "s"} · pending your accept`);
        const lines = (s: string, cls: string, mark: string) => s.split("\n").map((l) => `<span class="${cls}">${mark} ${escapeHtml(l)}</span>`).join("");
        b.code.innerHTML = e.edits.map((x) => lines(x.find, "d-del", "-") + lines(x.replace, "d-add", "+")).join("");
        add(b.el);
        break;
      }
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

  function codeBox(tag: string, file: string, status: string) {
    const el = h("div", { class: "cp-box" });
    const hdr = h("div", { class: "cp-box-hd" });
    const st = h("span", { class: "st" }, status);
    hdr.append(h("span", { class: "tag" }, tag), h("span", { class: "path", title: file }, file), st, h("button", { class: "cp-copy", type: "button" }, "Copy"));
    const pre = h("pre");
    const code = h("code");
    pre.append(code);
    el.append(hdr, pre);
    return { el, code, st };
  }

  // Copy buttons on code boxes (written files, edits, and code in replies).
  log.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".cp-copy, .bhc-copy");
    const box = btn?.closest(".cp-box, .bhc-code");
    if (!btn || !box) return;
    const pre = box.querySelector("pre")!;
    // An edit box copies only the replacement text.
    const added = [...pre.querySelectorAll(".d-add")];
    const text = added.length ? added.map((l) => l.textContent!.slice(2)).join("\n") : pre.textContent ?? "";
    void navigator.clipboard?.writeText(text).then(() => {
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
  });

  // ---- provider settings ----
  const isLocal = () => prov.value.startsWith("local:");
  const isClaudeCode = () => prov.value.startsWith("claude-code:");
  let ccStatus: ClaudeCodeStatus | null = null;

  async function checkClaudeCode(fresh: boolean) {
    if (ccStatus && !fresh) return ccStatus;
    ccCheck.disabled = true;
    ccMsg.className = "cp-ccmsg";
    ccMsg.textContent = "Checking for Claude Code…";
    try {
      ccStatus = await deps.invoke("copilot:claudeStatus");
    } catch (err) {
      ccStatus = { installed: false, loggedIn: false, message: String(err) };
    }
    ccCheck.disabled = false;
    ccMsg.className = `cp-ccmsg ${ccStatus!.loggedIn ? "ok" : "bad"}`;
    ccMsg.textContent = ccStatus!.message;
    // The long explanation only matters until it works; then it stays as a tooltip.
    ccHelp.style.display = ccStatus!.loggedIn ? "none" : "";
    ccMsg.title = ccHelp.textContent ?? "";
    testBtn.disabled = !ccStatus!.loggedIn;
    return ccStatus;
  }
  let keyEditing = false;

  function setConn(state: "ok" | "bad" | "", msg: string) {
    conn.className = state ? `cp-conn ${state}` : "cp-conn";
    conn.title = msg || "Not tested yet";
    testMsg.className = state ? `cp-testmsg ${state}` : "cp-testmsg";
    testMsg.textContent = msg;
  }

  async function loadSettings() {
    settings = await deps.invoke("copilot:settings");
    if (!settings) return;
    if (settings.provider === "anthropic") {
      prov.value = `anthropic:${settings.model}`;
      effort.value = settings.effort;
    } else if (settings.provider === "claude-code") {
      prov.value = `claude-code:${settings.model}`;
      effort.value = settings.effort;
    } else {
      prov.value = settings.preset === "custom" ? "local:mlx" : `local:${settings.preset}`;
      baseUrl.value = settings.baseUrl;
      localModel.replaceChildren(h("option", { value: settings.model }, settings.model || "(pick a model)"));
    }
    await syncProviderUi();
  }

  async function syncProviderUi() {
    const loc = isLocal();
    const ccOn = isClaudeCode();
    local.style.display = loc ? "flex" : "none";
    cc.style.display = ccOn ? "" : "none";
    effort.style.display = loc ? "none" : "";
    const id = prov.value.split(":")[1];
    blurb.textContent = loc ? "Runs on this Mac through an OpenAI-compatible server. No key, no cost." : ccOn ? claudeCodeModel(id)?.blurb ?? "" : anthropicModel(id)?.blurb ?? "";
    key.classList.toggle("on", !loc && !ccOn);
    testBtn.disabled = false;
    if (loc) return;
    if (ccOn) {
      await checkClaudeCode(false);
      return;
    }
    const st: KeyStatus = await deps.invoke("copilot:keyStatus");
    keyLabel.replaceChildren(
      document.createTextNode("Key "),
      h("b", {}, st.has ? st.hint ?? "saved" : "not set"),
      document.createTextNode(st.has ? " · Keychain" : ""),
    );
    keyRemove.style.display = st.has ? "" : "none";
    keyChange.textContent = st.has ? "Change" : "Add key";
    keyCancel.style.display = st.has ? "" : "none";
    if (!st.encryption) keyHelp.textContent = "This Mac cannot encrypt secrets right now (Keychain locked or unavailable), so the key cannot be saved. Unlock the Keychain and reopen the app.";
    key.classList.toggle("edit", keyEditing || !st.has);
    testBtn.disabled = !st.has;
  }

  async function saveSettings(s: ProviderSettings) {
    settings = await deps.invoke("copilot:setSettings", s);
    setConn("", "");
  }

  prov.addEventListener("change", async () => {
    const [kind, id] = prov.value.split(":");
    if (kind === "anthropic") {
      // A model change keeps the effort the user picked; the model's default only applies on first use.
      const keep = settings?.provider === "anthropic" ? settings.effort : anthropicModel(id)?.defaultEffort ?? "high";
      effort.value = keep;
      await saveSettings({ provider: "anthropic", model: id, effort: keep });
    } else if (kind === "claude-code") {
      const keep = settings?.provider === "claude-code" ? settings.effort : claudeCodeModel(id)?.defaultEffort ?? "high";
      effort.value = keep;
      await saveSettings({ provider: "claude-code", model: id, effort: keep });
    } else {
      const preset = id as keyof typeof LOCAL_PRESETS;
      baseUrl.value = LOCAL_PRESETS[preset].baseUrl;
      await saveSettings({ provider: "openai-compatible", preset, baseUrl: baseUrl.value, model: localModel.value || "" });
      void connectLocal();
    }
    await syncProviderUi();
  });

  effort.addEventListener("change", () => {
    if (settings?.provider !== "anthropic" && settings?.provider !== "claude-code") return;
    void saveSettings({ ...settings, effort: effort.value as Effort });
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
      setConn("ok", `Server up · ${r.models.length} model(s)`);
    } else {
      setConn("bad", `No local server at ${baseUrl.value} (${r.message ?? "unreachable"}). Start mlx_lm.server, llama.cpp or Ollama, then Retry.`);
    }
  }

  async function saveLocal() {
    const id = prov.value.split(":")[1] as keyof typeof LOCAL_PRESETS;
    await saveSettings({ provider: "openai-compatible", preset: baseUrl.value === LOCAL_PRESETS[id]?.baseUrl ? id : "custom", baseUrl: baseUrl.value, model: localModel.value });
  }

  probeBtn.addEventListener("click", () => void connectLocal());
  ccCheck.addEventListener("click", () => void checkClaudeCode(true));
  localModel.addEventListener("change", () => void saveLocal());
  baseUrl.addEventListener("change", () => void saveLocal());

  async function saveKey() {
    keySave.disabled = true;
    setConn("", "Checking the key with Anthropic…");
    const r = await deps.invoke("copilot:setKey", keyIn.value);
    keySave.disabled = false;
    if (r.saved) {
      keyIn.value = "";
      keyEditing = false;
    }
    setConn(r.ok ? "ok" : "bad", r.message);
    await syncProviderUi();
  }
  keySave.addEventListener("click", () => void saveKey());
  keyIn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void saveKey();
    }
  });
  keyChange.addEventListener("click", () => {
    keyEditing = true;
    void syncProviderUi().then(() => keyIn.focus());
  });
  keyCancel.addEventListener("click", () => {
    keyEditing = false;
    keyIn.value = "";
    void syncProviderUi();
  });
  keyRemove.addEventListener("click", async () => {
    await deps.invoke("copilot:deleteKey");
    keyEditing = false;
    setConn("", "Key removed from this Mac.");
    await syncProviderUi();
  });

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    setConn("", isLocal() ? "Testing the local server…" : isClaudeCode() ? "Asking Claude Code for one word…" : "Sending one tiny request (well under a cent)…");
    try {
      const r = await deps.invoke("copilot:test");
      setConn(r.ok ? "ok" : "bad", r.message);
    } catch (err) {
      setConn("bad", String(err));
    } finally {
      testBtn.disabled = false;
    }
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

function langOf(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return ({ py: "python", ts: "ts", js: "js", toml: "toml", json: "json", sh: "sh", md: "md", yaml: "yaml", yml: "yaml" } as Record<string, string>)[ext] ?? ext;
}
