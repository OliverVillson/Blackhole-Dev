import { describe, expect, it } from "vitest";
import type { LlmChunk } from "../../src/llm/types";
import { CopilotSession, cleanError, type CopilotEvent, type TurnRequest } from "../../src/copilot/session";
import { FakeEditor } from "./fakeEditor";

type Script = (req: TurnRequest, t: Tools) => AsyncGenerator<LlmChunk>;
interface Tools { pump(n?: number): void; ed: FakeEditor; aborted: Promise<void> }

function setup(scripts: Script[], opts: { active?: string; disk?: Record<string, string>; helper?: (method: string, params: any) => unknown } = {}) {
  const ed = new FakeEditor();
  const reqs: TurnRequest[] = [];
  const helperCalls: [string, any][] = [];
  const invokes: [string, any][] = [];
  let tick: (() => void) | null = null;
  const aborts = new Map<string, () => void>();
  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  const opened: [string, { create?: boolean } | undefined][] = [];
  const pump = (n = 400) => { for (let i = 0; i < n; i++) tick?.(); };
  const session = new CopilotSession({
    editor: ed,
    activeFile: () => opts.active ?? null,
    async *turn(req) {
      reqs.push(JSON.parse(JSON.stringify(req)));
      const s = scripts.shift();
      if (!s) throw new Error("no more scripted turns");
      const aborted = new Promise<void>((r) => aborts.set(req.turnId, r));
      yield* s(req, { pump, ed, aborted });
    },
    abortTurn: (id) => aborts.get(id)?.(),
    toolResult: (callId, r) => toolResults.set(callId, r),
    ...(opts.disk
      ? {
          readFile: async (path: string) => {
            if (path in opts.disk!) return opts.disk![path];
            throw new Error(`ENOENT: no such file, open '${path}'`);
          },
          openFile: async (path: string, o?: { create?: boolean }) => void opened.push([path, o]),
        }
      : {}),
    helper: async (method, params) => {
      helperCalls.push([method, params]);
      if (opts.helper) return opts.helper(method, params);
      if (method === "recipe.lint") return { problems: [] };
      if (method === "recipe.plan") return { rows: [], sizeGb: 9.5, fits: true, problems: [], steps: [] };
      return {};
    },
    invoke: async (channel, payload) => {
      invokes.push([channel, payload]);
      return { approved: false };
    },
    every: (_ms, fn) => {
      tick = fn;
      return () => (tick = null);
    },
    pacer: { lookaheadLines: 1, charsPerTick: 4 },
  });
  const events: CopilotEvent[] = [];
  session.on((e) => events.push(e));
  // Keep the pacer moving between awaits.
  const timer = setInterval(() => pump(50), 1);
  return {
    ed, session, reqs, helperCalls, invokes, events, pump, toolResults, opened,
    done: () => {
      clearInterval(timer);
      // An expect() failing inside a scripted turn surfaces as an error event.
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    },
  };
}

const RECIPE = [
  'from blackhole_dev.recipe import Recipe',
  'recipe = Recipe("me/q30", "1.0.0", base="Qwen/Qwen3-30B-A3B")',
  'prune = recipe.input("prune", "float", default=0.25)',
  'recipe.step("pipeline.reap", prune=prune)',
  'recipe.step("pipeline.bench")',
];

describe("CopilotSession", () => {
  it("streams a recipe into the editor, keeps the user's mid-stream edit, runs lint, and tells the model", async () => {
    const t = setup([
      async function* (_req, { pump, ed }) {
        yield { type: "text", text: "Writing it.\n```python path=recipes/q30.py mode=new\n" };
        yield { type: "text", text: RECIPE.slice(0, 3).join("\n") + "\n" };
        await new Promise((r) => setTimeout(r, 0)); // let the file open
        pump();
        // user retypes line 2 while the copilot is still writing
        ed.userEditLine("recipes/q30.py", 2, 'recipe = Recipe("me/q30", "1.1.0", base="Qwen/Qwen3-30B-A3B")');
        yield { type: "text", text: RECIPE.slice(3).join("\n") + "\n```\n" };
        yield { type: "tool_use", id: "t1", name: "lint_recipe", input: { path: "recipes/q30.py" } };
        yield { type: "done", finishReason: "tool_use", raw: { provider: "anthropic", content: [{ type: "text", text: "raw" }] } };
      },
      async function* () {
        yield { type: "text", text: "Lint is clean, and your version bump is fine." };
        yield { type: "done", finishReason: "stop" };
      },
    ]);
    await t.session.ask("make a q30 recipe");
    t.done();
    const text = t.ed.getText("recipes/q30.py");
    expect(text.split("\n")[1]).toContain('"1.1.0"');
    expect(text).toContain('recipe.step("pipeline.bench")');
    // lint saw the live buffer
    expect(t.helperCalls[0][0]).toBe("recipe.lint");
    expect(t.helperCalls[0][1].text).toBe(text);
    // second turn got the tool result and the user-edit note in one user message
    const last = t.reqs[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as any[];
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(blocks[1].text).toContain("lines 2 now read");
    // the assistant turn is replayed with its raw provider content
    expect(t.reqs[1].messages[1].raw).toEqual({ provider: "anthropic", content: [{ type: "text", text: "raw" }] });
    expect(t.events.some((e) => e.type === "user-edit")).toBe(true);
    expect(t.session.state).toBe("idle");
  });

  it("steer interrupts, drops the ghost, and continues with mode=append", async () => {
    let session!: CopilotSession;
    const t = setup([
      async function* (_req, { pump, aborted }) {
        yield { type: "text", text: "```python path=r.py mode=new\n" + RECIPE.slice(0, 3).join("\n") + "\n" };
        await new Promise((r) => setTimeout(r, 0)); // let the file open
        pump();
        session.steer("use 64 calibration samples");
        await aborted;
        yield { type: "done", finishReason: "aborted" };
      },
      async function* (req) {
        const note = (req.messages.at(-1)!.content as any[]).map((b) => b.text).join("");
        expect(note).toContain("You were interrupted");
        expect(note).toContain("use 64 calibration samples");
        yield { type: "text", text: "```python path=r.py mode=append\n" + 'recipe.step("pipeline.reap", prune=prune, calib_samples=64)\n```\n' };
        yield { type: "done", finishReason: "stop" };
      },
    ]);
    session = t.session;
    await t.session.ask("write r.py");
    t.done();
    const lines = t.ed.getText("r.py").split("\n");
    // lookahead 1 line: the first two lines were typed, line 3 was ghost and got dropped
    expect(lines.slice(0, 2)).toEqual(RECIPE.slice(0, 2));
    expect(lines).toContain('recipe.step("pipeline.reap", prune=prune, calib_samples=64)');
    expect(lines).not.toContain(RECIPE[2]);
    expect(t.events.filter((e) => e.type === "user-message").map((e: any) => !!e.steer)).toEqual([false, true]);
  });

  it("stop answers pending tool calls so the next request stays valid", async () => {
    let session!: CopilotSession;
    const t = setup([
      async function* () {
        yield { type: "tool_use", id: "t9", name: "plan_recipe", input: { path: "r.py", device: "mac16" } };
        session.stop();
        yield { type: "done", finishReason: "tool_use" };
      },
      async function* (req) {
        const prev = req.messages.at(-2)!;
        expect((prev.content as any[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t9", is_error: true });
        yield { type: "done", finishReason: "stop" };
      },
    ]);
    session = t.session;
    await t.session.ask("plan it");
    expect(t.helperCalls).toEqual([]);
    await t.session.ask("again");
    t.done();
  });

  it("expensive actions go to the owning module's gated channel and a decline is reported back", async () => {
    const t = setup([
      async function* () {
        yield { type: "tool_use", id: "g1", name: "request_action", input: { action: "run.launch", why: "Run the recipe on your B300", recipe: "r.py", host: "b300" } };
        yield { type: "done", finishReason: "tool_use" };
      },
      async function* (req) {
        const r = (req.messages.at(-1)!.content as any[])[0];
        expect(r.content).toContain("declined");
        yield { type: "done", finishReason: "stop" };
      },
    ]);
    await t.session.ask("run it on the b300");
    t.done();
    expect(t.invokes).toEqual([["vm:copilot.launch", { action: "run.launch", why: "Run the recipe on your B300", recipe: "r.py", host: "b300", requestedBy: "copilot" }]]);
  });

  it("edit_file refuses to touch locked user lines", async () => {
    const t = setup(
      [
        async function* () {
          yield { type: "tool_use", id: "e1", name: "edit_file", input: { path: "r.py", edits: [{ find: "b = 2", replace: "b = 3" }] } };
          yield { type: "done", finishReason: "tool_use" };
        },
        async function* (req) {
          const r = (req.messages.at(-1)!.content as any[])[0];
          expect(r.is_error).toBe(true);
          expect(r.content).toContain("locked");
          yield { type: "done", finishReason: "stop" };
        },
      ],
      { active: "r.py" },
    );
    t.ed.setText("r.py", "a = 1\nb = 1");
    t.ed.userEditLine("r.py", 2, "b = 2");
    await t.session.ask("bump b");
    t.done();
    expect(t.ed.applied).toEqual([]);
  });

  it("write_file from inside Claude Code's tool loop types the file before lint reads it", async () => {
    const content = RECIPE.join("\n") + "\n";
    let t!: ReturnType<typeof setup>;
    const waitFor = async (id: string) => {
      while (!t.toolResults.has(id)) await new Promise((r) => setTimeout(r, 1));
      return t.toolResults.get(id)!;
    };
    t = setup(
      [
        async function* () {
          // Claude Code runs tools itself and streams no text before them.
          yield { type: "tool_run", callId: "w1", name: "write_file", input: { path: "recipes/int4.py", content } } as any;
          const w = await waitFor("w1");
          expect(w.isError).toBeFalsy();
          expect(w.content).toContain("Wrote 5 line(s) to recipes/int4.py");
          yield { type: "tool_run", callId: "l1", name: "lint_recipe", input: { path: "recipes/int4.py" } } as any;
          await waitFor("l1");
          yield { type: "tool_run", callId: "r1", name: "read_file", input: { path: "recipes/int4.py" } } as any;
          const r = await waitFor("r1");
          expect(r.content).toContain("pipeline.bench");
          yield { type: "text", text: "Written and lint is clean." };
          yield { type: "done", finishReason: "stop" };
        },
      ],
      { disk: {} },
    );
    await t.session.ask('write a script for int4 quant called "int4.py"');
    t.done();
    expect(t.ed.getText("recipes/int4.py")).toBe(content);
    expect(t.helperCalls[0]).toEqual(["recipe.lint", { path: "recipes/int4.py", text: content }]);
    // a new file gets its own (empty) tab before the copilot types into it
    expect(t.opened).toEqual([["recipes/int4.py", { create: true }]]);
    const writes = t.events.filter((e) => e.type === "write").map((e: any) => e.status);
    expect(writes).toEqual(["start", "done"]);
    expect(t.events.some((e) => e.type === "code" && e.text === content)).toBe(true);
  });

  it("write_file works as a normal tool call too, and rewrite replaces the file", async () => {
    const t = setup([
      async function* () {
        yield { type: "tool_use", id: "w1", name: "write_file", input: { path: "r.py", content: "a = 2", mode: "rewrite" } };
        yield { type: "done", finishReason: "tool_use" };
      },
      async function* (req) {
        const r = (req.messages.at(-1)!.content as any[])[0];
        expect(r).toMatchObject({ type: "tool_result", tool_use_id: "w1" });
        expect(r.is_error).toBeFalsy();
        yield { type: "done", finishReason: "stop" };
      },
    ], { active: "r.py" });
    t.ed.setText("r.py", "a = 1\nb = 1");
    await t.session.ask("set a to 2, nothing else");
    t.done();
    expect(t.ed.getText("r.py")).toBe("a = 2\n");
  });

  it("lint on a file that is not open reads it from disk instead of linting an empty buffer", async () => {
    const t = setup([
      async function* () {
        yield { type: "tool_use", id: "l1", name: "lint_recipe", input: { path: "recipes/old.py" } };
        yield { type: "done", finishReason: "tool_use" };
      },
      async function* () {
        yield { type: "done", finishReason: "stop" };
      },
    ], { disk: { "recipes/old.py": RECIPE.join("\n") } });
    await t.session.ask("lint old.py");
    t.done();
    expect(t.helperCalls[0][1]).toEqual({ path: "recipes/old.py", text: RECIPE.join("\n") });
    expect(t.ed.docs.has("recipes/old.py")).toBe(false);
  });

  it("helper errors reach the model and the panel without Electron's IPC wrapper", async () => {
    const t = setup([
      async function* () {
        yield { type: "tool_use", id: "p1", name: "plan_recipe", input: { path: "r.py", device: "mac16" } };
        yield { type: "done", finishReason: "tool_use" };
      },
      async function* (req) {
        const r = (req.messages.at(-1)!.content as any[])[0];
        expect(r.is_error).toBe(true);
        expect(r.content).toBe('this file builds no Recipe (recipe = Recipe("you/name", "0.1.0", ...))');
        yield { type: "done", finishReason: "stop" };
      },
    ], {
      helper: () => {
        throw new Error(`Error invoking remote method 'bh:invoke': Error: this file builds no Recipe (recipe = Recipe("you/name", "0.1.0", ...))`);
      },
    });
    await t.session.ask("plan it");
    t.done();
    const tool = t.events.filter((e) => e.type === "tool").at(-1) as any;
    expect(tool.summary).toBe('plan recipe: this file builds no Recipe (recipe = Recipe("you/name", "0.1.0", ...))');
  });
});

describe("cleanError", () => {
  it("strips the IPC wrapper and error class prefixes", () => {
    expect(cleanError(new Error("Error invoking remote method 'bh:invoke': RpcError: boom"))).toBe("boom");
    expect(cleanError("Error: Error invoking remote method 'copilot:helper': Error: x y")).toBe("x y");
    expect(cleanError(new Error("plain"))).toBe("plain");
  });
});
