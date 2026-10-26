import { describe, expect, it } from "vitest";
import { RECIPE_API, candidates, contextAt, fuzzy, midWord, wordsIn, type Candidate } from "../src/renderer/editor/complete";

const pool: Candidate[] = [...RECIPE_API, { label: "reap-prune", kind: "function" }, { label: "hex-quantize", kind: "function" }, ...[...wordsIn("prune_ratio = 0.3\nprune_floor = 2")].map((w) => ({ label: w, kind: "word" as const }))];
const at = (line: string) => contextAt(line, line.length + 1);

describe("tab autofill", () => {
  it("completes words, API first", () => {
    expect(candidates(at("x = pru"), pool).map((c) => c.label)).toEqual(["prune_floor", "prune_ratio"]);
    expect(candidates(at("r = Rec"), pool)[0].label).toBe("Recipe");
    expect(candidates(at("    ret"), pool)[0].label).toBe("return");
  });

  it("offers Recipe methods after a dot", () => {
    const c = at("recipe.st");
    expect(c.receiver).toBe("recipe");
    expect(candidates(c, pool).map((x) => x.label)).toEqual(["step", "step_at"]);
    expect(candidates(at("st"), pool).map((x) => x.label)).not.toContain("step");
  });

  it("completes function and step names inside strings", () => {
    const c = at('recipe.fn("rea');
    expect(c).toMatchObject({ inString: true, prefix: "rea", startCol: 12 });
    expect(candidates(c, pool).map((x) => x.label)).toEqual(["reap-prune"]);
    expect(candidates(at('recipe.step("pipeline.q'), pool).map((x) => x.label)).toEqual(["pipeline.qheal", "pipeline.quant"]);
    expect(at('# "not a string').inString).toBe(false);
  });

  it("nothing to complete means Tab indents", () => {
    expect(candidates(at("    "), pool)).toEqual([]);
    expect(candidates(at("x = zzz"), pool)).toEqual([]);
    expect(candidates(at("x = return"), pool).map((c) => c.label)).not.toContain("return");
    expect(midWord("foo", 2)).toBe(true);
    expect(midWord("foo ", 4)).toBe(false);
  });

  it("quick open matches letters in order", () => {
    expect(fuzzy("qmq", "qwen_mac_qhex.py")).toBe(true);
    expect(fuzzy("xq", "qwen_mac_qhex.py")).toBe(false);
  });
});
