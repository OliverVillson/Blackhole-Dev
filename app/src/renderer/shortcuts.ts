// The keymap: every shortcut the shell handles, plus the editor's own (Monaco) shortcuts so
// Settings can list them in one place. The shell matches these in the capture phase, so they
// work while the editor, a terminal or a sidebar has focus.

export interface KeyBinding {
  keys: string;
  command: string;
  /** Shown instead of the command title (for bindings that pass arguments). */
  label?: string;
  args?: unknown[];
  /** Why the binding is special, shown in Settings. */
  note?: string;
}

export const KEYMAP: KeyBinding[] = [
  { keys: "Cmd+P", command: "palette.open" },
  { keys: "Cmd+Shift+P", command: "palette.commands" },
  { keys: "F1", command: "palette.commands" },
  { keys: "Cmd+Shift+F", command: "search.workspace" },
  { keys: "Cmd+S", command: "file.save" },
  { keys: "Cmd+Alt+S", command: "file.saveAll" },
  { keys: "Cmd+N", command: "recipe.new" },
  { keys: "Cmd+W", command: "tab.close" },
  { keys: "Cmd+Shift+T", command: "tab.reopen" },
  { keys: "Shift+Tab", command: "tab.next", note: "With lines selected in the editor, Shift+Tab outdents instead (Cmd+[ always outdents)." },
  { keys: "Ctrl+Tab", command: "tab.next" },
  { keys: "Ctrl+Shift+Tab", command: "tab.prev" },
  { keys: "Cmd+Alt+Right", command: "tab.next" },
  { keys: "Cmd+Alt+Left", command: "tab.prev" },
  { keys: "Cmd+Tab", command: "group.next", note: "macOS keeps Cmd+Tab for its app switcher, so the app never sees it there. Use Cmd+Ctrl+Tab or Cmd+1…9." },
  { keys: "Cmd+Ctrl+Tab", command: "group.next" },
  { keys: "Cmd+Ctrl+Shift+Tab", command: "group.prev" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ keys: `Cmd+${n}`, command: "group.focus", args: [n - 1], label: `Focus group ${n}` })),
  { keys: "Cmd+\\", command: "view.splitRight" },
  { keys: "Cmd+Alt+\\", command: "view.splitDown" },
  { keys: "Cmd+Alt+J", command: "group.collapse" },
  { keys: "Cmd+B", command: "view.sidebar" },
  { keys: "Cmd+J", command: "view.panel" },
  { keys: "Cmd+Alt+B", command: "view.inspector" },
  { keys: "Cmd+,", command: "app.settings" },
  { keys: "Cmd+Shift+E", command: "workbench.view", args: ["recipes"], label: "Show recipes" },
  { keys: "Cmd+Alt+P", command: "recipe.plan" },
  { keys: "Cmd+R", command: "blackhole.runOnVm" },
  { keys: "Ctrl+`", command: "terminal.new" },
  { keys: "Alt+Z", command: "editor.wordWrap" },
];

/** Monaco's built-in shortcuts worth knowing (handled by the editor itself). */
export const EDITOR_KEYS: [string, string][] = [
  ["Tab", "Complete the word (dropdown of candidates; Tab or Enter accepts)"],
  ["Ctrl+Space", "Show completions"],
  ["Cmd+F", "Find"],
  ["Cmd+Alt+F", "Replace"],
  ["Cmd+G", "Find next"],
  ["Cmd+/", "Toggle line comment"],
  ["Cmd+D", "Select next occurrence"],
  ["Cmd+Shift+L", "Select all occurrences"],
  ["Cmd+Alt+Up", "Add cursor above"],
  ["Cmd+Alt+Down", "Add cursor below"],
  ["Alt+Up", "Move line up"],
  ["Alt+Down", "Move line down"],
  ["Shift+Alt+Down", "Copy line down"],
  ["Cmd+Shift+K", "Delete line"],
  ["Cmd+Enter", "Insert line below"],
  ["Cmd+]", "Indent"],
  ["Cmd+[", "Outdent"],
  ["Cmd+Alt+[", "Fold"],
  ["Cmd+Alt+]", "Unfold"],
  ["Ctrl+G", "Go to line"],
  ["Cmd+Shift+O", "Go to symbol in file"],
  ["Cmd+Z", "Undo"],
  ["Cmd+Shift+Z", "Redo"],
  ["Cmd+L", "Select line"],
];
