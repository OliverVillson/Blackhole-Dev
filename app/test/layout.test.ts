import { describe, expect, it } from "vitest";
import { dropZone, groupsOf, leaf, remove, split, type LayoutNode } from "../src/renderer/layout";

describe("editor group layout", () => {
  it("splits right and down, any number of groups, in reading order", () => {
    let root: LayoutNode<string> = leaf("a");
    root = split(root, "a", "b", "right");
    root = split(root, "b", "c", "right");
    expect(groupsOf(root)).toEqual(["a", "b", "c"]);
    expect(root.kind === "split" && root.dir).toBe("row");
    expect(root.kind === "split" && root.sizes.reduce((x, y) => x + y)).toBeCloseTo(2);
    root = split(root, "b", "d", "down");
    expect(groupsOf(root)).toEqual(["a", "b", "d", "c"]);
    root = split(root, "a", "e", "left");
    expect(groupsOf(root)).toEqual(["e", "a", "b", "d", "c"]);
  });

  it("removing groups collapses splits and gives the space back", () => {
    let root: LayoutNode<string> = leaf("a");
    root = split(root, "a", "b", "down");
    root = split(root, "b", "c", "right");
    root = remove(root, "c");
    expect(root).toEqual({ kind: "split", dir: "col", children: [leaf("a"), leaf("b")], sizes: [1, 1] });
    root = remove(root, "a");
    expect(root).toEqual(leaf("b"));
    expect(remove(root, "b")).toEqual(leaf("b"));
  });

  it("drop zones: edges split, the middle joins the group", () => {
    expect(dropZone(0.5, 0.9)).toBe("down");
    expect(dropZone(0.95, 0.5)).toBe("right");
    expect(dropZone(0.1, 0.5)).toBe("left");
    expect(dropZone(0.5, 0.1)).toBe("up");
    expect(dropZone(0.5, 0.5)).toBe("center");
  });
});
