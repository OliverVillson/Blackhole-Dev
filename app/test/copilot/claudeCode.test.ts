import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chat, claudeCodeStatus, type LlmChunk, type LlmMessage } from "../../src/llm";
import { buildArgs, childEnv, errorFromResult, mapEvent, newStreamState, turnInput } from "../../src/llm/claudeCode";
import { startMcpBridge } from "../../src/llm/mcpBridge";
import { normalizeSettings } from "../../src/copilot/main";
import { CopilotSession, type CopilotEvent, type TurnChunk } from "../../src/copilot/session";
import { llmTools } from "../../src/copilot/tools";
import { FakeEditor } from "./fakeEditor";

const FAKE = path.resolve(__dirname, "../fixtures/fake-claude.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bh-cc-"));
const LOG = path.join(tmp, "runs.jsonl");
const runs = () => fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

process.env.BLACKHOLE_CLAUDE_BIN = FAKE;
process.env.FAKE_CLAUDE_LOG = LOG;
afterAll(() => {
  delete process.env.BLACKHOLE_CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(LOG, { force: true });
  delete process.env.FAKE_CLAUDE_AUTH;
});

async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const textOf = (cs: LlmChunk[]) => cs.filter((c) => c.type === "text").map((c: any) => c.text).join("");

describe("turnInput", () => {
  it("sends only what is new and resumes the last finished Claude Code session", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "make a recipe" },
      { role: "assistant", content: [{ type: "text", text: "done" }], raw: { provider: "claude-code", content: { sessionId: "s1" } } },
      { role: "user", content: [{ type: "text", text: "now bump the version" }] },
    ];
    expect(turnInput(msgs)).toEqual({ resume: "s1", prompt: "now bump the version" });
  });

  it("carries a cut-off reply and the steer after it", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "ok", raw: { provider: "claude-code", content: { sessionId: "s1" } } },
      { role: "user", content: "b" },
      { role: "assistant", content: [{ type: "text", text: "half a reci" }] },
      { role: "user", content: [{ type: "text", text: "The user says: use 64 samples" }] },
    ];
    const r = turnInput(msgs);
    expect(r.resume).toBe("s1");
    expect(r.prompt).toBe("b\n\n(Your previous reply was cut off. It read:)\nhalf a reci\n\nThe user says: use 64 samples");
  });

  it("without a session, sends the earlier conversation as a transcript", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "from another model", raw: { provider: "anthropic", content: [] } },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "lint clean" }, { type: "text", text: "next" }] },
    ];
    const r = turnInput(msgs);
    expect(r.resume).toBeUndefined();
    expect(r.prompt).toBe("Earlier, the user wrote:\na\n\nEarlier, you replied:\nfrom another model\n\nResult of an earlier tool call:\nlint clean\n\nnext");
  });
});

describe("Claude Code arguments and stream mapping", () => {
  it("switches every built-in tool off and allows only the copilot's MCP tools", () => {
    const a = buildArgs({ model: "opus", effort: "high", system: "SYS", resume: "s1", mcpConfig: "{}" });
    const at = (f: string) => a[a.indexOf(f) + 1];
    expect(at("--tools")).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(at("--allowedTools")).toBe("mcp__blackhole");
    expect(at("--permission-mode")).toBe("dontAsk");
    expect(at("--output-format")).toBe("stream-json");
    expect(a).toContain("--include-partial-messages");
    expect(at("--system-prompt")).toBe("SYS");
    expect(at("--model")).toBe("opus");
    expect(at("--effort")).toBe("high");
    expect(at("--resume")).toBe("s1");
    // Never bare mode: it skips the Keychain, where the Claude sign-in lives on a Mac.
    expect(a).not.toContain("--bare");
    expect(buildArgs({ model: "default", mcpConfig: "{}" })).not.toContain("--model");
  });

  it("separates consecutive assistant messages so a fence starts on its own line", () => {
    const st = newStreamState();
    const text = (t: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    const start = { type: "stream_event", event: { type: "message_start" } };
    const got = [start, text("Checking"), start, text("```python"), start, text("x\n"), start].flatMap((e) => mapEvent(e, st));
    expect(got.map((c: any) => c.text).join("|")).toBe("Checking|\n\n|```python|\n\n|x\n");
  });

  it("maps sign-in and usage-limit failures to plain messages", () => {
    expect(errorFromResult("Not logged in · Please run /login").message).toContain("not signed in");
    expect(errorFromResult("Claude usage limit reached. Your limit will reset at 5pm").message).toContain("usage limit");
    expect(errorFromResult("API Error: 529 overloaded").retryable).toBe(true);
  });

  it("adds the CLI's folder to PATH for apps started from the Dock", () => {
    const env = childEnv("/Users/me/.nvm/versions/node/v22/bin/claude", { PATH: "/usr/bin:/bin" });
    expect(env.PATH!.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/Users/me/.nvm/versions/node/v22/bin", "/opt/homebrew/bin"]));
  });

  it("keeps claude-code settings and falls back on bad values", () => {
    expect(normalizeSettings({ provider: "claude-code", model: "sonnet", effort: "low" })).toEqual({ provider: "claude-code", model: "sonnet", effort: "low" });
    expect(normalizeSettings({ provider: "claude-code", model: "gpt-9", effort: "huge" as any })).toEqual({ provider: "claude-code", model: "default", effort: "high" });
  });
});

describe("MCP bridge", () => {
  it("refuses callers without the token and answers the MCP handshake", async () => {
    const b = await startMcpBridge(llmTools(), async () => ({ content: "x" }));
    try {
      const post = (body: object, auth = true) =>
        fetch(b.url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${b.token}` } : {}) }, body: JSON.stringify(body) });
      expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false)).status).toBe(401);
      const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
      expect(init.result.protocolVersion).toBe("2025-06-18");
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      expect(list.result.tools.map((t: any) => t.name)).toContain("request_action");
      const bad = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "Bash", arguments: {} } })).json();
      expect(bad.error.message).toContain("Unknown tool");
    } finally {
      await b.close();
    }
  });
});

describe("claude-code provider (fake CLI)", () => {
  it("reports install and sign-in status", async () => {
    const ok = await claudeCodeStatus();
    expect(ok).toMatchObject({ installed: true, loggedIn: true, version: "9.9.9", authMethod: "claude.ai" });
    expect(ok.message).toContain("your Claude plan");
    process.env.FAKE_CLAUDE_AUTH = "none";
    const no = await claudeCodeStatus();
    expect(no).toMatchObject({ installed: true, loggedIn: false });
    expect(no.message).toContain("not signed in");
  });

  it("says how to install when there is no CLI", async () => {
    process.env.BLACKHOLE_CLAUDE_BIN = path.join(tmp, "missing-claude");
    try {
      const out = await collect(chat({ provider: "claude-code", model: "default", messages: [{ role: "user", content: "hi" }] }));
      expect(out.at(-1)).toMatchObject({ type: "error", retryable: false });
      expect((out.at(-1) as any).message).toContain("not installed");
    } finally {
      process.env.BLACKHOLE_CLAUDE_BIN = FAKE;
    }
  });

  it("streams text, runs tool calls through runTool, and resumes the session next turn", async () => {
    const calls: [string, unknown][] = [];
    const runTool = async (name: string, input: unknown) => {
      calls.push([name, input]);
      return { content: "lint: clean" };
    };
    const req = { provider: "claude-code" as const, model: "opus", system: "SYS", tools: llmTools(), runTool, cwd: tmp, params: { effort: "high" as const } };
    const out = await collect(chat({ ...req, messages: [{ role: "user", content: "make one" }] }));
    expect(out.find((c) => c.type === "error")).toBeUndefined();
    expect(calls).toEqual([["lint_recipe", { path: "recipes/r.py" }]]);
    const text = textOf(out);
    expect(text).toContain(`I have ${llmTools().length} tools.`);
    expect(text).toContain("```python path=recipes/r.py mode=new\nrecipe = 1\n```");
    expect(text).toContain("Linting\n\nLint said: lint: clean");
    expect(text).not.toContain("SUBAGENT");
    expect(out.some((c) => c.type === "reasoning")).toBe(true);
    const done = out.at(-1) as Extract<LlmChunk, { type: "done" }>;
    expect(done).toMatchObject({ type: "done", finishReason: "stop", model: "claude-opus-5-5", raw: { provider: "claude-code", content: { sessionId: "sess-1" } } });

    const r1 = runs()[0];
    expect(r1.stdin).toBe("make one");
    expect(fs.realpathSync(r1.cwd)).toBe(fs.realpathSync(tmp));
    expect(r1.argv[r1.argv.indexOf("--system-prompt") + 1]).toMatch(/^SYS[\s\S]*mcp__blackhole__read_file/);
    expect(r1.argv).not.toContain("--resume");

    await collect(chat({ ...req, messages: [{ role: "user", content: "make one" }, { role: "assistant", content: text, raw: done.raw }, { role: "user", content: "again" }] }));
    const r2 = runs()[1];
    expect(r2.argv[r2.argv.indexOf("--resume") + 1]).toBe("sess-1");
    expect(r2.stdin).toBe("again");
  });

  it("turns a signed-out run into a sign-in hint", async () => {
    process.env.FAKE_CLAUDE_AUTH = "none";
    const out = await collect(chat({ provider: "claude-code", model: "default", messages: [{ role: "user", content: "hi" }] }));
    expect(out.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect((out.at(-1) as any).message).toContain("not signed in");
  });

  it("stops the CLI on abort", async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    const out: LlmChunk[] = [];
    for await (const c of chat({ provider: "claude-code", model: "default", messages: [{ role: "user", content: "slow please" }], signal: ctl.signal })) {
      out.push(c);
      if (c.type === "text") ctl.abort();
    }
    expect(out.at(-1)).toMatchObject({ type: "done", finishReason: "aborted" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe("CopilotSession with in-turn tool calls", () => {
  it("runs a tool_run call after the typed code lands and answers it, without a second turn", async () => {
    const ed = new FakeEditor();
    const results: [string, any][] = [];
    const helperCalls: [string, any][] = [];
    let turns = 0;
    let answered!: () => void;
    const gotAnswer = new Promise<void>((r) => (answered = r));
    let tick: (() => void) | null = null;
    const timer = setInterval(() => { for (let i = 0; i < 50; i++) tick?.(); }, 1);
    const session = new CopilotSession({
      editor: ed,
      activeFile: () => null,
      async *turn(): AsyncIterable<TurnChunk> {
        turns++;
        yield { type: "text", text: "```python path=recipes/r.py mode=new\nrecipe = 1\n```\n" };
        yield { type: "tool_run", callId: "c1", name: "lint_recipe", input: { path: "recipes/r.py" } };
        await gotAnswer;
        yield { type: "text", text: "Clean." };
        yield { type: "done", finishReason: "stop", raw: { provider: "claude-code", content: { sessionId: "s" } } };
      },
      abortTurn: () => {},
      toolResult: (id, r) => {
        results.push([id, r]);
        answered();
      },
      helper: async (method, params) => {
        helperCalls.push([method, params]);
        return { problems: [] };
      },
      invoke: async () => ({}),
      every: (_ms, fn) => {
        tick = fn;
        return () => (tick = null);
      },
      pacer: { lookaheadLines: 1, charsPerTick: 4 },
    });
    const events: CopilotEvent[] = [];
    session.on((e) => events.push(e));
    await session.ask("make one");
    clearInterval(timer);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(turns).toBe(1);
    expect(helperCalls[0]).toEqual(["recipe.lint", { path: "recipes/r.py", text: "recipe = 1\n" }]);
    expect(results).toEqual([["c1", { content: '{"problems":[]}', isError: undefined }]]);
    expect(events.some((e) => e.type === "tool" && e.status === "ok" && e.summary === "lint: clean")).toBe(true);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", raw: { provider: "claude-code" } });
  });
});
