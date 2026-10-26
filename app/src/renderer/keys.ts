export const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

// Physical key names for KeyboardEvent.code, so Alt/Option combos (which change e.key on macOS) still match.
const CODES: Record<string, string> = {
  Backslash: "\\", Slash: "/", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Equal: "=", Minus: "-",
  Backquote: "`", Semicolon: ";", Quote: "'", Tab: "tab", Enter: "enter", Escape: "escape", Space: "space",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", PageUp: "pageup", PageDown: "pagedown",
};

function codeName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return CODES[code] ?? code.toLowerCase();
}

/** "Cmd+Shift+P" style keybinding test. Cmd means Ctrl off macOS. */
export function matches(binding: string, e: KeyboardEvent, mac = isMac): boolean {
  const parts = binding.toLowerCase().split("+");
  let key = parts.pop()!;
  if (key === "" && parts[parts.length - 1] === "") (parts.pop(), (key = "+"));
  const want = { cmd: parts.includes("cmd"), ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") || parts.includes("option") };
  // Off macOS, Cmd and Ctrl both mean the Ctrl key.
  const mods = mac ? e.metaKey === want.cmd && e.ctrlKey === want.ctrl : e.ctrlKey === (want.cmd || want.ctrl) && !e.metaKey;
  if (!mods || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = (e.key ?? "").toLowerCase();
  const named = k === "arrowleft" ? "left" : k === "arrowright" ? "right" : k === "arrowup" ? "up" : k === "arrowdown" ? "down" : k === " " ? "space" : k;
  return named === key || (!!e.code && codeName(e.code) === key);
}

const GLYPH: Record<string, string> = { cmd: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥", option: "⌥", tab: "⇥", enter: "↩", left: "←", right: "→", up: "↑", down: "↓", escape: "⎋" };

/** Human label for a binding: "⌘⇧P" on macOS, "Ctrl+Shift+P" elsewhere. Chords are space separated. */
export function prettyKeys(binding: string, mac = isMac): string {
  return binding.split(" ").map((one) => {
    const parts = one.split("+");
    if (mac) return parts.map((p) => GLYPH[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p)).join("");
    return parts.map((p) => (p.toLowerCase() === "cmd" ? "Ctrl" : p.length === 1 ? p.toUpperCase() : p)).join("+");
  }).join(" ");
}
