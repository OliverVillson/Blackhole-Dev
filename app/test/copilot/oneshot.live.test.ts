// End-to-end dry run of the copilot on a real request, against a real signed-in `claude` CLI
// (the Claude Code provider) and the real Python helper (lint, plan, functions, anatomy).
// Skipped unless BLACKHOLE_LIVE_ONESHOT=1, because it spends the signed-in plan's usage.
//
//   BLACKHOLE_LIVE_ONESHOT=1 BLACKHOLE_PY=~/bhdev-venv/bin/python \
//     [BLACKHOLE_ONESHOT_PROMPT="..."] [BLACKHOLE_ONESHOT_MODEL=opus] npx vitest run test/copilot/oneshot.live.test.ts
//
// It writes the workspace, the transcript (tool calls, prose) and the final recipe under
// BLACKHOLE_ONESHOT_OUT (default: a temp dir) and fails if the recipe does not lint clean.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";
import { chat } from "../../src/llm";
import { CopilotSession, type CopilotEvent, type TurnChunk } from "../../src/copilot/session";
import { SYSTEM_PROMPT } from "../../src/copilot/prompt";
import { relativeToWorkspace, resolveInWorkspace } from "../../src/shared/wspath";
import { FakeEditor } from "./fakeEditor";

const live = process.env.BLACKHOLE_LIVE_ONESHOT === "1";
const PROMPT =
  process.env.BLACKHOLE_ONESHOT_PROMPT ??
  "I want to run the reap/q hex on qwen 3.8 flash next, then run a SWE bench pro on it to test performance. Then package it and run it in a harness on the VM to test it out. Then give me the commands for publishing it to huggingface";

class Helper {
  private p: ChildProcess;
  private seq = 0;
  private waits = new Map<number, (m: any) => void>();
  constructor(py: string, cwd: string) {
    this.p = spawn(py, ["-m", "blackhole_dev.rpc"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
    readline.createInterface({ input: this.p.stdout! }).on("line", (l) => {
      let m: any;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.id != null) this.waits.get(m.id)?.(m);
    });
  }
  call(method: string, params: object): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waits.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() {
    this.p.kill();
  }
}

describe.skipIf(!live)("copilot one-shot (live)", () => {
  it("writes a recipe for the request that lints clean", async () => {
    const out = process.env.BLACKHOLE_ONESHOT_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "oneshot-"));
    const ws = path.join(out, "BlackHole-Dev");
    fs.mkdirSync(path.join(ws, "recipes"), { recursive: true });
    fs.mkdirSync(path.join(ws, "functions"), { recursive: true });
    const py = (process.env.BLACKHOLE_PY ?? "python3").replace(/^~/, os.homedir());
    const helper = new Helper(py, ws);
    await helper.call("initialize", { workspace: ws, functionsDir: path.join(ws, "functions") });
    const log: string[] = [];
    const ed = new FakeEditor();
    const invokes: [string, unknown][] = [];
    const pending = new Map<string, (r: { content: string; isError?: boolean }) => void>();
    let call = 0;

    const session = new CopilotSession({
      editor: ed,
      activeFile: () => null,
      async *turn(req) {
        const q: TurnChunk[] = [];
        let wake: (() => void) | null = null;
        const push = (c: TurnChunk) => {
          q.push(c);
          wake?.();
        };
        void (async () => {
          for await (const c of chat({
            provider: "claude-code",
            model: process.env.BLACKHOLE_ONESHOT_MODEL ?? "opus",
            system: req.system,
            messages: req.messages,
            tools: req.tools,
            params: { effort: (process.env.BLACKHOLE_ONESHOT_EFFORT as any) ?? "high" },
            cwd: ws,
            runTool: (name, input) =>
              new Promise((resolve) => {
                const callId = `c${call++}`;
                pending.set(callId, resolve);
                push({ type: "tool_run", callId, name, input });
              }),
          }))
            push(c);
        })();
        for (;;) {
          while (!q.length) await new Promise<void>((r) => (wake = r));
          wake = null;
          const c = q.shift()!;
          yield c;
          if (c.type === "done" || c.type === "error") return;
        }
      },
      abortTurn: () => undefined,
      toolResult: (callId, r) => {
        pending.get(callId)?.(r);
        pending.delete(callId);
      },
      helper: async (method, params: any) => {
        // Offline stand-in for the Hub (huggingface.co may be blocked where this runs):
        // BLACKHOLE_ONESHOT_HUB='{"Qwen/Qwen3-30B-A3B": "/path/to/header-only/folder"}'
        const hub: Record<string, string> = JSON.parse(process.env.BLACKHOLE_ONESHOT_HUB ?? "{}");
        if (method === "anatomy.open" && Object.keys(hub).length) {
          try {
            return await helper.call(method, params);
          } catch (err) {
            const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9.]/g, "");
            const q = norm(String(params.model).split("/").pop()!);
            const hit = Object.keys(hub).find((id) => norm(id) === norm(String(params.model)) || norm(id.split("/")[1]) === q);
            if (!hit) throw err;
            const r = await helper.call(method, { model: hub[hit] });
            return { ...r, id: hit, name: hit.split("/")[1], ...(hit === params.model ? {} : { resolvedFrom: params.model, candidates: [] }) };
          }
        }
        if (method === "recipe.plan" && !params.model) {
          const text: string = params.text ?? fs.readFileSync(params.path, "utf8");
          const base = /base\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
          if (base && hub[base]) params = { ...params, model: hub[base] };
        }
        return helper.call(method, params);
      },
      invoke: async (channel, payload) => {
        invokes.push([channel, payload]);
        if (channel === "vm:hosts.list")
          return { hosts: [{ id: "b300", label: "oliver-reaper@204.12.178.100", kind: "ssh", gpu: "1x B300 288GB", status: "running", selected: true }] };
        if (channel === "analysis:models") return { models: [] };
        if (channel === "vm:job.list") return { jobs: [] };
        return { approved: false };
      },
      readFile: async (p) => fs.readFileSync(p, "utf8"),
      listFiles: async () => fs.readdirSync(path.join(ws, "recipes")).map((f) => path.join(ws, "recipes", f)),
      openFile: async () => undefined,
      every: (ms, fn) => {
        const t = setInterval(fn, 1);
        return () => clearInterval(t);
      },
      pacer: { lookaheadLines: 1, charsPerTick: 4000 },
      resolvePath: (p) => resolveInWorkspace(ws, p),
      displayPath: (p) => relativeToWorkspace(ws, p),
    });
    session.on((e: CopilotEvent) => {
      if (e.type === "tool") log.push(`\n[tool ${e.status}] ${e.name}: ${e.summary}\n`);
      else if (e.type === "prose") log.push(e.text);
      else if (e.type === "error") log.push(`\n[error] ${e.message}\n`);
    });
    await session.ask(PROMPT);
    // Save what the copilot wrote, as the user would on accept.
    const written: string[] = [];
    for (const [file] of ed.docs) {
      const abs = path.isAbsolute(file) ? file : resolveInWorkspace(ws, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, ed.getText(file));
      written.push(abs);
    }
    fs.writeFileSync(path.join(out, "transcript.md"), `# Prompt\n\n${PROMPT}\n\n# Copilot\n\n${log.join("")}\n\n# Gated/module calls\n\n${JSON.stringify(invokes, null, 1)}\n`);
    fs.writeFileSync(path.join(out, "system-prompt.md"), SYSTEM_PROMPT);
    const recipes = written.filter((f) => f.endsWith(".py") && f.includes(`${path.sep}recipes${path.sep}`));
    expect(recipes.length, `no recipe written; see ${out}/transcript.md`).toBeGreaterThan(0);
    for (const r of recipes) {
      const lint = await helper.call("recipe.lint", { path: r });
      fs.writeFileSync(r + ".lint.json", JSON.stringify(lint, null, 1));
      expect(lint.problems.filter((p: any) => p.severity === "error"), `${r}: ${JSON.stringify(lint.problems)}`).toEqual([]);
    }
    helper.close();
    console.log(`one-shot output in ${out}`);
  }, 1_800_000);
});
