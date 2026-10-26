// API key handling, model/effort settings and "Test connection" (copilot main side + I5).
import http from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activate, keyHint, keyProblem, normalizeSettings } from "../../src/copilot/main";
import { chat, testAnthropicConnection, type LlmChunk } from "../../src/llm";
import { setAnthropicClientFactory } from "../../src/llm/anthropic";

const GOOD = "sk-ant-api03-good-key-x7Qa";
const BROKE = "sk-ant-api03-no-credit-1234";
let server: http.Server;
let base = "";
const seen: { url: string; body: any; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      seen.push({ url: req.url ?? "", body: b ? JSON.parse(b) : null, headers: req.headers });
      const json = (status: number, o: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (key !== GOOD && key !== BROKE) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (req.url?.startsWith("/v1/models/")) {
        const id = req.url.split("/").pop();
        if (id === "claude-nope") return json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } });
        return json(200, { type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" });
      }
      if (req.url?.startsWith("/v1/messages")) {
        if (key === BROKE) return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
        const body = JSON.parse(b);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const ev = (e: string, d: object) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
          return res.end(
            ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
              ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
              ev("message_stop", { type: "message_stop" }),
          );
        }
        return json(200, { id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ready" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 2 } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setAnthropicClientFactory((apiKey) => new Anthropic({ apiKey, baseURL: base, maxRetries: 0 }));
});
afterAll(() => server.close());

function fakeCtx() {
  const handlers = new Map<string, (...a: any[]) => any>();
  const store = new Map<string, string>();
  const settings = new Map<string, unknown>();
  const ctx: any = {
    module: "copilot",
    handle: (c: string, fn: any) => handlers.set(c, fn),
    send: () => {},
    secrets: {
      get: async (n: string) => store.get(n) ?? null,
      set: async (n: string, v: string) => void store.set(n, v),
      delete: async (n: string) => void store.delete(n),
      has: async (n: string) => store.has(n),
      available: () => true,
    },
    settings: { get: (k: string, f: unknown) => (settings.has(k) ? settings.get(k) : f), set: (k: string, v: unknown) => settings.set(k, v) },
    helper: { call: async () => ({}) },
  };
  activate(ctx);
  const call = (c: string, ...a: any[]) => handlers.get(c)!(...a);
  return { call, store, settings };
}

describe("copilot API key", () => {
  it("checks the format before any request", () => {
    expect(keyProblem("")).toMatch(/Paste/);
    expect(keyProblem("sk-proj-abc")).toMatch(/sk-ant-/);
    expect(keyProblem("sk-ant-admin01-x")).toMatch(/Admin/);
    expect(keyProblem("sk-ant-api03 abc")).toMatch(/space/);
    expect(keyProblem(GOOD)).toBeNull();
    expect(keyHint(GOOD)).toBe("sk-ant-…x7Qa");
  });

  it("stores a working key encrypted and only ever returns a hint", async () => {
    const { call, store } = fakeCtx();
    const r = await call("copilot:setKey", `  ${GOOD}\n`);
    expect(r).toMatchObject({ ok: true, saved: true });
    expect(store.get("anthropic-api-key")).toBe(GOOD);
    const st = await call("copilot:keyStatus");
    expect(st).toEqual({ has: true, hint: "sk-ant-…x7Qa", encryption: true });
    expect(JSON.stringify(st)).not.toContain(GOOD);
    expect(await call("copilot:deleteKey")).toMatchObject({ has: false, hint: null });
    expect(store.size).toBe(0);
  });

  it("never stores a key Anthropic rejects", async () => {
    const { call, store } = fakeCtx();
    const r = await call("copilot:setKey", "sk-ant-api03-wrong");
    expect(r).toMatchObject({ ok: false, saved: false });
    expect(r.message).toMatch(/rejected the API key/);
    expect(store.size).toBe(0);
  });

  it("keeps a key it could not check because the network is down, and says so", async () => {
    setAnthropicClientFactory((apiKey) => new Anthropic({ apiKey, baseURL: "http://127.0.0.1:1", maxRetries: 0 }));
    try {
      const { call, store } = fakeCtx();
      const r = await call("copilot:setKey", GOOD);
      expect(r).toMatchObject({ ok: false, saved: true });
      expect(r.message).toMatch(/could not check/);
      expect(store.get("anthropic-api-key")).toBe(GOOD);
    } finally {
      setAnthropicClientFactory((apiKey) => new Anthropic({ apiKey, baseURL: base, maxRetries: 0 }));
    }
  });
});

describe("test connection", () => {
  it("reports success with the model name", async () => {
    const r = await testAnthropicConnection(GOOD, "claude-sonnet-5-5");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Connected to Claude Sonnet 5\.5/);
    const sent = seen.filter((s) => s.url.startsWith("/v1/messages")).at(-1)!.body;
    expect(sent.output_config).toEqual({ effort: "low" });
    expect(sent.max_tokens).toBeLessThanOrEqual(64);
  });

  it("gives a clear error for a bad key, a missing model and no credit", async () => {
    expect((await testAnthropicConnection("sk-ant-bad", "claude-opus-5-5")).message).toMatch(/rejected the API key/);
    expect((await testAnthropicConnection(GOOD, "claude-nope")).message).toMatch(/Model not found/);
    expect((await testAnthropicConnection(BROKE, "claude-opus-5-5")).message).toMatch(/credit balance is too low/);
  });

  it("tests the provider picked in the panel", async () => {
    const { call } = fakeCtx();
    expect((await call("copilot:test")).message).toMatch(/No API key/);
    await call("copilot:setKey", GOOD);
    await call("copilot:setSettings", { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" });
    expect((await call("copilot:test")).message).toMatch(/Claude Haiku 5\.5/);
    await call("copilot:setSettings", { provider: "openai-compatible", preset: "mlx", baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    expect((await call("copilot:test")).message).toMatch(/No server at/);
  });
});

describe("model and effort settings", () => {
  it("normalizes bad or old values", () => {
    expect(normalizeSettings({ provider: "anthropic", model: "claude-gone", effort: "huge" } as any)).toEqual({ provider: "anthropic", model: "claude-opus-5-5", effort: "high" });
    expect(normalizeSettings({ provider: "anthropic", model: "claude-sonnet-5-5" } as any)).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" });
    expect(normalizeSettings({ provider: "anthropic", model: "claude-haiku-5-5", effort: "max" })).toMatchObject({ effort: "max" });
  });

  it("sends the picked effort, and no refusal fallback for Haiku", async () => {
    const run = async (model: string) => {
      const out: LlmChunk[] = [];
      for await (const c of chat({ provider: "anthropic", model, apiKey: GOOD, messages: [{ role: "user", content: "hi" }], params: { effort: "xhigh" } })) out.push(c);
      return seen.filter((s) => s.url.startsWith("/v1/messages")).at(-1)!;
    };
    const haiku = await run("claude-haiku-5-5");
    expect(haiku.body.output_config).toEqual({ effort: "xhigh" });
    expect(haiku.body.fallbacks).toBeUndefined();
    expect(String(haiku.headers["anthropic-beta"] ?? "")).not.toContain("server-side-fallback");
    const sonnet = await run("claude-sonnet-5-5");
    expect(sonnet.body.fallbacks).toBe("default");
  });
});
