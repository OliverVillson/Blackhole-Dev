import "./fonts";
// The confirm-gate window. It has no access to the main window or its modules; it receives one
// request and sends one answer. Approve only counts for a trusted (human) event after the arm delay.
import "./styles.css";
import { h } from "./dom";
import type { ConfirmShown } from "../shared/gate";

interface GateBridge {
  onRequest(cb: (req: ConfirmShown) => void): void;
  answer(a: { id: string; approved: boolean; trusted: boolean }): void;
}
const gate = (window as unknown as { gate: GateBridge }).gate;

const LABEL: Record<string, string> = {
  "vm.up": "Start a cloud VM",
  "vm.down": "Stop a cloud VM",
  "run.launch": "Launch a pipeline run",
  download: "Download a large model",
  "paid.api": "Spend paid API credit",
  "paid.gpu": "Spend paid GPU time",
};

gate.onRequest((req) => {
  const root = document.getElementById("gate")!;
  const shownAt = performance.now();
  let sent = false;
  const send = (approved: boolean, e: Event) => {
    if (sent) return;
    if (approved && (!e.isTrusted || performance.now() - shownAt < req.armMs)) return;
    sent = true;
    gate.answer({ id: req.id, approved, trusted: e.isTrusted });
  };
  const approve = h("button", { class: "btn pri", disabled: true, onclick: (e: Event) => send(true, e) }, "Approve");
  const deny = h("button", { class: "btn", onclick: (e: Event) => send(false, e) }, "Cancel");
  setTimeout(() => {
    approve.disabled = false;
  }, req.armMs);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") send(false, e);
  });
  root.append(
    h("div", { class: "modal", style: "width:100%;max-width:none;height:100vh;max-height:none;border:0;border-radius:0" },
      h("div", { class: "modal-head" },
        h("h2", null, req.title),
        h("span", { class: "badge hot" }, LABEL[req.action] ?? req.action)),
      h("div", { class: "modal-body", style: "flex:1" },
        h("div", { style: "font-size:14px;line-height:20px;color:var(--photon)" }, req.why),
        req.estCost ? h("div", { class: "kv" }, h("span", null, "estimated cost"), h("span", { class: "tone-warn" }, req.estCost)) : null,
        ...(req.details ?? []).map((d) => h("div", { class: "kv" }, h("span", null, d.label), h("span", null, d.value))),
        h("div", { class: "meta" }, req.requestedBy === "copilot"
          ? "The copilot asked for this. Nothing happens unless you approve."
          : "Nothing happens unless you approve.")),
      h("div", { class: "row", style: "justify-content:flex-end;padding:14px 18px;border-top:1px solid var(--line2)" }, deny, approve)),
  );
  deny.focus();
});
