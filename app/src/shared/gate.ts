// I4 confirm gate. Expensive operations only run after a human click in the gate window.

// compute.local: a long local job, e.g. an analysis that reads many GB of weights or a full model copy.
// vm.down stops a VM (disk kept); vm.delete deletes it and its disk, and only a person may ask for that.
export type GatedAction = "vm.up" | "vm.down" | "vm.delete" | "run.launch" | "download" | "paid.api" | "paid.gpu" | "compute.local";

export const GATED_ACTIONS: readonly GatedAction[] = ["vm.up", "vm.down", "vm.delete", "run.launch", "download", "paid.api", "paid.gpu", "compute.local"];

/** Actions the copilot may never request, even for a human to approve. */
export const HUMAN_ONLY: readonly GatedAction[] = ["vm.delete"];

export interface ConfirmRequest {
  action: GatedAction;
  title: string;
  why: string;
  estCost?: string;
  details?: { label: string; value: string }[];
  requestedBy: "user" | "copilot";
}

export interface ConfirmShown extends ConfirmRequest {
  id: string;
  armMs: number;
}

export interface ConfirmAnswer {
  id: string;
  approved: boolean;
  trusted: boolean;
}

export function validateConfirmRequest(r: unknown): ConfirmRequest {
  const q = r as Partial<ConfirmRequest> | null;
  if (!q || typeof q !== "object") throw new Error("confirm: request must be an object");
  if (!GATED_ACTIONS.includes(q.action as GatedAction)) throw new Error(`confirm: unknown action ${String(q.action)}`);
  if (typeof q.title !== "string" || !q.title) throw new Error("confirm: title is required");
  if (typeof q.why !== "string" || !q.why) throw new Error("confirm: why is required");
  if (q.requestedBy !== "user" && q.requestedBy !== "copilot") throw new Error("confirm: requestedBy must be user or copilot");
  if (q.requestedBy === "copilot" && HUMAN_ONLY.includes(q.action as GatedAction)) throw new Error(`confirm: the copilot cannot ask for ${q.action}`);
  const details = Array.isArray(q.details)
    ? q.details.map((d) => ({ label: String(d.label), value: String(d.value) }))
    : undefined;
  return {
    action: q.action as GatedAction,
    title: q.title,
    why: q.why,
    estCost: q.estCost === undefined ? undefined : String(q.estCost),
    details,
    requestedBy: q.requestedBy,
  };
}
