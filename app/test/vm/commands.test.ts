import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as cmd from "../../src/vm/remote/commands";

const sh = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8" });

describe("q", () => {
  it("survives sh for any string", () => {
    for (const s of ["plain", "with space", "it's", "a'b'c", "$HOME `x` $(y)", "semi;colon && rm -rf /", "new\nline", ""]) {
      expect(sh(`printf %s ${cmd.q(s)}`)).toBe(s);
    }
  });
  it("leaves ~/ for the remote shell to expand", () => {
    expect(sh(`printf %s ${cmd.q("~/x y")}`)).toBe(`${process.env.HOME}/x y`);
  });
});

describe("job names", () => {
  it("follows the TUI's shape", () => {
    expect(cmd.jobName("qwen-mac-hex.py", new Date(2026, 9, 26, 10, 18, 3))).toBe("qwen-mac-hex-1026-101803");
    expect(cmd.jobName("My Recipe!!", new Date(2026, 0, 2, 3, 4, 5))).toBe("my-recipe-0102-030405");
    expect(cmd.validJobName("a-b_c.1")).toBe(true);
    expect(cmd.validJobName("../etc")).toBe(false);
  });
});

describe("tmuxLaunch", () => {
  it("is one command whose inner script runs the pipeline with --recipe into events.log", () => {
    const c = cmd.tmuxLaunch({ venv: "/home/u/bh-venv", dir: "/home/u/.blackhole/jobs/j 1", session: "bh-j" });
    expect(c.startsWith("tmux new-session -d -s bh-j -c ")).toBe(true);
    const inner = cmd.pipelineCommand({ venv: "/home/u/bh-venv", dir: "/home/u/.blackhole/jobs/j 1" });
    expect(inner).toContain("-m blackhole_pipeline --job '/home/u/.blackhole/jobs/j 1' --recipe '/home/u/.blackhole/jobs/j 1/recipe.bhr'");
    expect(inner).toContain(">> '/home/u/.blackhole/jobs/j 1/events.log' 2>&1");
    // the tmux argument unquotes back to exactly bash -c <inner>
    const arg = sh(`printf %s ${c.slice(c.indexOf("'/home/u/.blackhole/jobs/j 1' ") + "'/home/u/.blackhole/jobs/j 1' ".length)}`);
    expect(arg).toBe(`bash -c ${cmd.q(inner)}`);
  });
});
