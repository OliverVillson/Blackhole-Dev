// Claude Code provider: runs the `claude` CLI the user installed and signed into themselves
// (their Claude plan or their own Console key), headless with streaming JSON output.
// BlackHole-Dev never sees or stores the Claude login: the CLI does its own sign-in and auth.
//
// Each turn is one `claude -p` run. Claude Code's built-in tools are all switched off
// (`--tools ""`), so it cannot read, write or run anything on its own; the only tools it has
// are the copilot's, served from main over a local MCP bridge and executed by the copilot
// session exactly as for the other providers (gated actions still open the I4 confirm window).
// Conversation memory is Claude Code's own session, resumed by id on the next turn.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { startMcpBridge, type ToolRunner } from "./mcpBridge";
import type { ChatRequest, FinishReason, LlmChunk, LlmMessage, Provider } from "./types";

export const MCP_SERVER = "blackhole";

export interface ClaudeCodeStatus {
  installed: boolean;
  path?: string;
  version?: string;
  loggedIn: boolean;
  /** From `claude auth status`: claude.ai / oauth_token (a Claude plan), api_key, third_party, none. */
  authMethod?: string;
  /** One line for the panel: what is set up, or what to do next. */
  message: string;
}

const execText = (file: string, args: string[], opts: { timeout: number; env?: NodeJS.ProcessEnv }) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(file, args, { timeout: opts.timeout, env: opts.env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Apps started from the Dock get a bare PATH, so look where the installers put `claude`. */
export function candidatePaths(home = os.homedir(), envPath = process.env.PATH ?? ""): string[] {
  const fixed = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".bun/bin/claude"),
  ];
  const fromPath = envPath.split(path.delimiter).filter(Boolean).map((d) => path.join(d, "claude"));
  return [...new Set([...fromPath, ...fixed])];
}

let cachedBin: string | null = null;

/** BLACKHOLE_CLAUDE_BIN overrides (tests use a fake CLI). Then PATH, the usual install
 *  locations, and finally the login shell's PATH (catches nvm and custom setups). */
export async function findClaude(opts: { fresh?: boolean } = {}): Promise<string | null> {
  const forced = process.env.BLACKHOLE_CLAUDE_BIN;
  if (forced) return forced;
  if (cachedBin && !opts.fresh && existsSync(cachedBin)) return cachedBin;
  cachedBin = candidatePaths().find((p) => existsSync(p)) ?? null;
  if (!cachedBin && process.platform !== "win32") {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = await execText(shell, ["-lc", "command -v claude"], { timeout: 5000 });
    const p = r.stdout.trim().split("\n").pop() ?? "";
    if (r.code === 0 && p.startsWith("/") && existsSync(p)) cachedBin = p;
  }
  return cachedBin;
}

/** The CLI may be a Node script (npm install), so its folder and Homebrew go on PATH. */
export function childEnv(bin: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = [path.dirname(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const parts = [...(base.PATH ?? "").split(path.delimiter).filter(Boolean), ...extra];
  return { ...base, PATH: [...new Set(parts)].join(path.delimiter) };
}

export function describeAuth(method: string | undefined): string {
  switch (method) {
    case "claude.ai":
    case "oauth_token":
      return "your Claude plan";
    case "api_key":
    case "api_key_helper":
      return "an API key (billed to that key)";
    case "third_party":
      return "a cloud provider account";
    default:
      return "an unknown sign-in";
  }
}

export const SETUP_HINT =
  "Install Claude Code (curl -fsSL https://claude.ai/install.sh | bash), run `claude` once in Terminal and sign in with your Claude account, then press Check again.";

export async function claudeCodeStatus(): Promise<ClaudeCodeStatus> {
  const bin = await findClaude({ fresh: true });
  if (!bin) return { installed: false, loggedIn: false, message: `Claude Code is not installed. ${SETUP_HINT}` };
  const env = childEnv(bin);
  const v = await execText(bin, ["--version"], { timeout: 10_000, env });
  if (v.code !== 0) return { installed: false, path: bin, loggedIn: false, message: `Found ${bin} but it did not run (${(v.stderr || v.stdout).trim().slice(0, 160) || "no output"}).` };
  const version = v.stdout.trim().split(/\s+/)[0];
  const a = await execText(bin, ["auth", "status"], { timeout: 15_000, env });
  let info: { loggedIn?: boolean; authMethod?: string } = {};
  try {
    info = JSON.parse(a.stdout);
  } catch {
    /* older CLI without JSON output: fall back to the exit code */
  }
  const loggedIn = info.loggedIn ?? a.code === 0;
  if (!loggedIn) {
    return { installed: true, path: bin, version, loggedIn: false, authMethod: info.authMethod, message: `Claude Code ${version} is installed but not signed in. Run \`claude\` in Terminal, sign in with your Claude account, then press Check again.` };
  }
  return { installed: true, path: bin, version, loggedIn: true, authMethod: info.authMethod, message: `Claude Code ${version}, signed in with ${describeAuth(info.authMethod)}.` };
}

// ---- turn input ----

const blockText = (m: LlmMessage): string => {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? `Result of an earlier tool call:\n${b.content}` : ""))
    .filter(Boolean)
    .join("\n\n");
};

const sessionOf = (m: LlmMessage): string | undefined =>
  m.role === "assistant" && m.raw?.provider === "claude-code" ? (m.raw.content as { sessionId?: string })?.sessionId : undefined;

/** Claude Code keeps the conversation itself, so a turn sends only what is new since the last
 *  finished turn and resumes that session. Without one (first turn, or the user switched from
 *  another model mid-conversation) the earlier messages go along as a transcript. */
export function turnInput(messages: LlmMessage[]): { resume?: string; prompt: string } {
  let i = messages.length - 1;
  while (i >= 0 && !sessionOf(messages[i])) i--;
  const resume = i >= 0 ? sessionOf(messages[i]) : undefined;
  const tail = messages.slice(i + 1);
  const parts: string[] = [];
  const lastUser = (() => {
    for (let j = tail.length - 1; j >= 0; j--) if (tail[j].role === "user") return j;
    return -1;
  })();
  tail.forEach((m, j) => {
    const text = blockText(m).trim();
    if (!text) return;
    if (m.role === "assistant") {
      const t = text.length > 4000 ? `…${text.slice(-4000)}` : text;
      parts.push(resume ? `(Your previous reply was cut off. It read:)\n${t}` : `Earlier, you replied:\n${t}`);
    } else if (!resume && j < lastUser) parts.push(`Earlier, the user wrote:\n${text}`);
    else parts.push(text);
  });
  return { resume, prompt: parts.join("\n\n") };
}

export function buildArgs(o: { model?: string; effort?: string; system?: string; resume?: string; mcpConfig: string }): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format", "text",
    // No built-in tools at all: no Bash, file reads or edits, web, subagents.
    "--tools", "",
    // Only the copilot's own tools, nothing from the user's MCP configs.
    "--strict-mcp-config",
    "--mcp-config", o.mcpConfig,
    "--allowedTools", `mcp__${MCP_SERVER}`,
    // Anything not pre-approved is denied instead of waiting on a prompt nobody can answer.
    "--permission-mode", "dontAsk",
    "--disable-slash-commands",
  ];
  if (o.system) args.push("--system-prompt", o.system);
  if (o.model && o.model !== "default") args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.resume) args.push("--resume", o.resume);
  return args;
}

export const TOOL_NOTE = `\n\n# Tool names here\n\nYour tools come from an MCP server named ${MCP_SERVER}: read_file is mcp__${MCP_SERVER}__read_file, and so on. You have no other tools.\n\nHere you work in a tool loop: write files with the write_file tool (it types into the user's editor) and change them with edit_file, so they are in the editor before you lint, plan or read them. Do not use path= fences.`;

// ---- stream-json → LlmChunk ----

export function errorFromResult(text: string): { message: string; retryable: boolean } {
  const t = text.trim();
  if (/not logged in|\/login|please run .*login|invalid api key|authentication/i.test(t)) {
    return { message: "Claude Code is not signed in. Run `claude` in Terminal and sign in, then press Check in the Copilot panel.", retryable: false };
  }
  if (/usage limit|limit reached|out of (extra )?usage|rate.?limit/i.test(t)) {
    return { message: `Your Claude plan's usage limit is reached for now. ${t}`.trim(), retryable: false };
  }
  if (/overloaded|529|timed? ?out|ECONNRESET|network/i.test(t)) return { message: `Claude Code: ${t}`, retryable: true };
  return { message: `Claude Code: ${t || "the run failed with no message."}`, retryable: false };
}

export interface StreamState {
  sessionId?: string;
  model?: string;
  emitted: boolean;
  /** Text so far ends in a newline (or nothing written yet). */
  atLineStart: boolean;
  sawResult: boolean;
}

export function newStreamState(): StreamState {
  return { emitted: false, atLineStart: true, sawResult: false };
}

/** Maps one stream-json line to chunks. Subagent events (parent_tool_use_id set) are skipped. */
export function mapEvent(ev: any, st: StreamState): LlmChunk[] {
  if (!ev || typeof ev !== "object") return [];
  if (typeof ev.session_id === "string") st.sessionId = ev.session_id;
  if (ev.parent_tool_use_id) return [];
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init" && typeof ev.model === "string") st.model = ev.model;
      return [];
    case "stream_event": {
      const e = ev.event;
      if (e?.type === "message_start") {
        // Keep consecutive assistant messages from running together (a fence must start a line).
        if (st.emitted && !st.atLineStart) {
          st.atLineStart = true;
          return [{ type: "text", text: "\n\n" }];
        }
        return [];
      }
      if (e?.type === "content_block_delta") {
        if (e.delta?.type === "text_delta" && e.delta.text) {
          st.emitted = true;
          st.atLineStart = e.delta.text.endsWith("\n");
          return [{ type: "text", text: e.delta.text }];
        }
        if (e.delta?.type === "thinking_delta") return [{ type: "reasoning", text: e.delta.thinking ?? "" }];
      }
      return [];
    }
    case "result": {
      st.sawResult = true;
      const out: LlmChunk[] = [];
      const u = ev.usage;
      if (u && typeof u.input_tokens === "number") {
        out.push({ type: "usage", usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? undefined } });
      }
      if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
        const text = typeof ev.result === "string" && ev.result ? ev.result : Array.isArray(ev.errors) ? ev.errors.join("; ") : String(ev.subtype ?? "error");
        out.push({ type: "error", status: ev.api_error_status ?? undefined, ...errorFromResult(text) });
        return out;
      }
      const stop: FinishReason = ev.stop_reason === "max_tokens" ? "length" : ev.stop_reason === "refusal" ? "refusal" : "stop";
      out.push({ type: "done", finishReason: stop, raw: st.sessionId ? { provider: "claude-code", content: { sessionId: st.sessionId } } : undefined, model: st.model });
      return out;
    }
    default:
      return [];
  }
}

// ---- the provider ----

export const claudeCodeProvider: Provider = {
  async *chat(req: ChatRequest): AsyncIterable<LlmChunk> {
    const bin = await findClaude();
    if (!bin) {
      yield { type: "error", message: `Claude Code is not installed. ${SETUP_HINT}`, retryable: false };
      return;
    }
    const runTool: ToolRunner = req.runTool ?? (async (name) => ({ content: `Tool ${name} is not available here.`, isError: true }));
    const bridge = await startMcpBridge(req.tools ?? [], runTool, MCP_SERVER);
    const mcpConfig = JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } } });
    const { resume, prompt } = turnInput(req.messages);
    const args = buildArgs({
      model: req.model,
      effort: req.params?.effort,
      system: req.system ? req.system + TOOL_NOTE : undefined,
      resume,
      mcpConfig,
    });

    let child: ChildProcess;
    const st = newStreamState();
    let stderr = "";
    let spawnError: Error | null = null;
    try {
      child = spawn(bin, args, { cwd: req.cwd && existsSync(req.cwd) ? req.cwd : os.homedir(), env: childEnv(bin), stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      await bridge.close();
      yield { type: "error", message: `Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}`, retryable: false };
      return;
    }
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (err) => {
        spawnError = err;
        resolve(null);
      });
      child.once("close", (code) => resolve(code));
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => (stderr = (stderr + c).slice(-4000)));
    const onAbort = () => child.kill("SIGTERM");
    req.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);

    let ended = false;
    try {
      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let ev: unknown;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        for (const c of mapEvent(ev, st)) {
          if (ended) continue;
          yield c;
          if (c.type === "done" || c.type === "error") ended = true;
        }
      }
      const code = await exited;
      if (ended) return;
      if (req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted", raw: st.sessionId ? { provider: "claude-code", content: { sessionId: st.sessionId } } : undefined };
        return;
      }
      const err = spawnError as Error | null;
      if (err) {
        yield { type: "error", message: (err as NodeJS.ErrnoException).code === "ENOENT" ? `Claude Code is not installed. ${SETUP_HINT}` : `Could not start Claude Code: ${err.message}`, retryable: false };
        return;
      }
      yield { type: "error", ...errorFromResult(stderr.trim() || `claude exited with code ${code} and no result.`) };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      await bridge.close();
    }
  },
};

/** "Test connection": the install and sign-in check, then one tiny real run with no tools. */
export async function testClaudeCode(model = "default", signal?: AbortSignal): Promise<{ ok: boolean; message: string; model?: string; latencyMs?: number }> {
  const st = await claudeCodeStatus();
  if (!st.loggedIn || !st.path) return { ok: false, message: st.message };
  const t0 = Date.now();
  const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--effort", "low"];
  if (model !== "default") args.push("--model", model);
  args.push("Reply with the single word: ready");
  return new Promise((resolve) => {
    const child = execFile(st.path!, args, { timeout: 120_000, env: childEnv(st.path!), cwd: os.homedir(), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let r: any = null;
      try {
        r = JSON.parse(String(stdout));
      } catch {
        /* not JSON */
      }
      if (r && !r.is_error) {
        const used = r.modelUsage ? Object.keys(r.modelUsage)[0] : undefined;
        resolve({ ok: true, message: `${st.message} Answered in ${((Date.now() - t0) / 1000).toFixed(1)} s.`, model: used, latencyMs: Date.now() - t0 });
      } else {
        resolve({ ok: false, message: errorFromResult(r?.result ?? (String(stderr) || (err ? err.message : "no output"))).message });
      }
    });
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  });
}
