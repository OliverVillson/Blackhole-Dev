// The split layout of editor groups as a tree: a leaf is a group, a split lays its children
// out in a row (side by side) or a column (stacked). Pure, so it is tested without a DOM.

export type Dir = "row" | "col";
export type Side = "left" | "right" | "up" | "down";

export type LayoutNode<G> =
  | { kind: "leaf"; group: G }
  | { kind: "split"; dir: Dir; children: LayoutNode<G>[]; sizes: number[] };

export const leaf = <G>(group: G): LayoutNode<G> => ({ kind: "leaf", group });

export function groupsOf<G>(n: LayoutNode<G>): G[] {
  return n.kind === "leaf" ? [n.group] : n.children.flatMap((c) => groupsOf(c));
}

function find<G>(n: LayoutNode<G>, g: G, parent: LayoutNode<G> | null = null): { node: LayoutNode<G>; parent: LayoutNode<G> | null } | null {
  if (n.kind === "leaf") return n.group === g ? { node: n, parent } : null;
  for (const c of n.children) {
    const r = find(c, g, n);
    if (r) return r;
  }
  return null;
}

/** Put `added` next to `target` on `side`. Returns the new root. */
export function split<G>(root: LayoutNode<G>, target: G, added: G, side: Side): LayoutNode<G> {
  const dir: Dir = side === "left" || side === "right" ? "row" : "col";
  const after = side === "right" || side === "down";
  const hit = find(root, target);
  if (!hit) throw new Error("group not in layout");
  const parent = hit.parent;
  if (parent && parent.kind === "split" && parent.dir === dir) {
    const i = parent.children.indexOf(hit.node);
    const half = parent.sizes[i] / 2;
    parent.sizes[i] = half;
    parent.children.splice(after ? i + 1 : i, 0, leaf(added));
    parent.sizes.splice(after ? i + 1 : i, 0, half);
    return root;
  }
  const pair = after ? [hit.node, leaf(added)] : [leaf(added), hit.node];
  const node: LayoutNode<G> = { kind: "split", dir, children: pair, sizes: [1, 1] };
  if (!parent || parent.kind !== "split") return node;
  parent.children[parent.children.indexOf(hit.node)] = node;
  return root;
}

/** Drop a group; a split left with one child collapses into it. Returns the new root. */
export function remove<G>(root: LayoutNode<G>, g: G): LayoutNode<G> {
  const hit = find(root, g);
  if (!hit || !hit.parent || hit.parent.kind !== "split") return root;
  const p = hit.parent;
  const i = p.children.indexOf(hit.node);
  const freed = p.sizes[i];
  p.children.splice(i, 1);
  p.sizes.splice(i, 1);
  if (p.sizes.length) p.sizes[Math.max(0, i - 1)] += freed;
  return normalize(root);
}

function normalize<G>(n: LayoutNode<G>): LayoutNode<G> {
  if (n.kind === "leaf") return n;
  n.children = n.children.map((c) => normalize(c));
  // A split whose child splits the same way absorbs its children.
  for (let i = 0; i < n.children.length; i++) {
    const c = n.children[i];
    if (c.kind === "split" && c.dir === n.dir) {
      const total = c.sizes.reduce((a, b) => a + b, 0) || 1;
      const scaled = c.sizes.map((s) => (s / total) * n.sizes[i]);
      n.children.splice(i, 1, ...c.children);
      n.sizes.splice(i, 1, ...scaled);
      i += c.children.length - 1;
    }
  }
  return n.children.length === 1 ? n.children[0] : n;
}

/** Which drop zone a point falls in, as fractions of the target's box. Center moves the tab into the group. */
export function dropZone(fx: number, fy: number): Side | "center" {
  const d = { left: fx, right: 1 - fx, up: fy, down: 1 - fy };
  const [side, dist] = (Object.entries(d) as [Side, number][]).sort((a, b) => a[1] - b[1])[0];
  return dist < 0.3 ? side : "center";
}
