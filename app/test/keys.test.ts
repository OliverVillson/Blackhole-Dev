// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { matches, prettyKeys } from "../src/renderer/keys";
import { KEYMAP } from "../src/renderer/shortcuts";

const ev = (key: string, o: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ...o });

describe("keybindings", () => {
  it("maps Cmd to Meta on macOS and Ctrl elsewhere", () => {
    expect(matches("Cmd+I", ev("i", { metaKey: true }), true)).toBe(true);
    expect(matches("Cmd+I", ev("i", { ctrlKey: true }), true)).toBe(false);
    expect(matches("Cmd+I", ev("i", { ctrlKey: true }), false)).toBe(true);
    expect(matches("Cmd+Shift+P", ev("P", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matches("Cmd+Shift+P", ev("p", { metaKey: true }), true)).toBe(false);
  });

  it("matches Tab combos, Option keys by physical key, and punctuation", () => {
    const tab = (o: Partial<KeyboardEventInit>) => new KeyboardEvent("keydown", { key: "Tab", code: "Tab", ...o });
    expect(matches("Shift+Tab", tab({ shiftKey: true }), true)).toBe(true);
    expect(matches("Shift+Tab", tab({}), true)).toBe(false);
    expect(matches("Cmd+Ctrl+Tab", tab({ metaKey: true, ctrlKey: true }), true)).toBe(true);
    expect(matches("Ctrl+Tab", tab({ ctrlKey: true }), true)).toBe(true);
    expect(matches("Ctrl+Tab", tab({}), false)).toBe(false);
    expect(matches("Ctrl+Tab", tab({ ctrlKey: true }), false)).toBe(true);
    expect(matches("Alt+Z", new KeyboardEvent("keydown", { key: "Ω", code: "KeyZ", altKey: true }), true)).toBe(true);
    expect(matches("Cmd+Alt+\\", new KeyboardEvent("keydown", { key: "«", code: "Backslash", metaKey: true, altKey: true }), true)).toBe(true);
    expect(matches("Cmd+\\", new KeyboardEvent("keydown", { key: "\\", code: "Backslash", metaKey: true }), true)).toBe(true);
    expect(matches("Cmd+1", new KeyboardEvent("keydown", { key: "1", code: "Digit1", metaKey: true }), true)).toBe(true);
    expect(matches("Cmd+Alt+Left", new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true }), true)).toBe(true);
  });

  it("prints keys the macOS way", () => {
    expect(prettyKeys("Cmd+Shift+P", true)).toBe("⌘⇧P");
    expect(prettyKeys("Cmd+Shift+P", false)).toBe("Ctrl+Shift+P");
  });

  it("the keymap has no duplicate keys", () => {
    const keys = KEYMAP.map((b) => b.keys.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});
