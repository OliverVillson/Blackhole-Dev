// Renderer-side bridge to copilot/main.ts: turns `copilot:chunk` events into an async iterable.
import type { LlmChunk } from "../llm/types";
import type { CopilotHost, TurnRequest } from "./session";

interface Bridge {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
}

export function makeTurnTransport(bridge: Bridge): Pick<CopilotHost, "turn" | "abortTurn" | "helper"> {
  const queues = new Map<string, { items: LlmChunk[]; wake: (() => void) | null }>();
  bridge.on("copilot:chunk", ({ turnId, chunk }: { turnId: string; chunk: LlmChunk }) => {
    const q = queues.get(turnId);
    if (!q) return;
    q.items.push(chunk);
    q.wake?.();
  });

  return {
    async *turn(req: TurnRequest): AsyncIterable<LlmChunk> {
      const q = { items: [] as LlmChunk[], wake: null as (() => void) | null };
      queues.set(req.turnId, q);
      try {
        try {
          await bridge.invoke("copilot:turn", req);
        } catch (err) {
          yield { type: "error", message: String(err), retryable: false };
          return;
        }
        for (;;) {
          while (!q.items.length) await new Promise<void>((r) => (q.wake = r));
          q.wake = null;
          const c = q.items.shift()!;
          yield c;
          if (c.type === "done" || c.type === "error") return;
        }
      } finally {
        queues.delete(req.turnId);
      }
    },
    abortTurn(turnId: string) {
      void bridge.invoke("copilot:abort", turnId);
    },
    helper(method: string, params: object) {
      return bridge.invoke("copilot:helper", method, params);
    },
  };
}
