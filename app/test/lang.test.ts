import { describe, expect, it } from "vitest";
import type { Catalog } from "../src/shared/lang";
import { complete, fixesFor, hover, narrow, queryItems, scan, signature } from "../src/renderer/editor/lang";
import raw from "./fixtures/lang_catalog.json";

const cat = raw as unknown as Catalog;
const HEAD = 'from blackhole_dev.recipe import Recipe, gate\n\nrecipe = Recipe("you/x", "0.1.0", base="Qwen/Qwen3.6-35B-A3B")\n';
/** Completions with the cursor at "|". */
const at = (src: string) => {
  const i = src.indexOf("|");
  return complete(src.slice(0, i) + src.slice(i + 1), i, cat);
};
const labels = (src: string) => at(src).items.map((x) => x.label);

describe("scan", () => {
  it("finds the call, argument and keyword around the cursor", () => {
    const s = scan('recipe.fn("reap-prune", ratio=0.3, min_keep');
    const f = s.frames[0];
    expect(f.callee).toBe("recipe.fn");
    expect(f.args.map((a) => [a.kw, a.str])).toEqual([[null, "reap-prune"], ["ratio", null]]);
    expect(s.str).toBeNull();
  });

  it("knows when the cursor is in a string, and ignores brackets in strings and comments", () => {
    const s = scan('x = "(" # (\nrecipe.step("pipeline.re');
    expect(s.frames.length).toBe(1);
    expect(s.str?.prefix).toBe("pipeline.re");
    expect(scan("# recipe.fn(").comment).toBe(true);
    expect(scan('f"{a}" + recipe.fn(').frames[0].callee).toBe("recipe.fn");
  });

  it("tracks dict keys", () => {
    const s = scan('Recipe("a/b", targets={"architectures": ["');
    expect(s.frames.map((f) => f.open)).toEqual(["(", "{", "["]);
    expect(s.frames[1].dictKey).toBe("architectures");
  });
});

describe("completions", () => {
  it("offers function names with docs inside recipe.fn(\"", () => {
    const a = at(HEAD + 'recipe.fn("rea|');
    expect(a.generic).toBe(false);
    expect(a.items.map((x) => x.label)).toContain("reap-prune");
    expect(a.items.find((x) => x.label === "reap-prune")?.doc).toMatch(/ratio/);
    expect(a.items[0].replace).toBe(3);
  });

  it("offers pipeline stages and catalog ops inside recipe.step(\"", () => {
    const l = labels(HEAD + 'recipe.step("|');
    expect(l).toContain("pipeline.reap");
    expect(l).toContain("quant.gptq");
  });

  it("offers a function's own args, then step options, without the ones given", () => {
    const l = labels(HEAD + 'recipe.fn("reap-prune", ratio=0.3, |');
    expect(l).toContain("min_keep=");
    expect(l).toContain("gates=");
    expect(l).not.toContain("ratio=");
    expect(l.indexOf("min_keep=")).toBeLessThan(l.indexOf("gates="));
  });

  it("puts a pipeline stage's own params first", () => {
    const l = labels(HEAD + 'recipe.step("pipeline.mlx", |');
    expect(l[0]).toMatch(/^mlx_/);
    expect(l).toContain("heal_minutes=");
  });

  it("offers catalog op params", () => {
    const l = labels(HEAD + 'recipe.step("quant.gptq", |');
    expect(l.length).toBeGreaterThan(1);
    expect(l).toContain("gates=");
  });

  it("offers Recipe fields and model ids", () => {
    const l = labels('from blackhole_dev.recipe import Recipe\nrecipe = Recipe("a/b", "1.0", |');
    expect(l).toContain("title=");
    expect(l).toContain("targets=");
    expect(l).not.toContain("version=");
    expect(labels('recipe = Recipe("a/b", base="Qw|')).toContain("Qwen/Qwen3.6-35B-A3B");
    expect(labels('recipe = Recipe("a/b", targets={"architectures": ["|')).toEqual(["moe", "dense", "hybrid"]);
    expect(labels('recipe = Recipe("a/b", meta={"target": "|')).toContain("mac16");
  });

  it("offers input types, gate ops and metrics", () => {
    expect(labels(HEAD + 'recipe.input("prune", "|')).toContain("float");
    expect(labels(HEAD + 'recipe.step("pipeline.reap", gates=[gate("kl", "|')).toContain("<=");
    expect(labels(HEAD + 'recipe.eval(gates=[gate("|')).toContain("kl");
  });

  it("completes part queries in select=", () => {
    expect(labels(HEAD + 'recipe.fn("add-noise", select="lay|')).toContain("layers");
    expect(labels(HEAD + 'recipe.fn("add-noise", select="layers[*].|')).toContain("moe");
    expect(labels(HEAD + 'recipe.fn("add-noise", select="layers[*].moe.|')).toEqual(["router", "experts", "shared"]);
    expect(labels(HEAD + 'recipe.fn("add-noise", select="layers[*].moe.experts[ra|')).toContain("rank");
    expect(queryItems("layers[kind==m", cat).map((x) => x.label)).toContain("moe");
  });

  it("completes recipe members, inputs and step artifacts after a dot", () => {
    const l = labels(HEAD + "recipe.|");
    expect(l).toContain("step");
    expect(l).toContain("inputs");
    expect(l.some((x) => x.startsWith('fn("reap-prune"'))).toBe(true);
    expect(labels(HEAD + 'p = recipe.input("prune", "float")\nrecipe.inputs.|')).toEqual(["prune"]);
    expect(labels(HEAD + 'r = recipe.fn("reap-prune")\nr.|')).toContain("model");
  });

  it("offers snippets at the start of a line", () => {
    const a = at(HEAD + "rec|");
    const s = a.items.find((x) => x.label === "new recipe");
    expect(s?.snippet).toBe(true);
    expect(a.items.some((x) => x.insert?.startsWith('recipe.step("pipeline.reap", prune=${1:0.25}'))).toBe(true);
    expect(at(HEAD + "x = |").items.some((x) => x.snippet)).toBe(false);
  });

  it("stays out of comments and leaves generic Python to Jedi", () => {
    expect(at(HEAD + "# recipe.fn(|").items).toEqual([]);
    const a = at(HEAD + "import numpy as np\nnp.ze|");
    expect(a.generic).toBe(true);
    expect(a.prefix).toBe("ze");
  });
});

describe("signature help", () => {
  it("shows a function's args and the active one", () => {
    const src = HEAD + 'recipe.fn("reap-prune", min_keep=';
    const s = signature(src, src.length, cat)!;
    expect(s.label).toMatch(/recipe\.fn\("reap-prune", ratio: float = 0\.25, min_keep: int = 0/);
    expect(s.params[s.active].label).toMatch(/^min_keep/);
  });

  it("shows a pipeline stage's params and Recipe methods", () => {
    const src = HEAD + 'recipe.step("pipeline.gptq", ';
    expect(signature(src, src.length, cat)!.label).toMatch(/gptq_calib = 64/);
    const g = HEAD + 'gate("kl", ';
    const s = signature(g, g.length, cat)!;
    expect(s.params[s.active].label).toMatch(/^op/);
    expect(signature("np.zeros(", 9, cat)).toBeNull();
  });
});

describe("hover", () => {
  it("explains function names, stages and keyword args", () => {
    const src = HEAD + 'recipe.fn("reap-prune", ratio=0.3)\nrecipe.step("pipeline.heal", heal_minutes=60)\n';
    expect(hover(src, src.indexOf("reap-prune") + 2, cat)?.md).toMatch(/REAP/);
    expect(hover(src, src.indexOf("ratio") + 1, cat)?.md).toMatch(/float/);
    expect(hover(src, src.indexOf("pipeline.heal") + 3, cat)?.md).toMatch(/heal_prompts/);
    expect(hover(src, src.indexOf("heal_minutes") + 1, cat)?.md).toMatch(/pipeline\.heal/);
  });
});

describe("diagnostics", () => {
  it("points at the param a lint message names", () => {
    const line = 'recipe.fn("reap-prune", ratoi=0.3)';
    expect(narrow(line, "reap-prune: unknown param 'ratoi' (has ['min_keep', 'ratio'])")).toEqual({ start: 25, end: 30 });
    expect(narrow('recipe.fn("reap-prunee")', "unknown function 'reap-prunee'")).toEqual({ start: 11, end: 24 });
  });

  it("suggests the closest names", () => {
    expect(fixesFor("reap-prune: unknown param 'ratoi' (has ['min_keep', 'ratio'])", cat, "ratoi")[0]).toBe("ratio");
    expect(fixesFor("pipeline.mlx: unknown param 'mlx_bit' (did you mean mlx_bits, mlx_group?)", cat, "mlx_bit")[0]).toBe("mlx_bits");
    expect(fixesFor("unknown function 'reap-prunee'", cat, "reap-prunee")[0]).toBe("reap-prune");
  });
});
