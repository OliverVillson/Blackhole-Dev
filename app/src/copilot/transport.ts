// Renderer-side bridge to copilot/main.ts: turns `copilot:chunk` events (and, for Claude Code,
// `copilot:toolCall` events) into one async iterable per turn.
import type { ToolCallEvent } from "./main";
import type { CopilotHost, TurnChunk, TurnRequest } from "./session";

interface Bridge {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
}

export function makeTurnTransport(bridge: Bridge): Pick<CopilotHost, "turn" | "abortTurn" | "helper" | "toolResult"> {
  const queues = new Map<string, { items: TurnChunk[]; wake: (() => void) | null }>();
  const push = (turnId: string, chunk: TurnChunk) => {
    const q = queues.get(turnId);
    if (!q) return false;
    q.items.push(chunk);
    q.wake?.();
    return true;
  };
  bridge.on("copilot:chunk", ({ turnId, chunk }) => push(turnId, chunk));
  bridge.on("copilot:toolCall", ({ turnId, callId, name, input }: ToolCallEvent) => {
    if (!push(turnId, { type: "tool_run", callId, name, input })) {
      void bridge.invoke("copilot:toolResult", callId, { content: "Not run: that turn is over.", isError: true });
    }
  });

  return {
    async *turn(req: TurnRequest): AsyncIterable<TurnChunk> {
      const q = { items: [] as TurnChunk[], wake: null as (() => void) | null };
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
    toolResult(callId, result) {
      void bridge.invoke("copilot:toolResult", callId, result);
    },
    helper(method: string, params: object) {
      return bridge.invoke("copilot:helper", method, params);
    },
  };
}
