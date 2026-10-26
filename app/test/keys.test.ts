// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { matches } from "../src/renderer/keys";

const ev = (key: string, o: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ...o });

describe("keybindings", () => {
  it("maps Cmd to Meta on macOS and Ctrl elsewhere", () => {
    expect(matches("Cmd+I", ev("i", { metaKey: true }), true)).toBe(true);
    expect(matches("Cmd+I", ev("i", { ctrlKey: true }), true)).toBe(false);
    expect(matches("Cmd+I", ev("i", { ctrlKey: true }), false)).toBe(true);
    expect(matches("Cmd+Shift+P", ev("P", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matches("Cmd+Shift+P", ev("p", { metaKey: true }), true)).toBe(false);
  });
});
