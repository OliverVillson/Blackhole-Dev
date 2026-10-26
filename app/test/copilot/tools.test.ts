import { describe, expect, it } from "vitest";
import { planEdits, validateToolInput } from "../../src/copilot/tools";

describe("planEdits", () => {
  const text = "a = 1\nb = 2\nc = 3";
  it("maps find/replace to line/col ranges", () => {
    const r = planEdits(text, [{ find: "b = 2", replace: "b = 9" }], () => false);
    expect(r).toEqual({ ok: true, edits: [{ startLine: 2, startCol: 1, endLine: 2, endCol: 6, text: "b = 9" }] });
  });
  it("refuses edits on locked user lines", () => {
    const r = planEdits(text, [{ find: "c = 3", replace: "" }], (l) => l === 3);
    expect(r.ok).toBe(false);
  });
  it("refuses ambiguous finds", () => {
    expect(planEdits("x\nx", [{ find: "x", replace: "y" }], () => false).ok).toBe(false);
  });
});

describe("validateToolInput", () => {
  it("rejects bad input and invalid JSON markers", () => {
    expect(validateToolInput("plan_recipe", { path: "a.py" }).ok).toBe(false);
    expect(validateToolInput("lint_recipe", { __invalid_json: "{\"pa" }).ok).toBe(false);
    expect(validateToolInput("request_action", { action: "rm -rf", why: "x" }).ok).toBe(false);
    expect(validateToolInput("plan_recipe", { path: "a.py", device: "mac16" }).ok).toBe(true);
  });
});
