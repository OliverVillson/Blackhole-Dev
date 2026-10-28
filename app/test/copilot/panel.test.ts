// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fillError, renderCopilotPanel } from "../../src/copilot/panel";
import { CopilotSession } from "../../src/copilot/session";
import { FakeEditor } from "./fakeEditor";

describe("copilot panel", () => {
  it("sends an ask, shows prose, and shows the key box when no key is stored", async () => {
    const ed = new FakeEditor();
    const session = new CopilotSession({
      editor: ed,
      activeFile: () => "recipes/a.py",
      async *turn() {
        yield { type: "text", text: "Sure, here is the plan." };
        yield { type: "done", finishReason: "stop" };
      },
      abortTurn() {},
      helper: async () => ({}),
      invoke: async () => ({}),
    });
    const calls: string[] = [];
    const el = document.createElement("div");
    document.body.append(el);
    renderCopilotPanel(el, {
      session,
      activeFile: () => "recipes/a.py",
      onActiveFile: () => () => {},
      invoke: async (c: string) => {
        calls.push(c);
        if (c === "copilot:settings") return { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
        if (c === "copilot:keyStatus") return { has: false, hint: null, encryption: true };
        return null;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector(".cp-key")!.classList.contains("on")).toBe(true);
    expect(el.querySelector(".cp-key")!.classList.contains("edit")).toBe(true);
    expect(el.textContent).toContain("@a.py");
    const ta = el.querySelector<HTMLTextAreaElement>("#cp-steer")!;
    ta.value = "make a recipe";
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Send")!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el.querySelector(".cp-me")!.textContent).toBe("make a recipe");
    expect(el.querySelector(".cp-ai")!.textContent).toBe("Sure, here is the plan.");
    expect(calls).toContain("copilot:keyStatus");
  });

  it("shows the saved key's hint, saves effort and model changes, and runs Test connection", async () => {
    const session = new CopilotSession({ editor: new FakeEditor(), activeFile: () => null, async *turn() {}, abortTurn() {}, helper: async () => ({}), invoke: async () => ({}) });
    const calls: [string, any][] = [];
    let settings: any = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const el = document.createElement("div");
    renderCopilotPanel(el, {
      session,
      activeFile: () => null,
      onActiveFile: () => () => {},
      invoke: async (c: string, arg?: any) => {
        calls.push([c, arg]);
        if (c === "copilot:settings") return settings;
        if (c === "copilot:setSettings") return (settings = arg);
        if (c === "copilot:keyStatus") return { has: true, hint: "sk-ant-…x7Qa", encryption: true };
        if (c === "copilot:test") return { ok: false, message: "Your credit balance is too low." };
        return null;
      },
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await tick();
    await tick();
    const key = el.querySelector(".cp-key")!;
    expect(key.classList.contains("edit")).toBe(false);
    expect(key.textContent).toContain("sk-ant-…x7Qa");
    const [model, effort] = [...el.querySelectorAll("select")] as HTMLSelectElement[];
    expect(effort.value).toBe("high");
    effort.value = "max";
    effort.dispatchEvent(new Event("change"));
    await tick();
    expect(settings).toEqual({ provider: "anthropic", model: "claude-opus-5-5", effort: "max" });
    model.value = "anthropic:claude-haiku-5-5";
    model.dispatchEvent(new Event("change"));
    await tick();
    expect(settings).toEqual({ provider: "anthropic", model: "claude-haiku-5-5", effort: "max" });
    expect(el.querySelector(".cp-blurb")!.textContent).toMatch(/cheap/);
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Test connection")!.click();
    await tick();
    await tick();
    expect(el.querySelector(".cp-testmsg")!.textContent).toBe("Your credit balance is too low.");
    expect(el.querySelector(".cp-conn")!.classList.contains("bad")).toBe(true);
  });

  it("offers Claude Code in the picker, hides the key box, and shows the setup hint when it is missing", async () => {
    const session = new CopilotSession({ editor: new FakeEditor(), activeFile: () => null, async *turn() {}, abortTurn() {}, helper: async () => ({}), invoke: async () => ({}) });
    let settings: any = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    let status: any = { installed: false, loggedIn: false, message: "Claude Code is not installed. Install Claude Code (curl …)" };
    const el = document.createElement("div");
    renderCopilotPanel(el, {
      session,
      activeFile: () => null,
      onActiveFile: () => () => {},
      invoke: async (c: string, arg?: any) => {
        if (c === "copilot:settings") return settings;
        if (c === "copilot:setSettings") return (settings = arg);
        if (c === "copilot:keyStatus") return { has: true, hint: "sk-ant-…x7Qa", encryption: true };
        if (c === "copilot:claudeStatus") return status;
        return null;
      },
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await tick();
    await tick();
    const [model] = [...el.querySelectorAll("select")] as HTMLSelectElement[];
    expect([...model.querySelectorAll("optgroup")].map((g) => g.label)).toContain("Claude · your Claude Code sign-in");
    model.value = "claude-code:opus";
    model.dispatchEvent(new Event("change"));
    await tick();
    await tick();
    expect(settings).toEqual({ provider: "claude-code", model: "opus", effort: "high" });
    expect(el.querySelector(".cp-key")!.classList.contains("on")).toBe(false);
    const cc = el.querySelector<HTMLElement>(".cp-cc")!;
    expect(cc.style.display).toBe("");
    expect(el.querySelector(".cp-ccmsg")!.textContent).toContain("not installed");
    expect(el.querySelector(".cp-ccmsg")!.classList.contains("bad")).toBe(true);
    expect([...el.querySelectorAll("button")].find((b) => b.textContent === "Test connection")!.disabled).toBe(true);
    status = { installed: true, loggedIn: true, version: "2.1.310", authMethod: "claude.ai", message: "Claude Code 2.1.310, signed in with your Claude plan." };
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Check")!.click();
    await tick();
    await tick();
    expect(el.querySelector(".cp-ccmsg")!.textContent).toContain("signed in with your Claude plan");
    expect([...el.querySelectorAll("button")].find((b) => b.textContent === "Test connection")!.disabled).toBe(false);
  });
});

describe("copilot panel code boxes", () => {
  it("shows written files, edits and code in replies in highlighted code boxes with Copy", async () => {
    const ed = new FakeEditor();
    let tick: (() => void) | null = null;
    const timer = setInterval(() => { for (let i = 0; i < 50; i++) tick?.(); }, 1);
    let turn = 0;
    const session = new CopilotSession({
      editor: ed,
      activeFile: () => null,
      async *turn() {
        if (turn++ === 0) {
          yield { type: "text", text: "Here it is. Run `blackhole plan` after:\n```bash\nblackhole plan recipes/q.py\n```\n" };
          yield { type: "text", text: "```python path=recipes/q.py mode=new\nimport os\nrecipe = Recipe(\"me/q\", \"1.0.0\")\n```\n" };
          yield { type: "tool_use", id: "e1", name: "edit_file", input: { path: "recipes/q.py", edits: [{ find: "1.0.0", replace: "1.1.0" }] } };
          yield { type: "done", finishReason: "tool_use" };
        } else {
          yield { type: "text", text: "Done." };
          yield { type: "done", finishReason: "stop" };
        }
      },
      abortTurn() {},
      helper: async () => ({}),
      invoke: async () => ({}),
      readFile: async () => { throw new Error("missing"); },
      every: (_ms, fn) => { tick = fn; return () => (tick = null); },
      pacer: { lookaheadLines: 1, charsPerTick: 8 },
    });
    const el = document.createElement("div");
    document.body.append(el);
    renderCopilotPanel(el, { session, activeFile: () => null, onActiveFile: () => () => {}, invoke: async () => null });
    await session.ask("make q");
    clearInterval(timer);
    // The shell command stays in the chat (a code box), never in a file.
    expect(ed.getText("recipes/q.py")).not.toContain("blackhole plan");
    const reply = el.querySelector(".cp-ai")!;
    expect(reply.querySelector("code")!.textContent).toBe("blackhole plan");
    expect(reply.querySelector(".bhc-code pre")!.textContent).toBe("blackhole plan recipes/q.py");
    expect(reply.querySelector(".bhc-copy")).not.toBeNull();
    // The written file gets its own box with the path, highlighted code and a final status.
    const [file, edit] = [...el.querySelectorAll(".cp-box")];
    expect(file.querySelector(".path")!.textContent).toBe("recipes/q.py");
    expect(file.querySelector(".tag")!.textContent).toBe("python");
    expect(file.querySelector("pre")!.textContent).toBe('import os\nrecipe = Recipe("me/q", "1.0.0")\n');
    expect(file.querySelector(".t-kw")!.textContent).toBe("import");
    expect(file.querySelector(".st")!.textContent).toContain("written");
    expect(edit.querySelector(".tag")!.textContent).toBe("edit");
    expect(edit.querySelector(".d-del")!.textContent).toBe("- 1.0.0");
    expect(edit.querySelector(".d-add")!.textContent).toBe("+ 1.1.0");
    // Copy puts the box's code on the clipboard.
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
    (file.querySelector(".cp-copy") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toBe('import os\nrecipe = Recipe("me/q", "1.0.0")\n');
    (edit.querySelector(".cp-copy") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(copied).toBe("1.1.0");
  });
});

describe("error rows", () => {
  const HF = "open model: cannot open recursive-si/flint-40b: 401 Client Error. (Request ID: Root=1-6ae2) Repository Not Found for url: https://huggingface.co/recursive-si/flint-40b/resolve/main/config.json. Please make sure ...\nInvalid username or password.";

  it("shows one line, with Details and Copy holding the full text", async () => {
    const el = fillError(document.createElement("div"), HF);
    expect(el.querySelector(".cp-ehead")!.textContent).toBe("open model: cannot open recursive-si/flint-40b: this repo is gated or private on Hugging Face, or the id is wrong. Add a Hugging Face token in Settings");
    const full = el.querySelector(".cp-efull")!;
    expect(full.textContent).toBe(HF);
    expect(full.classList.contains("on")).toBe(false);
    const [details, copy] = [...el.querySelectorAll<HTMLButtonElement>(".cp-emore button")];
    details.click();
    expect(full.classList.contains("on")).toBe(true);
    expect(details.textContent).toBe("Hide details");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    copy.click();
    expect(writeText).toHaveBeenCalledWith(HF);
  });

  it("keeps a short error plain, and redraws when a row is reused", () => {
    const el = fillError(document.createElement("div"), HF);
    fillError(el, "lint recipe: file not found");
    expect(el.textContent).toBe("lint recipe: file not found");
    expect(el.querySelector(".cp-emore")).toBeNull();
  });
});
