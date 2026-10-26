import { app, Menu, type MenuItemConstructorOptions } from "electron";

// Native macOS menu. Items send shell command ids to the renderer (registerCommand ids).
// The renderer's keymap (src/renderer/shortcuts.ts) handles the keys, so accelerators here are
// shown but not registered: a registered one would fire a second time, or steal keys such as
// Shift+Tab from text fields.
export function buildMenu(run: (command: string) => void): Menu {
  const cmd = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, registerAccelerator: false, click: () => run(id) });
  const mac = process.platform === "darwin";
  const sep: MenuItemConstructorOptions = { type: "separator" };
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" }, sep,
        cmd("Settings…", "app.settings", "CmdOrCtrl+,"), sep,
        { role: "services" }, sep,
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, sep,
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        cmd("New Recipe", "recipe.new", "CmdOrCtrl+N"),
        cmd("New Function", "function.new"),
        cmd("Import TOML Schema…", "recipe.importToml"),
        sep,
        cmd("Save", "file.save", "CmdOrCtrl+S"),
        cmd("Save All", "file.saveAll", "CmdOrCtrl+Alt+S"),
        sep,
        cmd("Close Tab", "tab.close", "CmdOrCtrl+W"),
        cmd("Reopen Closed Tab", "tab.reopen", "CmdOrCtrl+Shift+T"),
        sep,
        cmd("Choose Workspace Folder…", "workspace.choose"),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, sep,
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, sep,
        cmd("Find", "editor.find", "CmdOrCtrl+F"),
        cmd("Replace", "editor.replace", "CmdOrCtrl+Alt+F"),
        cmd("Find in Files", "search.workspace", "CmdOrCtrl+Shift+F"),
        sep,
        cmd("Toggle Line Comment", "editor.comment", "CmdOrCtrl+/"),
        cmd("Show Completions", "editor.suggest", "Ctrl+Space"),
      ],
    },
    {
      label: "Recipe",
      submenu: [
        cmd("Plan (dry run)", "recipe.plan", "CmdOrCtrl+Alt+P"),
        cmd("Lint", "recipe.lint"),
        cmd("Overview", "recipe.overview"),
        cmd("Export Bundle (.bhr)…", "recipe.bundle"),
      ],
    },
    { label: "Run", submenu: [cmd("Run on VM…", "blackhole.runOnVm", "CmdOrCtrl+R")] },
    {
      label: "View",
      submenu: [
        cmd("Command Palette…", "palette.commands", "CmdOrCtrl+Shift+P"),
        cmd("Quick Open…", "palette.open", "CmdOrCtrl+P"),
        sep,
        cmd("Split Editor Right", "view.splitRight", "CmdOrCtrl+\\"),
        cmd("Split Editor Down", "view.splitDown", "CmdOrCtrl+Alt+\\"),
        cmd("Collapse Group into Previous", "group.collapse", "CmdOrCtrl+Alt+J"),
        cmd("Join All Groups", "group.joinAll"),
        sep,
        cmd("Toggle Sidebar", "view.sidebar", "CmdOrCtrl+B"),
        cmd("Toggle Panel", "view.panel", "CmdOrCtrl+J"),
        cmd("Toggle Inspector", "view.inspector", "CmdOrCtrl+Alt+B"),
        cmd("Toggle Word Wrap", "editor.wordWrap", "Alt+Z"),
        cmd("Toggle Minimap", "editor.minimap"),
        sep,
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        sep,
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        cmd("Next Tab", "tab.next", "Shift+Tab"),
        cmd("Previous Tab", "tab.prev", "Ctrl+Shift+Tab"),
        cmd("Next Group", "group.next", mac ? "Cmd+Ctrl+Tab" : undefined),
        cmd("Previous Group", "group.prev", mac ? "Cmd+Ctrl+Shift+Tab" : undefined),
        sep,
        cmd("Go to Line…", "editor.gotoLine", "Ctrl+G"),
        cmd("Go to Symbol in File…", "editor.symbol", "CmdOrCtrl+Shift+O"),
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [cmd("Welcome and Checks", "app.welcome"), cmd("Show Logs", "app.logs")] },
  ];
  return Menu.buildFromTemplate(template);
}
