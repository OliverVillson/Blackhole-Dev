// Tab autofill: candidates for the word before the cursor. Pure functions (tested without
// Monaco); monaco.ts wires them into a completion provider and the Tab key.

export type CandKind = "api" | "function" | "keyword" | "word";

export interface Candidate {
  label: string;
  kind: CandKind;
  detail?: string;
  insert?: string;
}

export interface WordContext {
  /** Text being completed (identifier, or the inside of a string up to the cursor). */
  prefix: string;
  /** 1-based column where the prefix starts. */
  startCol: number;
  inString: boolean;
  /** The receiver before a dot, such as "recipe" in `recipe.fn`. */
  receiver: string | null;
}

const IDENT = /[A-Za-z0-9_]/;

/** What the cursor is completing on this line. `col` is Monaco's 1-based column. */
export function contextAt(line: string, col: number): WordContext {
  const before = line.slice(0, col - 1);
  let quote: string | null = null;
  let qpos = -1;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "#") break;
    else if (c === '"' || c === "'") (quote = c), (qpos = i);
  }
  if (quote) return { prefix: before.slice(qpos + 1), startCol: qpos + 2, inString: true, receiver: null };
  let i = before.length;
  while (i > 0 && IDENT.test(before[i - 1])) i--;
  const prefix = before.slice(i);
  let receiver: string | null = null;
  if (before[i - 1] === ".") {
    let j = i - 1;
    while (j > 0 && IDENT.test(before[j - 1])) j--;
    receiver = before.slice(j, i - 1) || null;
  }
  return { prefix, startCol: i + 1, inString: false, receiver };
}

/** True when the character after the cursor continues a word (Tab then indents instead). */
export function midWord(line: string, col: number): boolean {
  return IDENT.test(line[col - 1] ?? "");
}

export function wordsIn(text: string, min = 3): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (m[0].length >= min) out.add(m[0]);
  return out;
}

const RANK: Record<CandKind, number> = { api: 0, function: 1, keyword: 2, word: 3 };

/** Ranked candidates for a context. Strings complete function and step names only. */
export function candidates(ctx: WordContext, pool: Candidate[], limit = 50): Candidate[] {
  const p = ctx.prefix;
  if (!p) return [];
  const lower = p.toLowerCase();
  const seen = new Set<string>();
  const hits: Candidate[] = [];
  for (const c of pool) {
    if (ctx.inString !== (c.kind === "function" || c.detail === "pipeline step")) continue;
    if (c.label === p || seen.has(c.label) || !c.label.toLowerCase().startsWith(lower)) continue;
    const member = !!c.detail?.startsWith("Recipe.");
    if (member !== !!ctx.receiver && c.kind !== "word") continue;
    seen.add(c.label);
    hits.push(c);
  }
  return hits
    .sort((a, b) =>
      Number(!a.label.startsWith(p)) - Number(!b.label.startsWith(p)) ||
      RANK[a.kind] - RANK[b.kind] || a.label.length - b.label.length || a.label.localeCompare(b.label))
    .slice(0, limit);
}

const PY_KEYWORDS = "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ");
const PY_BUILTINS = "abs all any bool dict enumerate filter float int isinstance len list map max min print range round set sorted str sum tuple zip".split(" ");

/** The recipe API (blackhole_dev.recipe) every recipe file uses. */
export const RECIPE_API: Candidate[] = [
  { label: "Recipe", kind: "api", detail: "blackhole_dev.recipe", insert: "Recipe" },
  { label: "gate", kind: "api", detail: "blackhole_dev.recipe" },
  { label: "Ref", kind: "api", detail: "blackhole_dev.recipe" },
  { label: "Step", kind: "api", detail: "blackhole_dev.recipe" },
  { label: "RecipeError", kind: "api", detail: "blackhole_dev.recipe" },
  { label: "blackhole_dev", kind: "api", detail: "package" },
  { label: "recipe", kind: "api", detail: "module or Recipe instance" },
  ...["input", "step", "fn", "edit", "eval", "to_raw", "schema", "runner", "step_at"].map((m) => ({ label: m, kind: "api" as const, detail: `Recipe.${m}` })),
  ...["reap", "heal", "gptq", "reaq", "mlx", "qheal", "bench", "quant", "package"].map((s) => ({ label: `pipeline.${s}`, kind: "api" as const, detail: "pipeline step" })),
  ...PY_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
  ...PY_BUILTINS.map((k) => ({ label: k, kind: "keyword" as const, detail: "builtin" })),
];

/** Letters of q appear in order in s (so "qmq" finds "qwen_mac_qhex.py"). */
export function fuzzy(q: string, s: string): boolean {
  if (s.includes(q)) return true;
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return false;
}
