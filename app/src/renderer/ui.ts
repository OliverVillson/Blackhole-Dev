// Modal, context menu, toast and prompt primitives drawn by the shell.

import { h } from "./dom";
import type { Dispose } from "../shared/ext";
import { splitError } from "../shared/errors";

export function showModal(m: { title: string; width?: number; render(el: HTMLElement, close: () => void): void | Dispose }): { close(): void } {
  const body = h("div", { class: "modal-body" });
  let dispose: void | Dispose;
  const close = () => {
    if (typeof dispose === "function") dispose();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const overlay = h("div", { class: "overlay", onmousedown: (e: MouseEvent) => e.target === overlay && close() },
    h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": m.title, style: m.width ? `width:${m.width}px` : undefined },
      h("div", { class: "modal-head" }, h("h2", null, m.title), h("button", { class: "btn sm", "aria-label": "Close", onclick: close }, "✕")),
      body));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  dispose = m.render(body, close);
  (body.querySelector("input,select,textarea,button") as HTMLElement | null)?.focus();
  return { close };
}

export interface MenuItem {
  label: string;
  hint?: string;
  run?: () => unknown;
  sep?: boolean;
  disabled?: boolean;
}

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  const menu = h("div", { class: "menu", role: "menu" });
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const away = (e: MouseEvent) => !menu.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  for (const it of items) {
    if (it.sep) menu.append(h("div", { class: "sep" }));
    else
      menu.append(h("button", { class: "mi", role: "menuitem", disabled: it.disabled, onclick: () => { close(); it.run?.(); } },
        h("span", null, it.label), h("span", { class: "meta" }, it.hint ?? "")));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", onKey, true);
  (menu.querySelector("button") as HTMLElement | null)?.focus();
}

let toastBox: HTMLElement | null = null;
export function toast(message: string, kind: "info" | "warn" | "error" = "info"): void {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.append(toastBox);
  }
  // Long errors (Hugging Face's 401 page, tracebacks) show one line; Details and Copy have the rest.
  const e = splitError(message);
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, h("div", null, e.head));
  let timer = setTimeout(() => t.remove(), kind === "error" ? 9000 : 5000);
  if (e.more) {
    const full = h("pre", { class: "toast-full" }, e.full);
    const details = h("button", { class: "btn sm", onclick: () => {
      clearTimeout(timer);
      details.textContent = full.classList.toggle("on") ? "Hide details" : "Details";
    } }, "Details");
    const copy = h("button", { class: "btn sm", onclick: () => {
      clearTimeout(timer);
      void navigator.clipboard?.writeText(e.full).then(() => (copy.textContent = "Copied"));
    } }, "Copy");
    const close = h("button", { class: "btn sm", onclick: () => t.remove() }, "Close");
    t.append(h("div", { class: "toast-row" }, details, copy, close), full);
    t.addEventListener("mouseenter", () => clearTimeout(timer));
    t.addEventListener("mouseleave", () => { if (!full.classList.contains("on")) timer = setTimeout(() => t.remove(), 4000); });
  }
  toastBox.append(t);
}

export function prompt(title: string, label: string, value = "", okLabel = "OK"): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const m = showModal({
      title,
      width: 460,
      render(el, close) {
        const input = h("input", { value, "aria-label": label, style: "width:100%" });
        const ok = () => {
          finish(input.value.trim() || null);
          close();
        };
        input.addEventListener("keydown", (e) => e.key === "Enter" && ok());
        el.append(h("div", { class: "field" }, h("label", null, label), input),
          h("div", { class: "row", style: "justify-content:flex-end" }, h("button", { class: "btn", onclick: () => { finish(null); close(); } }, "Cancel"), h("button", { class: "btn pri", onclick: ok }, okLabel)));
        setTimeout(() => input.select());
        return () => finish(null);
      },
    });
    void m;
  });
}
