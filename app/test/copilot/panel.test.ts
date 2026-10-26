// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderCopilotPanel } from "../../src/copilot/panel";
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
        if (c === "copilot:hasKey") return false;
        return null;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector(".cp-key")!.classList.contains("on")).toBe(true);
    expect(el.textContent).toContain("@a.py");
    const ta = el.querySelector<HTMLTextAreaElement>("#cp-steer")!;
    ta.value = "make a recipe";
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Send")!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(el.querySelector(".cp-me")!.textContent).toBe("make a recipe");
    expect(el.querySelector(".cp-ai")!.textContent).toBe("Sure, here is the plan.");
    expect(calls).toContain("copilot:hasKey");
  });
});
