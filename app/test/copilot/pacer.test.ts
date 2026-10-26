import { describe, expect, it } from "vitest";
import { Pacer } from "../../src/copilot/pacer";
import { FakeEditor } from "./fakeEditor";

const run = (p: Pacer, n = 1000) => { for (let i = 0; i < n && p.tick(); i++); };

describe("Pacer", () => {
  it("keeps lookahead lines as ghost while the model writes, then types them out", async () => {
    const ed = new FakeEditor();
    const p = new Pacer(ed, "r.py", { at: "end" }, { lookaheadLines: 2, charsPerTick: 3 });
    p.push("a = 1\nb = 2\nc = 3\nd = 4\npartial");
    run(p, 200);
    expect(ed.getText("r.py")).toBe("a = 1\nb = 2\n");
    expect(ed.doc("r.py").ghost).toBe("c = 3\nd = 4\npartial");
    const done = p.finish();
    run(p);
    await done;
    expect(ed.getText("r.py")).toBe("a = 1\nb = 2\nc = 3\nd = 4\npartial");
    expect(ed.doc("r.py").ghost).toBeNull();
    expect(ed.hunks("r.py").map((h) => h.kind)).toEqual(["copilot"]);
  });

  it("types nothing while paused", () => {
    const ed = new FakeEditor();
    const p = new Pacer(ed, "r.py", { at: "end" }, { lookaheadLines: 0 });
    p.setPaused(true);
    p.push("x = 1\ny = 2\n");
    run(p, 50);
    expect(ed.getText("r.py")).toBe("");
    p.setPaused(false);
    run(p, 50);
    expect(ed.getText("r.py")).toBe("x = 1\ny = 2\n");
  });

  it("abort drops the ghost and keeps typed text", () => {
    const ed = new FakeEditor();
    const p = new Pacer(ed, "r.py", { at: "end" }, { lookaheadLines: 1 });
    p.push("one\ntwo\nthree\n");
    run(p, 50);
    p.abort();
    expect(ed.getText("r.py")).toBe("one\ntwo\n");
    expect(ed.doc("r.py").ghost).toBeNull();
  });
});
