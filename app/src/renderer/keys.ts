export const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

/** "Cmd+Shift+P" style keybinding test. Cmd means Ctrl off macOS. */
export function matches(binding: string, e: KeyboardEvent, mac = isMac): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop()!;
  const want = { cmd: parts.includes("cmd"), ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") || parts.includes("option") };
  const cmd = mac ? e.metaKey : e.ctrlKey;
  const ctrl = mac ? e.ctrlKey : false;
  if (cmd !== want.cmd || ctrl !== (mac ? want.ctrl : false) || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = e.key.toLowerCase();
  return k === key || (key === "." && k === ".") || e.code.toLowerCase() === `key${key}`;
}
