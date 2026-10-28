import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HelperClient, RpcError } from "../src/main/helper";

const FAKE = join(__dirname, "fixtures", "fake_helper.py");
const init = { workspace: "/tmp", recipesDir: "/tmp/r", functionsDir: "/tmp/f", modelsDir: "/tmp/m", client: "blackhole-dev-app" as const, version: "test" };

function client(backoffMs = [50, 50, 50]) {
  return new HelperClient({ python: () => "python3", args: [FAKE], cwd: __dirname, init, backoffMs });
}

describe("I1 helper client", () => {
  it("initializes, calls methods, reports status, stops", async () => {
    const c = client();
    const states: string[] = [];
    c.on("status", (s) => states.push(s.state));
    const r = await c.call<{ devices: unknown[] }>("recipe.devices", {});
    expect(r.devices).toHaveLength(2);
    expect(c.status()).toMatchObject({ state: "ready", version: "0.1.0-fake" });
    await c.stop();
    expect(states).toEqual(["starting", "ready", "down"]);
  });

  it("turns JSON-RPC errors into RpcError", async () => {
    const c = client();
    await expect(c.call("nope.method", {})).rejects.toMatchObject({ code: -32601 });
    await c.stop();
  });

  it("lints unsaved text and points at the line", async () => {
    const c = client();
    const r = await c.call<{ problems: { line: number; code: string }[] }>("recipe.lint", { path: "/tmp/x.py", text: "recipe = Recipe(\n  base=\n" });
    expect(r.problems[0].code).toBe("syntax");
    await c.stop();
  });

  it("restarts after a crash and fails pending calls", async () => {
    const c = client();
    await c.start();
    await expect(c.call("crash", {})).rejects.toBeInstanceOf(RpcError);
    await new Promise((r) => setTimeout(r, 400));
    expect(c.status().state).toBe("ready");
    await c.stop();
  });

  it("reports a missing Python", async () => {
    const c = new HelperClient({ python: () => "/nope/python3", cwd: __dirname, init });
    await expect(c.start()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.status().state).toBe("missing");
  });
  it("reads a function env at every start (the Hugging Face token from Settings)", async () => {
    let token = "hf_one";
    const seen: (string | undefined)[] = [];
    const spawnFn = ((cmd: string, args: string[], o: any) => {
      seen.push(o.env.HF_TOKEN);
      return spawn(cmd, args, o);
    }) as typeof spawn;
    const c = new HelperClient({ python: () => "python3", args: [FAKE], cwd: __dirname, init, env: () => ({ HF_TOKEN: token }), spawnFn });
    await c.start();
    token = "hf_two";
    await c.restart();
    expect(seen).toEqual(["hf_one", "hf_two"]);
    await c.stop();
  });
});
