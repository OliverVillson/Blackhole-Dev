// OpenAI-compatible provider for local servers: mlx_lm.server, llama.cpp server, Ollama.
import type { ChatRequest, FinishReason, LlmChunk, LlmMessage, Provider, Usage } from "./types";

export { LOCAL_PRESETS } from "./catalog";

type OaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OaToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function toOpenAiMessages(system: string | undefined, messages: LlmMessage[]): OaMessage[] {
  const out: OaMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as OaMessage);
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const t = b as { id: string; name: string; input: unknown };
          return { id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
        });
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become role "tool" messages, any text a user message after them
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
      } else if (b.type === "text") {
        text.push(b.text);
      }
    }
    if (text.length) out.push({ role: "user", content: text.join("\n") });
  }
  return out;
}

/** Splits inline <think>…</think> (Qwen3-style) out of a text stream, across chunk boundaries.
 *  Templates that open <think> inside the prompt (Qwen3.6) stream an orphan </think>: text before it is
 *  reasoning. To catch that, the first `probeChars` of the stream are held until a tag shows up. */
export class ThinkSplitter {
  private inThink: boolean;
  private carry = "";
  private probing: boolean;
  private probe = "";
  private trimNext = false;
  private readonly probeChars: number;

  constructor(opts: { startsInThink?: boolean; probeChars?: number } = {}) {
    this.inThink = !!opts.startsInThink;
    this.probing = !opts.startsInThink;
    this.probeChars = opts.probeChars ?? 1200;
  }

  push(s: string): { text: string; reasoning: string } {
    if (!this.probing) return this.core(s);
    this.probe += s;
    const open = this.probe.indexOf("<think>");
    const close = this.probe.indexOf("</think>");
    if (close >= 0 && (open < 0 || close < open)) {
      this.probing = false;
      const reasoning = this.probe.slice(0, close);
      const rest = this.probe.slice(close + "</think>".length);
      this.probe = "";
      this.trimNext = true;
      const r = this.core(rest);
      return { text: r.text, reasoning: reasoning + r.reasoning };
    }
    if (open >= 0 || this.probe.length > this.probeChars) {
      this.probing = false;
      const p = this.probe;
      this.probe = "";
      return this.core(p);
    }
    return { text: "", reasoning: "" };
  }

  flush(): { text: string; reasoning: string } {
    if (this.probing) {
      this.probing = false;
      const p = this.probe;
      this.probe = "";
      const r = this.core(p);
      const f = this.flush();
      return { text: r.text + f.text, reasoning: r.reasoning + f.reasoning };
    }
    const c = this.carry;
    this.carry = "";
    return this.inThink ? { text: "", reasoning: c } : { text: this.trim(c), reasoning: "" };
  }

  private core(s: string): { text: string; reasoning: string } {
    let buf = this.carry + s;
    this.carry = "";
    let text = "";
    let reasoning = "";
    while (buf.length) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = buf.indexOf(tag);
      // A stray </think> outside reasoning is dropped rather than shown.
      const stray = this.inThink ? -1 : buf.indexOf("</think>");
      if (stray >= 0 && (i < 0 || stray < i)) {
        text += this.trim(buf.slice(0, stray));
        buf = buf.slice(stray + "</think>".length);
        this.trimNext = true;
        continue;
      }
      if (i >= 0) {
        if (this.inThink) reasoning += buf.slice(0, i);
        else text += this.trim(buf.slice(0, i));
        buf = buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        if (!this.inThink) this.trimNext = true;
        continue;
      }
      // Hold back a possible partial tag at the end.
      let hold = 0;
      const tags = this.inThink ? ["</think>"] : ["<think>", "</think>"];
      for (const t of tags) {
        for (let k = Math.min(t.length - 1, buf.length); k > hold; k--) {
          if (t.startsWith(buf.slice(buf.length - k))) {
            hold = k;
            break;
          }
        }
      }
      const emit = buf.slice(0, buf.length - hold);
      if (this.inThink) reasoning += emit;
      else text += this.trim(emit);
      this.carry = buf.slice(buf.length - hold);
      buf = "";
    }
    return { text, reasoning };
  }

  /** Drops the blank lines a model puts right after </think>. */
  private trim(t: string): string {
    if (!this.trimNext || !t) return t;
    const out = t.replace(/^\s+/, "");
    if (out) this.trimNext = false;
    return out;
  }
}

/** Parses an SSE byte stream into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

function mapFinish(r: string | null | undefined): FinishReason {
  if (r === "length") return "length";
  if (r === "tool_calls" || r === "function_call") return "tool_use";
  return "stop";
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export const openAiCompatProvider: Provider = {
  async *chat(req: ChatRequest): AsyncIterable<LlmChunk> {
    if (!req.baseUrl) {
      yield { type: "error", message: "No server URL for the local model.", retryable: false };
      return;
    }
    const p = req.params ?? {};
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.top_p !== undefined ? { top_p: p.top_p } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
          }
        : {}),
      ...(p.extra ?? {}),
    };

    let res: Response;
    try {
      res = await fetch(`${req.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(req.apiKey) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      yield { type: "error", message: `Cannot reach ${req.baseUrl}. Is the local server running?`, retryable: true };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      yield {
        type: "error",
        message: `Local server returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        retryable: res.status >= 500,
        status: res.status,
      };
      return;
    }

    const think = new ThinkSplitter({ startsInThink: p.startsInThink });
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: FinishReason = "stop";
    let usage: Usage | undefined;
    const text: string[] = [];
    try {
      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") break;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.usage) {
          usage = { input_tokens: j.usage.prompt_tokens ?? 0, output_tokens: j.usage.completion_tokens ?? 0 };
        }
        const choice = j.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        const rc = d.reasoning_content ?? d.reasoning;
        if (typeof rc === "string" && rc) yield { type: "reasoning", text: rc };
        if (typeof d.content === "string" && d.content) {
          const s = think.push(d.content);
          if (s.reasoning) yield { type: "reasoning", text: s.reasoning };
          if (s.text) {
            text.push(s.text);
            yield { type: "text", text: s.text };
          }
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
        if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
      }
    } catch (err) {
      if (req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      yield { type: "error", message: `Stream from local server broke: ${String(err)}`, retryable: true };
      return;
    }
    const tail = think.flush();
    if (tail.reasoning) yield { type: "reasoning", text: tail.reasoning };
    if (tail.text) {
      text.push(tail.text);
      yield { type: "text", text: tail.text };
    }

    const blocks: unknown[] = [];
    if (text.length) blocks.push({ type: "text", text: text.join("") });
    if (finish !== "length") {
      for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
        let input: unknown;
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          // Hand the raw text over; the caller's schema check turns it into an error tool_result.
          input = { __invalid_json: c.args };
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
        yield { type: "tool_use", id: c.id, name: c.name, input };
      }
      if (calls.size) finish = "tool_use";
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "done", finishReason: finish, model: req.model };
  },
};

export async function listModels(opts: { baseUrl: string; apiKey?: string; signal?: AbortSignal }): Promise<string[]> {
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/models`, { headers: authHeaders(opts.apiKey), signal: opts.signal });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  const j: any = await res.json();
  return (j.data ?? []).map((m: any) => String(m.id));
}

export async function probe(opts: { baseUrl: string; apiKey?: string; timeoutMs?: number }): Promise<{ ok: boolean; models: string[]; latencyMs: number; message?: string }> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1500);
  try {
    const models = await listModels({ ...opts, signal: ctl.signal });
    return { ok: true, models, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, models: [], latencyMs: Date.now() - t0, message: ctl.signal.aborted ? "timed out" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
