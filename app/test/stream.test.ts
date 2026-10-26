// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import type * as Monaco from "monaco-editor";
import { StreamManager, type StreamHost } from "../src/renderer/editor/stream";

let monaco: typeof Monaco;
beforeAll(async () => {
  monaco = (await import("monaco-editor/editor/editor.api.js")) as unknown as typeof Monaco;
}, 60_000);

function setup(text: string) {
  const model = monaco.editor.createModel(text, "python");
  const ghosts: (string | null)[] = [];
  const host: StreamHost = { model: () => model, cursor: () => null, renderGhost: (_f, _a, t) => ghosts.push(t) };
  return { model, ghosts, sm: new StreamManager(host) };
}

const userType = (model: Monaco.editor.ITextModel, line: number, col: number, text: string, endLine = line, endCol = col) =>
  model.pushEditOperations([], [{ range: new monaco.Range(line, col, endLine, endCol), text }], () => null);

describe("I3 editor streams", () => {
  it("streams chunks at the end and marks them as one pending copilot hunk", () => {
    const { model, sm } = setup("import x\n");
    const id = sm.streamBegin("r.py", { at: "end" });
    sm.streamChunk(id, "recipe = Re");
    sm.streamChunk(id, "cipe(\n    base='q',\n");
    sm.streamChunk(id, ")\n");
    const hunks = sm.streamEnd(id);
    expect(model.getValue()).toBe("import x\nrecipe = Recipe(\n    base='q',\n)\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ kind: "copilot", state: "pending", startLine: 2, endLine: 4 });
  });

  it("keeps the user's mid-stream edit as a user hunk and rejecting copilot text leaves it", () => {
    const { model, sm } = setup("");
    const id = sm.streamBegin("r.py", { at: "end" });
    sm.streamChunk(id, "a = 1\nb = 2\nc = 3\n");
    userType(model, 2, 5, "20", 2, 6); // user changes b = 2 -> b = 20
    sm.streamChunk(id, "d = 4\n");
    sm.streamEnd(id);
    expect(model.getValue()).toBe("a = 1\nb = 20\nc = 3\nd = 4\n");
    const hs = sm.hunks("r.py");
    expect(hs.map((h) => [h.kind, h.startLine, h.endLine])).toEqual([
      ["copilot", 1, 1],
      ["user", 2, 2],
      ["copilot", 3, 4],
    ]);
    sm.rejectAll("r.py");
    expect(model.getValue()).toBe("b = 20\n");
  });

  it("continues below text the user typed at the stream position", () => {
    const { model, sm } = setup("");
    const id = sm.streamBegin("r.py", { at: "end" });
    sm.streamChunk(id, "x = 1\n");
    userType(model, 2, 1, "# mine");
    sm.streamChunk(id, "y = 2\n");
    sm.streamEnd(id);
    expect(model.getValue()).toBe("x = 1\n# mine\ny = 2\n");
  });

  it("replaceRange swaps lines and reject restores the original", () => {
    const { model, sm } = setup("one\ntwo\nthree\n");
    const id = sm.streamBegin("r.py", { replaceRange: { startLine: 2, endLine: 2 } });
    sm.streamChunk(id, "TWO");
    const [h] = sm.streamEnd(id);
    expect(model.getValue()).toBe("one\nTWO\nthree\n");
    sm.rejectHunk(h.id);
    expect(model.getValue()).toBe("one\ntwo\nthree\n");
  });

  it("accept keeps text and clears the hunk; abort keeps text pending", () => {
    const { model, sm } = setup("");
    const id = sm.streamBegin("r.py");
    sm.streamChunk(id, "z = 9\n");
    sm.streamAbort(id);
    expect(sm.hunks("r.py")).toHaveLength(1);
    sm.acceptAll("r.py");
    expect(sm.hunks("r.py")).toHaveLength(0);
    expect(model.getValue()).toBe("z = 9\n");
  });

  it("applyEdits records replaced text so a reject undoes it", () => {
    const { model, sm } = setup("prune = 0.25\n");
    const [h] = sm.applyEdits("r.py", [{ startLine: 1, startCol: 9, endLine: 1, endCol: 13, text: "0.3125" }]);
    expect(model.getValue()).toBe("prune = 0.3125\n");
    sm.rejectHunk(h.id);
    expect(model.getValue()).toBe("prune = 0.25\n");
  });

  it("reports user edits with the stream id", () => {
    const { model, sm } = setup("");
    const seen: unknown[] = [];
    sm.onUserEdit("r.py", (e) => seen.push(e));
    const id = sm.streamBegin("r.py");
    sm.streamChunk(id, "a = 1\n");
    userType(model, 1, 5, "2", 1, 6);
    expect(seen).toEqual([{ file: "r.py", streamId: id, startLine: 1, endLine: 1, text: "2" }]);
  });

  it("ghost text follows the live stream and clears at the end", () => {
    const { sm, ghosts } = setup("");
    const id = sm.streamBegin("r.py");
    sm.setGhost("r.py", "next()");
    sm.streamEnd(id);
    expect(ghosts).toEqual(["next()", null]);
  });
});
