import { describe, expect, it } from "vitest";
import { FenceSplitter, parseFenceInfo, type FenceEvent } from "../../src/copilot/fence";
import { ThinkSplitter } from "../../src/llm/openaiCompat";

const SRC = "I'll write it now.\n\n```python path=recipes/q.py mode=new\nfrom blackhole_dev.recipe import Recipe\nx = `a`\n```\nDone, linting next.";

function collect(chunks: string[]) {
  const f = new FenceSplitter();
  const ev: FenceEvent[] = [];
  for (const c of chunks) ev.push(...f.push(c));
  ev.push(...f.end());
  let prose = "", code = "";
  const opens: string[] = [];
  let closes = 0;
  for (const e of ev) {
    if (e.type === "prose") prose += e.text;
    else if (e.type === "code") code += e.text;
    else if (e.type === "open") opens.push(`${e.info.path}|${e.info.mode}`);
    else closes++;
  }
  return { prose, code, opens, closes };
}

describe("FenceSplitter", () => {
  it("splits prose and code the same way for any chunking", () => {
    const whole = collect([SRC]);
    expect(whole.code).toBe("from blackhole_dev.recipe import Recipe\nx = `a`\n");
    expect(whole.prose).toBe("I'll write it now.\n\nDone, linting next.");
    expect(whole.opens).toEqual(["recipes/q.py|new"]);
    expect(whole.closes).toBe(1);
    for (let size = 1; size < 12; size++) {
      const chunks = [];
      for (let i = 0; i < SRC.length; i += size) chunks.push(SRC.slice(i, i + size));
      expect(collect(chunks)).toEqual(whole);
    }
  });

  it("closes an unterminated fence at the end", () => {
    const r = collect(["```python\nprint(1)\n"]);
    expect(r.code).toBe("print(1)\n");
    expect(r.closes).toBe(1);
  });

  it("parses info strings", () => {
    expect(parseFenceInfo("python path=a.py mode=append")).toEqual({ lang: "python", path: "a.py", mode: "append" });
    expect(parseFenceInfo("python")).toEqual({ lang: "python", mode: "new" });
  });
});

describe("ThinkSplitter", () => {
  it("splits <think> across chunk boundaries", () => {
    const s = "<think>plan the experts</think>Here is the recipe";
    for (let size = 1; size < 9; size++) {
      const t = new ThinkSplitter();
      let text = "", reasoning = "";
      for (let i = 0; i < s.length; i += size) {
        const r = t.push(s.slice(i, i + size));
        text += r.text;
        reasoning += r.reasoning;
      }
      const r = t.flush();
      text += r.text;
      reasoning += r.reasoning;
      expect({ text, reasoning }).toEqual({ text: "Here is the recipe", reasoning: "plan the experts" });
    }
  });

  const run = (s: string, size: number, opts = {}) => {
    const t = new ThinkSplitter(opts);
    let text = "", reasoning = "";
    for (let i = 0; i < s.length; i += size) {
      const r = t.push(s.slice(i, i + size));
      text += r.text;
      reasoning += r.reasoning;
    }
    const r = t.flush();
    return { text: text + r.text, reasoning: reasoning + r.reasoning };
  };

  it("treats text before an orphan </think> as reasoning (Qwen3.6 templates) and trims the blank lines after it", () => {
    for (let size = 1; size < 9; size++) {
      expect(run("count experts first</think>\n\nHere it is", size)).toEqual({ text: "Here it is", reasoning: "count experts first" });
      expect(run("<think>a</think>\n\nb", size)).toEqual({ text: "b", reasoning: "a" });
      expect(run("no thinking at all", size)).toEqual({ text: "no thinking at all", reasoning: "" });
    }
  });

  it("drops a late orphan </think> and honours startsInThink", () => {
    expect(run("x".repeat(20) + "</think>\nok", 3, { probeChars: 5 })).toEqual({ text: "x".repeat(20) + "ok", reasoning: "" });
    expect(run("long reasoning</think>ok", 4, { startsInThink: true, probeChars: 2 })).toEqual({ text: "ok", reasoning: "long reasoning" });
  });
});
