// Live check against a real, signed-in `claude` CLI. Skipped unless BLACKHOLE_LIVE_CLAUDE=1,
// because it spends a little of the signed-in plan's usage.
import { describe, expect, it } from "vitest";
import { chat, claudeCodeStatus, type LlmChunk } from "../../src/llm";

const live = process.env.BLACKHOLE_LIVE_CLAUDE === "1";

describe.skipIf(!live)("claude-code provider (live)", () => {
  it("streams text and calls a bridged tool, then resumes the session", async () => {
    const st = await claudeCodeStatus();
    expect(st.loggedIn, st.message).toBe(true);
    const calls: [string, unknown][] = [];
    const tools = [{ name: "list_files", description: "List recipe files in the workspace.", input_schema: { type: "object" as const, properties: {} } }];
    const runTool = async (name: string, input: unknown) => {
      calls.push([name, input]);
      return { content: "recipes/qwen-mac.py\nrecipes/flint.py" };
    };
    const out: LlmChunk[] = [];
    for await (const c of chat({
      provider: "claude-code",
      model: "haiku",
      system: "You are a test assistant. Use your tools when asked.",
      messages: [{ role: "user", content: "Call list_files once, then answer with the number of files it listed, as a digit only." }],
      tools,
      runTool,
      params: { effort: "low" },
    })) out.push(c);
    const err = out.find((c) => c.type === "error");
    expect(err, JSON.stringify(err)).toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["list_files"]);
    const text = out.filter((c) => c.type === "text").map((c: any) => c.text).join("");
    expect(text).toContain("2");
    const done = out.find((c) => c.type === "done") as Extract<LlmChunk, { type: "done" }>;
    expect(done.raw?.provider).toBe("claude-code");

    const out2: LlmChunk[] = [];
    for await (const c of chat({
      provider: "claude-code",
      model: "haiku",
      system: "You are a test assistant. Use your tools when asked.",
      messages: [
        { role: "user", content: "Call list_files once…" },
        { role: "assistant", content: text, raw: done.raw },
        { role: "user", content: "What was the first file name it listed? Reply with the path only." },
      ],
      tools,
      runTool,
      params: { effort: "low" },
    })) out2.push(c);
    const text2 = out2.filter((c) => c.type === "text").map((c: any) => c.text).join("");
    expect(text2).toContain("qwen-mac.py");
  }, 180_000);
});
