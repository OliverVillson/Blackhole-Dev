#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests: answers --version and `auth status`, and for -p runs
// prints stream-json like Claude Code, calling the copilot's tools over the --mcp-config bridge.
// FAKE_CLAUDE_LOG: file to append each run's argv + stdin to. FAKE_CLAUDE_AUTH: "none" = signed out.
import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const none = process.env.FAKE_CLAUDE_AUTH === "none";
  console.log(JSON.stringify({ loggedIn: !none, authMethod: none ? "none" : "claude.ai", apiProvider: "firstParty" }));
  process.exit(none ? 1 : 0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) stdin += c;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + "\n");

const session = flag("--resume") ?? "sess-1";
const sessionEv = { session_id: session, parent_tool_use_id: null };
const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, ...sessionEv });
const result = (extra) => out({ type: "result", subtype: "success", is_error: false, result: "", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, ...sessionEv, ...extra });

if (process.env.FAKE_CLAUDE_AUTH === "none") {
  out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", ...sessionEv });
  process.exit(1);
}

out({ type: "system", subtype: "init", model: "claude-opus-5-5", tools: [], mcp_servers: [{ name: "blackhole", status: "connected" }], ...sessionEv });

if (argv.includes("--output-format") && flag("--output-format") === "json") {
  console.log(JSON.stringify({ type: "result", is_error: false, result: "ready", modelUsage: { "claude-haiku-5-5": {} } }));
  process.exit(0);
}

const mcp = JSON.parse(flag("--mcp-config")).mcpServers.blackhole;
let rpcId = 0;
const rpc = async (method, params) => {
  const r = await fetch(mcp.url, { method: "POST", headers: { ...mcp.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return (await r.json()).result;
};

if (stdin.includes("slow")) {
  delta("Working");
  await new Promise((r) => setTimeout(r, 30_000));
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
const list = await rpc("tools/list", {});

out({ type: "stream_event", event: { type: "message_start", message: {} }, ...sessionEv });
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } }, ...sessionEv });
delta(`I have ${list.tools.length} tools. Writing it.\n\n\`\`\`python path=recipes/r.py mode=new\nrecipe = 1\n\`\`\`\nLinting`);
// A subagent's text must not leak into the stream.
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUBAGENT" } }, session_id: session, parent_tool_use_id: "toolu_x" });
const lint = await rpc("tools/call", { name: "lint_recipe", arguments: { path: "recipes/r.py" } });
out({ type: "stream_event", event: { type: "message_start", message: {} }, ...sessionEv });
delta(`Lint said: ${lint.content[0].text}`);
result();
