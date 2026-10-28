// Workspace-relative paths (what the copilot's tools take) and the absolute paths the editor
// keys buffers by. Pure, so both the renderer and tests can use it.

/** Absolute path for `p`: absolute paths, `~` paths and `builtin:` names pass through; anything
 *  else is taken relative to the workspace folder. */
export function resolveInWorkspace(workspace: string, p: string): string {
  if (!workspace || p.startsWith("/") || p.startsWith("~") || p.includes(":")) return p;
  const parts: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return `${workspace.replace(/\/+$/, "")}/${parts.join("/")}`;
}

/** `p` relative to the workspace when it is inside it, else unchanged. */
export function relativeToWorkspace(workspace: string, p: string): string {
  const w = workspace.replace(/\/+$/, "");
  return w && p.startsWith(`${w}/`) ? p.slice(w.length + 1) : p;
}

/** A recipe is a .py file under the recipes folder, given by absolute or workspace-relative path. */
export function isRecipePath(paths: { workspace: string; recipes: string } | null | undefined, p: string | null): p is string {
  if (!p || !paths || !p.endsWith(".py")) return false;
  return resolveInWorkspace(paths.workspace, p).startsWith(`${paths.recipes.replace(/\/+$/, "")}/`);
}

/** What to save before a run reads the recipe from disk: the recipe itself and every unsaved
 *  file under recipes/ or functions/ (a recipe can call user functions and import helpers), so
 *  the run uses what is on screen. Order: the recipe first, then the rest as given. */
export function filesToSaveForRun(paths: { recipes: string; functions: string } | null | undefined, recipe: string | null, dirty: string[]): string[] {
  const under = (d: string, p: string) => !!d && p.startsWith(`${d.replace(/\/+$/, "")}/`);
  const out = recipe && dirty.includes(recipe) ? [recipe] : [];
  for (const p of dirty) if (p !== recipe && paths && (under(paths.recipes, p) || under(paths.functions, p))) out.push(p);
  return out;
}
