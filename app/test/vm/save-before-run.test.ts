// Run on VM bundles the recipe and its functions from disk, so it saves unsaved files first.
import { describe, expect, it, vi } from "vitest";
import { filesToSaveForRun } from "../../src/shared/wspath";
import { activate } from "../../src/vm/renderer";

const paths = { recipes: "/w/recipes", functions: "/w/functions" };

describe("filesToSaveForRun", () => {
  it("saves the recipe first, then dirty recipes and functions, and nothing else", () => {
    const dirty = ["/w/functions/quant.py", "/w/recipes/r.py", "/w/models/x/config.json", "/tmp/scratch.py", "/w/recipes/sub/helpers.py"];
    expect(filesToSaveForRun(paths, "/w/recipes/r.py", dirty)).toEqual(["/w/recipes/r.py", "/w/functions/quant.py", "/w/recipes/sub/helpers.py"]);
  });
  it("saves a recipe outside the workspace when it is the one being run", () => {
    expect(filesToSaveForRun(paths, "/tmp/scratch.py", ["/tmp/scratch.py"])).toEqual(["/tmp/scratch.py"]);
  });
  it("saves nothing when nothing is dirty", () => {
    expect(filesToSaveForRun(paths, "/w/recipes/r.py", [])).toEqual([]);
  });
  it("does not match a sibling folder with the same prefix", () => {
    expect(filesToSaveForRun(paths, null, ["/w/recipes-old/a.py", "/w/functions2/b.py"])).toEqual([]);
  });
});

function fakeCtx() {
  const order: string[] = [];
  const commands = new Map<string, (...a: any[]) => unknown>();
  const ctx: any = {
    module: "vm",
    invoke: vi.fn(async () => []),
    on: vi.fn(() => () => {}),
    registerActivity: vi.fn(), registerSidebarView: vi.fn(), registerTabType: vi.fn(), openTab: vi.fn(),
    registerStatusItem: vi.fn(() => ({ update: vi.fn() })), registerRecipeAction: vi.fn(), registerSettingsSection: vi.fn(),
    registerCommand: (c: { id: string; run: (...a: any[]) => unknown }) => commands.set(c.id, c.run),
    executeCommand: vi.fn(),
    showModal: vi.fn((m: { title: string }) => { order.push(`modal:${m.title}`); return { close() {} }; }),
    notify: vi.fn(),
    terminal: { create: vi.fn(), write: vi.fn(), onData: vi.fn(), dispose: vi.fn() },
    workspace: {
      activeFile: () => "/w/recipes/r.py",
      onActiveFile: vi.fn(),
      open: vi.fn(),
      listRecipes: vi.fn(async () => []),
      saveForRun: vi.fn(async (p: string) => { order.push(`save:${p}`); return [p]; }),
    },
  };
  activate(ctx);
  return { ctx, order, run: (...a: any[]) => commands.get("blackhole.runOnVm")!(...a) as Promise<void> };
}

describe("Run on VM", () => {
  it("saves before it opens the dialog", async () => {
    const f = fakeCtx();
    await f.run();
    expect(f.order).toEqual(["save:/w/recipes/r.py", "modal:Run on VM"]);
  });
  it("saves the recipe it was given from the sidebar, not the active tab", async () => {
    const f = fakeCtx();
    await f.run("/w/recipes/other.py");
    expect(f.ctx.workspace.saveForRun).toHaveBeenCalledWith("/w/recipes/other.py");
  });
  it("does not open the dialog when the save fails", async () => {
    const f = fakeCtx();
    f.ctx.workspace.saveForRun = vi.fn(async () => { throw new Error("disk full"); });
    await f.run();
    expect(f.ctx.showModal).not.toHaveBeenCalled();
    expect(f.ctx.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error");
  });
});
