// I4 confirm gate (main process). Shows each request in its own small modal window whose only
// bridge is "answer"; renderer modules and the copilot cannot reach that window, so only a
// human click (trusted event, after an arm delay) approves. Every decision is logged.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ConfirmAnswer, ConfirmRequest, ConfirmShown } from "../shared/gate";
import { validateConfirmRequest } from "../shared/gate";

export interface GateUi {
  /** Show the request; resolve with the answer the gate window sent (or approved:false if it closed). */
  show(req: ConfirmShown): Promise<ConfirmAnswer>;
}

export class Gate {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private ui: GateUi, private logFile: string | null, private armMs = 600) {}

  confirm(raw: ConfirmRequest): Promise<boolean> {
    let req: ConfirmRequest;
    try {
      req = validateConfirmRequest(raw);
    } catch (e) {
      return Promise.reject(e);
    }
    // One gate at a time, so a burst of requests cannot stack windows over each other.
    const run = this.queue.then(() => this.ask(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ask(req: ConfirmRequest): Promise<boolean> {
    const shown: ConfirmShown = { ...req, id: randomUUID(), armMs: this.armMs };
    const started = Date.now();
    let answer: ConfirmAnswer;
    try {
      answer = await this.ui.show(shown);
    } catch {
      answer = { id: shown.id, approved: false, trusted: false };
    }
    const approved =
      answer.id === shown.id && answer.approved === true && answer.trusted === true && Date.now() - started >= this.armMs;
    this.log({ at: new Date().toISOString(), id: shown.id, action: req.action, title: req.title, requestedBy: req.requestedBy, estCost: req.estCost ?? null, approved });
    return approved;
  }

  private log(entry: object): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch {
      /* logging must never block a decision */
    }
  }
}
