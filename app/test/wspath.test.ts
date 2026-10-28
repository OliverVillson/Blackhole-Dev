import { describe, expect, it } from "vitest";
import { isRecipePath, relativeToWorkspace, resolveInWorkspace } from "../src/shared/wspath";

const WS = "/Users/me/BlackHole-Dev";
const paths = { workspace: WS, recipes: `${WS}/recipes` };

describe("workspace paths", () => {
  it("resolves workspace-relative paths and leaves absolute and built-in ones alone", () => {
    expect(resolveInWorkspace(WS, "recipes/qwen/x.py")).toBe(`${WS}/recipes/qwen/x.py`);
    expect(resolveInWorkspace(WS, "./recipes//a/../x.py")).toBe(`${WS}/recipes/x.py`);
    expect(resolveInWorkspace(`${WS}/`, "recipes/x.py")).toBe(`${WS}/recipes/x.py`);
    expect(resolveInWorkspace(WS, `${WS}/recipes/x.py`)).toBe(`${WS}/recipes/x.py`);
    expect(resolveInWorkspace(WS, "builtin:quant.py")).toBe("builtin:quant.py");
    expect(resolveInWorkspace("", "recipes/x.py")).toBe("recipes/x.py");
  });

  it("shows paths inside the workspace relative to it", () => {
    expect(relativeToWorkspace(WS, `${WS}/recipes/x.py`)).toBe("recipes/x.py");
    expect(relativeToWorkspace(WS, "/elsewhere/x.py")).toBe("/elsewhere/x.py");
    expect(relativeToWorkspace(WS, `${WS}-other/x.py`)).toBe(`${WS}-other/x.py`);
  });

  it("knows a recipe by absolute or relative path", () => {
    expect(isRecipePath(paths, `${WS}/recipes/qwen/x.py`)).toBe(true);
    expect(isRecipePath(paths, "recipes/qwen/x.py")).toBe(true);
    expect(isRecipePath(paths, "functions/quant.py")).toBe(false);
    expect(isRecipePath(paths, `${WS}/recipes-old/x.py`)).toBe(false);
    expect(isRecipePath(paths, "recipes/notes.md")).toBe(false);
    expect(isRecipePath(null, "recipes/x.py")).toBe(false);
  });
});
