import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets, type Cipher } from "../src/main/secrets";
import { Host } from "../src/main/host";
import { Workspace, ensureWorkspace, workspacePaths } from "../src/main/workspace";
import { pickPython } from "../src/main/python";
import { status } from "../src/main/licence";

const rot: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...s].reverse().join("")),
  decryptString: (b) => [...b.toString()].reverse().join(""),
};

describe("secrets", () => {
  it("stores values encrypted and reads them back", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "sec-")), "s.json");
    const s = new Secrets(f, rot);
    await s.set("anthropic-api-key", "sk-ant-123");
    expect(readFileSync(f, "utf8")).not.toContain("sk-ant-123");
    expect(await s.get("anthropic-api-key")).toBe("sk-ant-123");
    expect(await s.has("anthropic-api-key")).toBe(true);
    await s.delete("anthropic-api-key");
    expect(await s.get("anthropic-api-key")).toBeNull();
    await expect(s.set("../x", "v")).rejects.toThrow();
  });
});

describe("module host", () => {
  it("keeps modules inside their own channel namespace", async () => {
    const h = new Host();
    h.register("vm", "vm:up", (x: number) => x + 1);
    expect(await h.invoke("vm:up", [1])).toBe(2);
    expect(() => h.register("copilot", "vm:down", () => 0)).toThrow(/only register copilot/);
    expect(() => h.register("vm", "vm:up", () => 0)).toThrow(/already/);
    await expect(h.invoke("nope:x", [])).rejects.toThrow(/no handler/);
  });
});

describe("workspace", () => {
  it("creates the layout with a starter recipe and refuses paths outside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const p = workspacePaths(join(root, "w"), root);
    ensureWorkspace(p);
    expect(existsSync(join(p.recipes, "first-recipe.py"))).toBe(true);
    const ws = new Workspace(p);
    const made = await ws.create(p.recipes, "a b.py", "x");
    expect(made.endsWith("a-b.py")).toBe(true);
    const again = await ws.create(p.recipes, "a b.py", "y");
    expect(again.endsWith("a-b-2.py")).toBe(true);
    await expect(ws.read("/etc/passwd")).rejects.toThrow(/outside/);
    await expect(ws.read(join(p.workspace, "..", "x"))).rejects.toThrow(/outside/);
    expect((await ws.list(p.recipes)).map((e) => e.name)).toEqual(["a-b-2.py", "a-b.py", "first-recipe.py"]);
  });

  it("groups files into folders: mkdir, create in a subfolder, move, refuse moving into itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const p = workspacePaths(join(root, "w"), root);
    ensureWorkspace(p);
    const ws = new Workspace(p);
    const qwen = await ws.mkdir(p.recipes, "qwen");
    await expect(ws.mkdir(p.recipes, "qwen")).rejects.toThrow(/exists/);
    const nested = await ws.create(p.recipes, "mac/int 4.py", "x");
    expect(nested).toBe(join(p.recipes, "mac", "int-4.py"));
    await expect(ws.create(p.recipes, "../../escape.py", "x")).resolves.toBe(join(p.recipes, "escape.py"));
    const moved = await ws.move(join(p.recipes, "first-recipe.py"), qwen);
    expect(moved).toBe(join(qwen, "first-recipe.py"));
    await expect(ws.move(join(p.recipes, "escape.py"), qwen)).resolves.toBe(join(qwen, "escape.py"));
    await expect(ws.move(join(qwen, "escape.py"), qwen)).resolves.toBe(join(qwen, "escape.py"));
    const macDir = join(p.recipes, "mac");
    await expect(ws.move(p.recipes, macDir)).rejects.toThrow(/into itself/);
    await ws.move(macDir, qwen);
    const tree = await ws.list(p.recipes);
    expect(tree.map((e) => [e.name, e.dir])).toEqual([["qwen", true]]);
    expect(tree[0].children!.map((e) => e.name)).toEqual(["escape.py", "first-recipe.py", "mac"]);
    await expect(ws.move(qwen, "/tmp")).rejects.toThrow(/outside/);
  });
});

describe("python and licence", () => {
  it("prefers the setting, then python3", () => {
    expect(pickPython("/opt/py/bin/python3", undefined)).toBe("/opt/py/bin/python3");
    expect(pickPython("", "/nonexistent")).toBe("python3");
  });
  it("licence seam allows everything for now", () => {
    expect(status()).toMatchObject({ ok: true });
  });
});
