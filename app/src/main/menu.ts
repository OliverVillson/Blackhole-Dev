import { Menu, type MenuItemConstructorOptions } from "electron";

// Native macOS menu. Items send shell command ids to the renderer (registerCommand ids).
export function buildMenu(run: (command: string) => void): Menu {
  const cmd = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => run(id) });
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        cmd("New Recipe", "recipe.new", "CmdOrCtrl+N"),
        cmd("New Function", "function.new"),
        cmd("Import TOML Schema…", "recipe.importToml"),
        { type: "separator" },
        cmd("Save", "file.save", "CmdOrCtrl+S"),
        cmd("Close Tab", "tab.close", "CmdOrCtrl+W"),
        { type: "separator" },
        cmd("Choose Workspace Folder…", "workspace.choose"),
      ],
    },
    { role: "editMenu" },
    {
      label: "Recipe",
      submenu: [
        cmd("Plan (dry run)", "recipe.plan", "CmdOrCtrl+Shift+P"),
        cmd("Lint", "recipe.lint"),
        cmd("Overview", "recipe.overview"),
        cmd("Export Bundle (.bhr)…", "recipe.bundle"),
      ],
    },
    { label: "Run", submenu: [cmd("Run on VM…", "blackhole.runOnVm", "CmdOrCtrl+R")] },
    {
      label: "View",
      submenu: [
        cmd("Quick Open", "palette.open", "CmdOrCtrl+P"),
        cmd("Toggle Sidebar", "view.sidebar", "CmdOrCtrl+B"),
        cmd("Toggle Panel", "view.panel", "CmdOrCtrl+J"),
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [cmd("Welcome and Checks", "app.welcome"), cmd("Show Logs", "app.logs")] },
  ];
  return Menu.buildFromTemplate(template);
}
