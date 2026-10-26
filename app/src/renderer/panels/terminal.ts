// TERMINAL panel: xterm.js tabs over main-process terminals (node-pty when available).

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { h, clear } from "../dom";
import { bh } from "../bridge";
import { THEME } from "../../shared/theme";
import type { Shell } from "../shell";

interface T { id: string; title: string; term: Terminal; fit: FitAddon; el: HTMLElement; exited: boolean }

export class TerminalPanel {
  private terms: T[] = [];
  private active: T | null = null;
  private tabs = h("div", { class: "term-tabs" });
  private host = h("div", { class: "term-host" });

  constructor(private shell: Shell) {
    bh.on("term:data", (p: { id: string; data: string }) => this.terms.find((t) => t.id === p.id)?.term.write(p.data));
    bh.on("term:exit", (p: { id: string; code: number | null }) => {
      const t = this.terms.find((x) => x.id === p.id);
      if (t) {
        t.exited = true;
        t.term.write(`\r\n\x1b[38;2;162;115;91m[process exited${p.code === null ? "" : ` with ${p.code}`}]\x1b[0m\r\n`);
        this.drawTabs();
      }
    });
    new ResizeObserver(() => this.fitActive()).observe(this.host);
  }

  render(el: HTMLElement): void {
    el.append(this.tabs, this.host);
    this.drawTabs();
  }

  /** Attach a terminal that main already created (ctx.terminal.create). */
  attach(id: string, title: string): void {
    if (this.terms.some((t) => t.id === id)) return this.focus(id);
    const term = new Terminal({
      fontFamily: "JetBrains Mono, Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: { background: THEME.bg1, foreground: THEME.text, cursor: THEME.ember, selectionBackground: "#4a0d0288", red: THEME.redshift, yellow: THEME.flare, brightRed: "#ff5a3c", brightYellow: "#ffc773" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const el = h("div", { style: "position:absolute;inset:0" });
    this.host.append(el);
    term.open(el);
    term.onData((d) => bh.invoke("term:write", id, d));
    term.onResize(({ cols, rows }) => bh.invoke("term:resize", id, cols, rows));
    const t: T = { id, title, term, fit, el, exited: false };
    this.terms.push(t);
    this.focus(id);
  }

  async newShell(): Promise<void> {
    const id = await bh.invoke<string>("term:create", { title: "zsh", cwd: this.shell.paths.workspace });
    this.attach(id, "shell");
  }

  focus(id: string): void {
    this.shell.showPanel("terminal");
    for (const t of this.terms) t.el.style.display = t.id === id ? "" : "none";
    this.active = this.terms.find((t) => t.id === id) ?? null;
    this.drawTabs();
    requestAnimationFrame(() => {
      this.fitActive();
      this.active?.term.focus();
    });
  }

  private close(t: T): void {
    if (!t.exited) bh.invoke("term:dispose", t.id);
    t.term.dispose();
    t.el.remove();
    this.terms = this.terms.filter((x) => x !== t);
    if (this.active === t) this.active = null;
    if (this.terms[0]) this.focus(this.terms[0].id);
    else this.drawTabs();
  }

  private fitActive(): void {
    if (!this.active || !this.host.offsetParent) return;
    try {
      this.active.fit.fit();
    } catch {
      /* hidden */
    }
  }

  private drawTabs(): void {
    clear(this.tabs);
    for (const t of this.terms)
      this.tabs.append(h("span", { class: "chip", style: t === this.active ? "border-color:var(--ember)" : "" },
        h("button", { class: "btn sm", style: "border:0;background:none;padding:0", onclick: () => this.focus(t.id) }, `${t.title}${t.exited ? " (exited)" : ""}`),
        h("button", { class: "btn sm", style: "border:0;background:none;padding:0 2px", "aria-label": `Close ${t.title}`, onclick: () => this.close(t) }, "✕")));
    this.tabs.append(h("button", { class: "btn sm", "aria-label": "New terminal", onclick: () => this.newShell() }, "+"));
  }
}

export function outputPanel(): (el: HTMLElement) => void {
  return (el) => {
    const filter = h("select", { "aria-label": "Log source", style: "height:24px" }, h("option", { value: "" }, "all"), h("option", { value: "app" }, "app"), h("option", { value: "helper" }, "helper"));
    const box = h("div", { class: "log" });
    el.append(h("div", { class: "row", style: "padding:6px 16px 0" }, h("span", { class: "meta" }, "source"), filter,
      h("button", { class: "btn sm", onclick: () => clear(box) }, "Clear")), box);
    const add = (source: string, line: string) => {
      if (!line) return;
      const row = h("div", { "data-src": source }, h("span", { class: "src" }, `[${source}] `), line);
      if (filter.value && filter.value !== source) row.style.display = "none";
      box.append(row);
      while (box.childElementCount > 3000) box.firstElementChild?.remove();
      const pane = el;
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80) pane.scrollTop = pane.scrollHeight;
    };
    filter.addEventListener("change", () => {
      for (const r of box.children) (r as HTMLElement).style.display = !filter.value || (r as HTMLElement).dataset.src === filter.value ? "" : "none";
    });
    bh.invoke<string[]>("app:logs").then((ls) => ls.forEach((l) => add("app", l)));
    bh.on("app:log", (p: { source: string; line: string }) => {
      if (!filter.querySelector(`option[value="${CSS.escape(p.source)}"]`)) filter.append(h("option", { value: p.source }, p.source));
      for (const l of p.line.split("\n")) add(p.source, l);
    });
  };
}
