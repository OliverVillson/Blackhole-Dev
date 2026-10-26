import http from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chat, type LlmChunk } from "../../src/llm";
import { setAnthropicClientFactory } from "../../src/llm/anthropic";

let server: http.Server;
let base = "";
const bodies: Record<string, any> = {};

const sse = (events: [string, object][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const ANTHROPIC_STREAM = sse([
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check experts." } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading anatomy." } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "open_model", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"model\": \"Qwen/" } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "Qwen3-30B-A3B\"}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } }],
  ["message_stop", { type: "message_stop" }],
]);

const oa = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const OPENAI_STREAM =
  oa({ choices: [{ index: 0, delta: { role: "assistant", content: "<thi" } }] }) +
  oa({ choices: [{ index: 0, delta: { content: "nk>hmm</think>Hello " } }] }) +
  oa({ choices: [{ index: 0, delta: { content: "there" } }] }) +
  oa({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lint_recipe", arguments: "{\"path\":" } }] } }] }) +
  oa({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"r.py\"}" } }] }, finish_reason: "tool_calls" }] }) +
  oa({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }) +
  "data: [DONE]\n\n";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/messages")) {
        bodies.anthropic = { body: JSON.parse(b), headers: req.headers };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(ANTHROPIC_STREAM);
      } else if (req.url === "/v1/chat/completions") {
        bodies.openai = JSON.parse(b);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(OPENAI_STREAM);
      } else if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen3.6-blackhole-9.8GB" }] }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setAnthropicClientFactory((apiKey) => new Anthropic({ apiKey, baseURL: base, maxRetries: 0 }));
});
afterAll(() => server.close());

async function all(it: AsyncIterable<LlmChunk>) {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("anthropic provider", () => {
  it("streams text, reasoning and a parsed tool call, and returns raw content", async () => {
    const out = await all(chat({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-test", system: "sys", messages: [{ role: "user", content: "hi" }], tools: [{ name: "open_model", description: "d", input_schema: { type: "object", properties: { model: { type: "string" } }, required: ["model"] } }] }));
    expect(out.filter((c) => c.type === "text").map((c: any) => c.text).join("")).toBe("Reading anatomy.");
    expect(out.some((c) => c.type === "reasoning")).toBe(true);
    expect(out.find((c) => c.type === "tool_use")).toMatchObject({ name: "open_model", input: { model: "Qwen/Qwen3-30B-A3B" } });
    const done: any = out.at(-1);
    expect(done).toMatchObject({ type: "done", finishReason: "tool_use" });
    expect(done.raw.content[0].type).toBe("thinking");

    const { body, headers } = bodies.anthropic;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.tools[0].eager_input_streaming).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.temperature).toBeUndefined();
  });

  it("replays raw assistant content unchanged", async () => {
    const raw = [{ type: "thinking", thinking: "x", signature: "sig" }, { type: "text", text: "ok" }];
    await all(chat({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "k", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "ok", raw: { provider: "anthropic", content: raw } }, { role: "user", content: "b" }] }));
    expect(bodies.anthropic.body.messages[1].content).toEqual(raw);
  });

  it("errors without a key", async () => {
    const out = await all(chat({ provider: "anthropic", model: "claude-opus-5-5", messages: [] }));
    expect(out[0]).toMatchObject({ type: "error", retryable: false });
  });
});

describe("openai-compatible provider", () => {
  it("splits think tags, assembles tool calls and maps usage", async () => {
    const out = await all(chat({ provider: "openai-compatible", baseUrl: `${base}/v1`, model: "m", system: "s", messages: [{ role: "user", content: "hi" }], params: { max_tokens: 100, extra: { repetition_penalty: 1.1 } }, tools: [{ name: "lint_recipe", description: "d", input_schema: { type: "object", properties: {} } }] }));
    expect(out.filter((c) => c.type === "text").map((c: any) => c.text).join("")).toBe("Hello there");
    expect(out.filter((c) => c.type === "reasoning").map((c: any) => c.text).join("")).toBe("hmm");
    expect(out.find((c) => c.type === "tool_use")).toMatchObject({ id: "c1", name: "lint_recipe", input: { path: "r.py" } });
    expect(out.find((c) => c.type === "usage")).toMatchObject({ usage: { input_tokens: 12, output_tokens: 7 } });
    expect(out.at(-1)).toMatchObject({ type: "done", finishReason: "tool_use" });
    expect(bodies.openai.stream_options).toEqual({ include_usage: true });
    expect(bodies.openai.repetition_penalty).toBe(1.1);
    expect(bodies.openai.messages[0]).toEqual({ role: "system", content: "s" });
  });

  it("reports an unreachable server as a retryable error", async () => {
    const out = await all(chat({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m", messages: [] }));
    expect(out[0]).toMatchObject({ type: "error", retryable: true });
  });
});
