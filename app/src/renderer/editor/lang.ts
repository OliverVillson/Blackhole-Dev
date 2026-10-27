// Recipe language support without Monaco: where the cursor is in Python terms (which call,
// which argument, inside which string), and what the recipe API offers there. monaco.ts and
// autofill.ts turn these answers into completions, signature help, hovers and quick fixes;
// Jedi (through the helper) fills in generic Python.

import type { Catalog, ParamInfo, Sig } from "../../shared/lang";

// ------------------------------------------------------------------ scanning

export interface Arg {
  kw: string | null;
  /** The value when the argument is exactly one string literal. */
  str: string | null;
  tokens: number;
}

export interface Frame {
  open: "(" | "[" | "{";
  /** Dotted name before "(", such as "recipe.fn" or "gate". */
  callee: string | null;
  args: Arg[];
  cur: Arg;
  /** "{" frames: the string key of the current entry once its ":" is seen. */
  dictKey: string | null;
  keyPos: boolean;
  lastStr: string | null;
}

export interface Scan {
  frames: Frame[];
  /** Set when the end of the text is inside a string: its quote and the content so far. */
  str: { quote: string; start: number; prefix: string } | null;
  comment: boolean;
}

const ID_START = /[A-Za-z_]/;
const ID = /[A-Za-z0-9_]/;

function newArg(): Arg {
  return { kw: null, str: null, tokens: 0 };
}

/** Python structure of `text` up to its end: open brackets with their calls and arguments. */
export function scan(text: string): Scan {
  const frames: Frame[] = [];
  let name: string | null = null; // dotted name being read
  let last: "id" | "str" | "op" | "close" | null = null;
  let lastId = "";
  let dot = false;
  const top = () => frames[frames.length - 1];
  const token = () => {
    const f = top();
    if (f) f.cur.tokens++;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      const e = text.indexOf("\n", i);
      if (e < 0) return { frames, str: null, comment: true };
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      let end = -1;
      while (j < n) {
        if (text[j] === "\\") j += 2;
        else if (text.startsWith(q, j)) { end = j; break; }
        else if (!triple && text[j] === "\n") break;
        else j++;
      }
      // a prefix such as f"" or rb'' was read as a name: it is part of the string
      const prefixed = last === "id" && /^[rbfuRBFU]{1,2}$/.test(lastId) && i > 0 && ID.test(text[i - 1]);
      if (!prefixed) token();
      if (end < 0) {
        if (j >= n) return { frames, str: { quote: q, start: i + q.length, prefix: text.slice(i + q.length) }, comment: false };
        i = j; // unterminated one-line string: skip to the line end
        continue;
      }
      const val = text.slice(i + q.length, end);
      const f = top();
      if (f) {
        f.cur.str = f.cur.tokens === 1 ? val : null;
        if (f.open === "{" && f.keyPos) f.lastStr = val;
      }
      last = "str";
      name = null;
      dot = false;
      i = end + q.length;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID.test(text[j])) j++;
      const w = text.slice(i, j);
      if (dot && name !== null) name += "." + w;
      else {
        name = w;
        token();
      }
      dot = false;
      last = "id";
      lastId = w;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(text[j])) j++;
      token();
      last = "op";
      name = null;
      i = j;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\\") { i++; continue; }
    if (c === "\n") {
      if (!frames.length) { name = null; last = null; dot = false; }
      i++;
      continue;
    }
    if (c === ".") {
      if (last === "id" || last === "close" || last === "str") dot = true;
      if (last !== "id") name = null;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      const callee = c === "(" && last === "id" && !dot ? name : null;
      if (last !== "id" && last !== "close") token();
      frames.push({ open: c, callee, args: [], cur: newArg(), dictKey: null, keyPos: true, lastStr: null });
      name = null;
      last = "op";
      dot = false;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      frames.pop();
      const f = top();
      if (f) f.cur.str = null;
      name = null;
      last = "close";
      i++;
      continue;
    }
    if (c === ",") {
      const f = top();
      if (f) {
        f.args.push(f.cur);
        f.cur = newArg();
        if (f.open === "{") { f.keyPos = true; f.dictKey = null; f.lastStr = null; }
      }
      name = null;
      last = "op";
      dot = false;
      i++;
      continue;
    }
    if (c === ":") {
      const f = top();
      if (f && f.open === "{" && f.keyPos) {
        f.keyPos = false;
        f.dictKey = f.lastStr;
        f.cur = newArg();
      }
      name = null;
      last = "op";
      i++;
      continue;
    }
    if (c === "=" && text[i + 1] !== "=" && !/[=<>!+\-*/%&|^@:]/.test(text[i - 1] ?? "")) {
      const f = top();
      if (f && f.open === "(" && last === "id" && f.cur.tokens === 1 && !f.cur.kw) {
        f.cur.kw = lastId;
        f.cur.tokens = 0;
        f.cur.str = null;
      } else if (!f) {
        name = null;
      }
      last = "op";
      name = null;
      i++;
      continue;
    }
    name = null;
    last = "op";
    dot = false;
    i++;
  }
  return { frames, str: null, comment: false };
}

// ------------------------------------------------------------------ the recipe file's own names

export interface FileFacts {
  recipeVars: Set<string>;
  inputs: string[];
  /** Variables holding a step: name -> step kind or function name. */
  steps: Map<string, string>;
}

export function facts(text: string): FileFacts {
  const recipeVars = new Set<string>(["recipe"]);
  for (const m of text.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\.)?Recipe\(/gm)) recipeVars.add(m[1]);
  const inputs = [...new Set([...text.matchAll(/\.input\(\s*["']([A-Za-z_]\w*)["']/g)].map((m) => m[1]))];
  const steps = new Map<string, string>();
  for (const m of text.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*\.(?:step|fn|edit)\(\s*(?:["']([^"']*)["'])?/gm)) steps.set(m[1], m[2] ?? "model.edit");
  return { recipeVars, inputs, steps };
}

// ------------------------------------------------------------------ what a call is

export type CallKind =
  | { t: "ctor" }
  | { t: "method"; name: string }
  | { t: "gate" }
  | { t: "function"; fn: string; via: "fn" | "call" }
  | { t: "pipeline"; stage: string }
  | { t: "op"; op: string };

const METHODS = new Set(["input", "step", "fn", "edit", "eval", "step_at"]);

/** What a "(" frame calls, from its callee and its first argument. */
export function callKind(f: Frame, ff: FileFacts): CallKind | null {
  if (f.open !== "(" || !f.callee) return null;
  const parts = f.callee.split(".");
  const last = parts[parts.length - 1];
  if (last === "Recipe") return { t: "ctor" };
  if (f.callee === "gate" || f.callee.endsWith(".gate")) return { t: "gate" };
  const recv = parts.slice(0, -1).join(".");
  const first = f.args[0] && !f.args[0].kw ? f.args[0].str : null;
  if (last === "call" && first) return { t: "function", fn: first, via: "call" };
  if (!recv || !(ff.recipeVars.has(recv) || recv === "r")) return null;
  if (!METHODS.has(last)) return null;
  if (last === "fn" && first) return { t: "function", fn: first, via: "fn" };
  if (last === "step" && first) {
    const op = first.split("@")[0];
    if (op.startsWith("pipeline.")) return { t: "pipeline", stage: op.slice(9) };
    return { t: "op", op };
  }
  return { t: "method", name: last };
}

// ------------------------------------------------------------------ completion items

export type ItemKind = "function" | "method" | "class" | "module" | "property" | "variable" | "keyword" | "value" | "snippet" | "text" | "enum" | "field" | "constant";

export interface Item {
  label: string;
  kind: ItemKind;
  detail?: string;
  doc?: string;
  insert?: string;
  snippet?: boolean;
  /** Characters before the cursor this item replaces. */
  replace: number;
  /** Lower sorts first (0 = most specific to where the cursor is). */
  rank: number;
  filter?: string;
}

export interface Answer {
  items: Item[];
  /** Also ask Jedi and add the generic words. */
  generic: boolean;
  /** The identifier being typed (empty in strings). */
  prefix: string;
}

function show(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return JSON.stringify(v);
}

const py = show;

function paramDetail(p: ParamInfo): string {
  const t = p.type ? `${p.type}` : "";
  const d = p.default !== undefined && p.default !== null && p.default !== "" ? `= ${py(p.default)}` : p.required ? "required" : "";
  return [t, d].filter(Boolean).join(" ");
}

function fnDoc(f: Catalog["functions"][number]): string {
  const ps = Object.entries(f.params).map(([k, p]) => `- \`${k}\` ${paramDetail(p)}`).join("\n");
  return `**${f.name}** · per ${f.per} · ${f.origin === "builtin" ? "built-in" : "my function"}\n\n${f.doc}${ps ? "\n\n" + ps : ""}`;
}

function stageParams(cat: Catalog, stage: string): [string, ParamInfo][] {
  return Object.entries(cat.pipeline.params).filter(([, p]) => p.stage === stage);
}

function stageDoc(cat: Catalog, stage: string): string {
  const s = cat.pipeline.steps.find((x) => x.name === stage);
  const ps = stageParams(cat, stage).map(([k, p]) => `- \`${k}\` = ${py(p.default)}${p.doc ? ": " + p.doc : ""}`).join("\n");
  return `**pipeline.${stage}** · stage of the real pipeline\n\n${s?.doc ?? ""}${ps ? "\n\n" + ps : ""}`;
}

function opDoc(o: Catalog["ops"][number]): string {
  const ps = Object.entries(o.params).map(([k, p]) => `- \`${k}\` ${paramDetail(p)}${p.help ? ": " + p.help : ""}`).join("\n");
  return `**${o.name}@${o.major}** · catalog op\n\n${o.doc.split("\n\n")[0]}${ps ? "\n\n" + ps : ""}`;
}

function sigDoc(name: string, s: Sig): string {
  return `\`${name}(${s.params.map((p) => p.label).join(", ")})\`\n\n${s.doc}`;
}

/** Keyword arguments a call takes: name -> [detail, doc]. Ordered best first. */
export function kwargsOf(k: CallKind, cat: Catalog): [string, string, string][] {
  const fromSig = (s: Sig, skip: string[] = []) =>
    s.params.filter((p) => !p.name.startsWith("**") && !skip.includes(p.name)).map((p) => [p.name, p.label, ""] as [string, string, string]);
  const opts = Object.entries(cat.stepOpts).map(([n, d]) => [n, "step option", d] as [string, string, string]);
  switch (k.t) {
    case "ctor":
      return [...fromSig(cat.recipe.ctor), ...Object.entries(cat.recipe.fields).map(([n, d]) => [n, "recipe field", d] as [string, string, string])];
    case "gate":
      return fromSig(cat.gate);
    case "method": {
      const s = cat.recipe.methods[k.name];
      const own = s ? fromSig(s, ["name", "kind", "steps", "sid"]) : [];
      if (k.name === "input") return [...own.filter(([n]) => n !== "type"), ["type", "input type", cat.inputTypes.join(" | ")], ...Object.entries(cat.inputSpec).map(([n, d]) => [n, "input spec", d] as [string, string, string])];
      return own;
    }
    case "function": {
      const f = cat.functions.find((x) => x.name === k.fn);
      const own = f ? Object.entries(f.params).map(([n, p]) => [n, paramDetail(p), `${k.fn} param`] as [string, string, string]) : [];
      if (k.via === "call") return own;
      const extra: [string, string, string][] = [["select", "query", "Which parts it applies to: layers[*].moe.experts"], ...opts.filter(([n]) => n !== "needs")];
      return [...own, ...extra.filter(([n]) => !own.some(([o]) => o === n))];
    }
    case "pipeline": {
      const mine = stageParams(cat, k.stage).map(([n, p]) => [n, `= ${py(p.default)}`, p.doc ?? ""] as [string, string, string]);
      const rest = Object.entries(cat.pipeline.params).filter(([, p]) => p.stage !== k.stage).map(([n, p]) => [n, `= ${py(p.default)} · ${p.stage}`, p.doc ?? ""] as [string, string, string]);
      return [...mine, ...opts.filter(([n]) => n !== "id"), ...rest];
    }
    case "op": {
      const o = cat.ops.find((x) => x.name === k.op);
      const own = o ? Object.entries(o.params).map(([n, p]) => [n, paramDetail(p), p.help ?? ""] as [string, string, string]) : [];
      return [...own, ...opts];
    }
  }
}

function given(f: Frame): Set<string> {
  return new Set([...f.args, f.cur].map((a) => a.kw).filter((x): x is string => !!x));
}

const BASE_FACTS = ["model", "id", "kinds", "experts", "top_k", "params_b", "layers", "vocab"];
const HW_FACTS = ["gpu_count", "gpu_mem_gb", "gpu_name", "ram_gb", "cpu_count"];
const STEP_ARTIFACTS = ["model", "metrics", "saliency", "scores", "data"];

function stringItems(text: string, s: NonNullable<Scan["str"]>, frames: Frame[], ff: FileFacts, cat: Catalog): Item[] | null {
  const f = frames[frames.length - 1];
  const prefix = s.prefix;
  const whole = prefix.length;
  const vals = (xs: { label: string; detail?: string; doc?: string; kind?: ItemKind }[], replace = whole): Item[] =>
    xs.map((x) => ({ label: x.label, kind: x.kind ?? "value", detail: x.detail, doc: x.doc, replace, rank: 0 }));
  if (!f) return null;
  const argIdx = f.args.length;
  const kw = f.cur.kw;
  const fnNames = () => vals(cat.functions.map((x) => ({ label: x.name, kind: "function" as const, detail: `${x.origin === "builtin" ? "built-in" : "my"} function · ${x.per}`, doc: fnDoc(x) })));

  // dict entries: {"architectures": [...]}, meta={"target": ...}, edit([{"fn": ...}])
  for (let k = frames.length - 1; k >= 0; k--) {
    const fr = frames[k];
    if (fr.open === "{" && fr.dictKey === "architectures") return vals(cat.architectures.map((a) => ({ label: a, detail: "architecture" })));
    if (fr.open === "(" ) break;
  }
  if (f.open === "{") {
    const outer = frames[frames.length - 2];
    if (outer?.open === "(" && outer.cur.kw === "targets" && f.keyPos) return vals([{ label: "architectures", detail: "targets key", kind: "field" }]);
    if (outer?.open === "(" && outer.cur.kw === "meta") {
      if (f.keyPos) return vals([["target", "device the result is for"], ["quant", "quant label, e.g. mlx-3bit"], ["preset", "preset it came from"]].map(([l, d]) => ({ label: l, detail: d, kind: "field" as const })));
      if (f.dictKey === "target") return vals(cat.devices.map((d) => ({ label: d.id, detail: d.label })));
    }
    // recipe.edit([{"fn": "reaq", "avg_bits": 3.5}])
    const list = frames[frames.length - 2];
    const call = frames[frames.length - 3];
    if (list?.open === "[" && call && callKind(call, ff)?.t === "method" && (callKind(call, ff) as { name: string }).name === "edit") {
      if (!f.keyPos && f.dictKey === "fn") return fnNames();
      if (f.keyPos) {
        const fnArg = /["']fn["']\s*:\s*["']([^"']+)["']/.exec(text.slice(text.lastIndexOf("{", s.start)));
        const fn = cat.functions.find((x) => x.name === fnArg?.[1]);
        const keys = fn ? Object.entries(fn.params).map(([k2, p]) => ({ label: k2, detail: paramDetail(p), kind: "field" as const })) : [];
        return vals([{ label: "fn", detail: "function name", kind: "field" as const }, ...keys]);
      }
    }
  }
  if (f.open !== "(") return null;
  if (kw === "select") return queryItems(prefix, cat);
  const ck = callKind(f, ff);
  const callee = f.callee ?? "";
  const meth = callee.split(".").pop() ?? "";
  const onRecipe = ff.recipeVars.has(callee.split(".").slice(0, -1).join("."));
  if (onRecipe && meth === "fn" && argIdx === 0 && !kw) return fnNames();
  if (meth === "call" && argIdx === 0 && !kw) return fnNames();
  if (onRecipe && meth === "step" && argIdx === 0 && !kw) {
    return vals([
      ...cat.pipeline.steps.map((x) => ({ label: `pipeline.${x.name}`, kind: "module" as const, detail: "pipeline stage", doc: stageDoc(cat, x.name) })),
      ...cat.ops.map((o) => ({ label: o.name, kind: "class" as const, detail: `catalog op @${o.major}`, doc: opDoc(o) })),
    ]);
  }
  if (onRecipe && meth === "input" && ((argIdx === 1 && !kw) || kw === "type")) return vals(cat.inputTypes.map((t) => ({ label: t, detail: "input type", kind: "enum" as const })));
  if (ck?.t === "gate") {
    if ((argIdx === 0 && !kw) || kw === "metric") return vals(cat.gateMetrics.map((m) => ({ label: m, detail: "metric" })));
    if ((argIdx === 1 && !kw) || kw === "op") return vals(cat.gateOps.map((o) => ({ label: o, detail: "comparison", kind: "enum" as const })));
    if (kw === "on_fail") return vals([{ label: "stop", detail: "stop the run" }, { label: "warn", detail: "keep going, warn" }]);
  }
  if (kw === "base" || kw === "model" || kw === "teacher") return vals(cat.models.map((m) => ({ label: m.id, detail: m.detail, kind: "module" as const })));
  if (kw === "target" || kw === "device") return vals(cat.devices.map((d) => ({ label: d.id, detail: d.label })));
  if (ck?.t === "pipeline" && (kw === "calib" || kw === "heal_calib")) return vals(["code", "contest", "chat", "math", "general"].map((l) => ({ label: l, detail: "calibration set" })));
  return null;
}

/** Completions inside a part query: layers[*].moe.experts[rank<0.25]. */
export function queryItems(prefix: string, cat: Catalog): Item[] {
  const q = cat.query;
  const open = prefix.lastIndexOf("[");
  const close = prefix.lastIndexOf("]");
  const mk = (xs: [string, string][], replace: number, kind: ItemKind = "property"): Item[] =>
    xs.map(([label, detail]) => ({ label, detail, kind, replace, rank: 0 }));
  if (open > close) {
    const inner = prefix.slice(open + 1);
    const piece = /[A-Za-z_]*$/.exec(inner)![0];
    const cond = /(?:^|[&,])\s*([A-Za-z_]+)\s*(==|!=)\s*([A-Za-z_]*)$/.exec(inner);
    if (cond && cond[1] === "kind") return mk(q.kinds.map((k) => [k, "kind"]), cond[3].length, "enum");
    if (/(<=|>=|==|!=|<|>|=)\s*[^&]*$/.test(inner)) return [];
    return [...mk(Object.entries(q.filters), piece.length), ...(piece ? [] : mk([["*", "every one"], ["0:4", "a slice"], ["-1", "the last"]], 0, "value"))];
  }
  const segs = prefix.split(".");
  const cur = segs[segs.length - 1];
  if (segs.length === 1) {
    return [
      ...mk(q.top.map((t) => [t, "part"]), cur.length),
      ...(cur ? [] : Object.entries(q.examples).map(([ex, d]) => ({ label: ex, detail: d, kind: "snippet" as const, replace: 0, rank: 1 }))),
    ];
  }
  const parent = segs[segs.length - 2].replace(/\[.*$/, "");
  const kids = q.children[parent] ?? (parent === "experts" ? [] : Object.values(q.children).flat());
  return mk(kids.map((k) => [k, `child of ${parent}`]), cur.length);
}

function snippetFor(recv: string, k: "fn" | "step", name: string, cat: Catalog): string {
  let n = 1;
  const stop = (v: unknown) => `\${${n++}:${py(v).replace(/[$}\\]/g, "\\$&")}}`;
  if (k === "fn") {
    const f = cat.functions.find((x) => x.name === name)!;
    const ps = Object.entries(f.params).filter(([p, i]) => p !== "select" && (i.required || i.default !== undefined));
    const sel = f.per === "tensor" || f.per === "part" ? [`select="\${${n++}:layers[*].moe.experts}"`] : [];
    const args = [...sel, ...ps.slice(0, 6).map(([p, i]) => `${p}=${i.required && i.default == null ? `\${${n++}}` : stop(i.default)}`)];
    return `${recv}fn("${name}"${args.length ? ", " + args.join(", ") : ""})$0`;
  }
  const ps = stageParams(cat, name).slice(0, 3);
  return `${recv}step("pipeline.${name}"${ps.map(([p, i]) => `, ${p}=${stop(i.default)}`).join("")})$0`;
}

export const NEW_RECIPE = [
  "from blackhole_dev.recipe import Recipe, gate",
  "",
  "recipe = Recipe(",
  '    "${1:you}/${2:my-recipe}",',
  '    "0.1.0",',
  '    title="${3:My recipe}",',
  '    base="${4:Qwen/Qwen3.6-35B-A3B}",',
  '    targets={"architectures": ["moe", "hybrid"]},',
  '    meta={"target": "${5:mac16}"},',
  ")",
  "",
  'prune = recipe.input("prune", "float", default=${6:0.25}, min=0.0, max=0.5, help="share of routed experts dropped")',
  "",
  'recipe.fn("calibrate", calib="code")',
  'recipe.fn("reap-gpu", ratio=prune)',
  "$0",
].join("\n");

function snippets(recv: string, atLineStart: boolean, cat: Catalog, replace: number): Item[] {
  const out: Item[] = [];
  const pre = atLineStart ? `${recv}.` : "";
  if (atLineStart) {
    out.push({ label: "new recipe", kind: "snippet", detail: "a whole recipe file", insert: NEW_RECIPE, snippet: true, replace, rank: 2, filter: "recipe new" });
    out.push({ label: `${recv}.input(…)`, kind: "snippet", detail: "a knob users set", insert: `\${1:name} = ${recv}.input("\${1:name}", "\${2:float}", default=\${3:0.25}, help="\${4}")$0`, snippet: true, replace, rank: 2, filter: `${recv}.input` });
    out.push({ label: `${recv}.eval(…)`, kind: "snippet", detail: "final gates", insert: `${recv}.eval(suites=["\${1:kl}"], gates=[gate("\${2:kl}", "\${3:<=}", \${4:0.1})])$0`, snippet: true, replace, rank: 2, filter: `${recv}.eval` });
  }
  for (const f of cat.functions)
    out.push({ label: `${pre}fn("${f.name}", …)`, kind: "snippet", detail: `${f.per} function`, doc: fnDoc(f), insert: snippetFor(pre, "fn", f.name, cat), snippet: true, replace, rank: 2, filter: `${pre}fn ${f.name}` });
  for (const s of cat.pipeline.steps)
    out.push({ label: `${pre}step("pipeline.${s.name}", …)`, kind: "snippet", detail: "pipeline stage", doc: stageDoc(cat, s.name), insert: snippetFor(pre, "step", s.name, cat), snippet: true, replace, rank: 2, filter: `${pre}step pipeline.${s.name}` });
  return out;
}

/** The dotted name right before the cursor's word: "recipe.inputs" in `recipe.inputs.pr`. */
export function receiverAt(before: string): { prefix: string; receiver: string | null } {
  const m = /([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*([A-Za-z_]\w*)?$/.exec(before);
  const w = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
  if (!m || (m[2] ?? "") !== w) return { prefix: w, receiver: null };
  const before2 = before.slice(0, before.length - m[0].length);
  if (/[\w)\]"']$/.test(before2) && !/\s$/.test(before2)) return { prefix: w, receiver: null };
  return { prefix: w, receiver: m[1].replace(/\s+/g, "") };
}

/** Recipe-aware completions at `offset` in `text`. */
export function complete(text: string, offset: number, cat: Catalog | null): Answer {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const full = scan(before);
  if (full.comment) return { items: [], generic: false, prefix: "" };
  const ff = facts(text);
  if (full.str) {
    if (!cat || full.str.quote.length === 3) return { items: [], generic: false, prefix: "" };
    const items = stringItems(text, full.str, full.frames, ff, cat);
    return { items: items ?? [], generic: false, prefix: full.str.prefix };
  }
  const { prefix, receiver } = receiverAt(line);
  if (!cat) return { items: [], generic: true, prefix };
  const items: Item[] = [];
  const rep = prefix.length;
  if (receiver) {
    const head = receiver.split(".");
    const root = head[0];
    if (ff.recipeVars.has(root) && head.length === 1) {
      for (const [m, s] of Object.entries(cat.recipe.methods)) items.push({ label: m, kind: "method", detail: `Recipe.${m}`, doc: sigDoc(m, s), replace: rep, rank: 0 });
      for (const [a, d] of Object.entries(cat.recipe.attrs)) items.push({ label: a, kind: "property", detail: "Recipe", doc: d, replace: rep, rank: 0 });
      items.push(...snippets("", false, cat, rep).map((x) => ({ ...x, label: x.label, rank: 1 })));
    } else if (ff.recipeVars.has(root) && head[1] === "inputs" && head.length === 2) {
      items.push(...ff.inputs.map((x) => ({ label: x, kind: "variable" as const, detail: "recipe input", replace: rep, rank: 0 })));
    } else if (ff.recipeVars.has(root) && head[1] === "base" && head.length === 2) {
      items.push(...BASE_FACTS.map((x) => ({ label: x, kind: "property" as const, detail: "base model fact", replace: rep, rank: 0 })));
    } else if (ff.recipeVars.has(root) && head[1] === "hw" && head.length === 2) {
      items.push(...HW_FACTS.map((x) => ({ label: x, kind: "property" as const, detail: "hardware", replace: rep, rank: 0 })));
    } else if (ff.steps.has(root) && head.length === 1) {
      items.push(...STEP_ARTIFACTS.map((x) => ({ label: x, kind: "property" as const, detail: `artifact of ${ff.steps.get(root)}`, replace: rep, rank: 0 })));
    }
    return { items, generic: true, prefix };
  }
  // keyword arguments at the start of an argument
  const at = scan(before.slice(0, before.length - prefix.length));
  const f = at.frames[at.frames.length - 1];
  if (f && f.open === "(" && !f.cur.kw && f.cur.tokens === 0) {
    const ck = callKind(f, ff);
    if (ck) {
      const have = given(f);
      for (const [name, detail, doc] of kwargsOf(ck, cat)) {
        if (have.has(name)) continue;
        if (ck.t === "method" || ck.t === "ctor" || ck.t === "gate") {
          const sig = ck.t === "ctor" ? cat.recipe.ctor : ck.t === "gate" ? cat.gate : cat.recipe.methods[ck.name];
          const pi = sig?.params.findIndex((p) => p.name === name) ?? -1;
          if (pi >= 0 && pi < f.args.length && !sig.params[pi].kwOnly) continue; // filled positionally
        }
        items.push({ label: `${name}=`, kind: "field", detail, doc, insert: `${name}=`, replace: rep, rank: 0, filter: name });
      }
    }
  }
  const atLineStart = !at.frames.length && /^\s*[A-Za-z_]*$/.test(line);
  const recv = [...ff.recipeVars].find((v) => v !== "recipe" && text.includes(`${v} = `)) ?? "recipe";
  if (atLineStart && prefix && (recv.startsWith(prefix) || "new".startsWith(prefix))) items.push(...snippets(recv, true, cat, rep));
  if (prefix && "gate".startsWith(prefix)) items.push({ label: "gate", kind: "function", detail: "blackhole_dev.recipe", doc: sigDoc("gate", cat.gate), replace: rep, rank: 1 });
  return { items, generic: true, prefix };
}

// ------------------------------------------------------------------ signature help

export interface SigHelp {
  label: string;
  doc: string;
  params: { label: string; doc?: string }[];
  active: number;
}

function activeIn(names: string[], f: Frame, positional = 0): number {
  if (f.cur.kw) return Math.max(-1, names.indexOf(f.cur.kw));
  const anyKw = f.args.some((a) => a.kw);
  if (anyKw) return -1;
  return f.args.length + positional < names.length ? f.args.length + positional : -1;
}

/** Signature of the innermost known call around the cursor; null lets Jedi answer. */
export function signature(text: string, offset: number, cat: Catalog | null): SigHelp | null {
  if (!cat) return null;
  const s = scan(text.slice(0, offset));
  if (s.comment) return null;
  const ff = facts(text);
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i];
    if (f.open !== "(") continue;
    const ck = callKind(f, ff);
    if (!ck) return null;
    const fromSig = (name: string, sig: Sig): SigHelp => {
      const ps = sig.params;
      return { label: `${name}(${ps.map((p) => p.label).join(", ")})`, doc: sig.doc, params: ps.map((p) => ({ label: p.label })), active: activeIn(ps.map((p) => p.name.replace(/^\*\*/, "")), f) };
    };
    switch (ck.t) {
      case "ctor": return fromSig("Recipe", cat.recipe.ctor);
      case "gate": return fromSig("gate", cat.gate);
      case "method": return cat.recipe.methods[ck.name] ? fromSig(`${f.callee}`, cat.recipe.methods[ck.name]) : null;
      case "function": {
        const fn = cat.functions.find((x) => x.name === ck.fn);
        if (!fn) return null;
        const ps = Object.entries(fn.params).map(([k, p]) => ({ name: k, label: `${k}${p.type ? ": " + p.type : ""}${p.default !== undefined && p.default !== null ? " = " + py(p.default) : ""}` }));
        const head = `"${fn.name}"`;
        return { label: `${f.callee}(${[head, ...ps.map((p) => p.label)].join(", ")})`, doc: `${fn.doc}`, params: [{ label: head }, ...ps.map((p) => ({ label: p.label }))], active: f.cur.kw ? 1 + ps.findIndex((p) => p.name === f.cur.kw) : f.args.length === 0 ? 0 : -1 };
      }
      case "pipeline": {
        const ps = stageParams(cat, ck.stage).map(([k, p]) => ({ name: k, label: `${k} = ${py(p.default)}`, doc: p.doc }));
        const head = `"pipeline.${ck.stage}"`;
        const doc = cat.pipeline.steps.find((x) => x.name === ck.stage)?.doc ?? "";
        const act = f.cur.kw ? ps.findIndex((p) => p.name === f.cur.kw) : -1;
        return { label: `${f.callee}(${[head, ...ps.map((p) => p.label)].join(", ")})`, doc, params: [{ label: head }, ...ps.map((p) => ({ label: p.label, doc: p.doc }))], active: f.args.length === 0 && !f.cur.kw ? 0 : act >= 0 ? act + 1 : -1 };
      }
      case "op": {
        const o = cat.ops.find((x) => x.name === ck.op);
        if (!o) return null;
        const ps = Object.entries(o.params).map(([k, p]) => ({ name: k, label: `${k} = ${py(p.default)}`, doc: p.help }));
        const head = `"${o.name}"`;
        const act = f.cur.kw ? ps.findIndex((p) => p.name === f.cur.kw) : -1;
        return { label: `${f.callee}(${[head, ...ps.map((p) => p.label)].join(", ")})`, doc: o.doc.split("\n\n")[0], params: [{ label: head }, ...ps.map((p) => ({ label: p.label, doc: p.doc }))], active: f.args.length === 0 && !f.cur.kw ? 0 : act >= 0 ? act + 1 : -1 };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ hover

/** Markdown for the recipe name under the cursor; null lets Jedi answer. */
export function hover(text: string, offset: number, cat: Catalog | null): { md: string; start: number; end: number } | null {
  if (!cat) return null;
  // the token under the cursor: a string literal or an identifier
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset) < 0 ? text.length : text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd);
  const col = offset - lineStart;
  for (const m of line.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)) {
    const a = m.index!, b = a + m[0].length;
    if (col < a || col > b) continue;
    const v = m[2];
    const fn = cat.functions.find((x) => x.name === v);
    if (fn) return { md: fnDoc(fn), start: lineStart + a, end: lineStart + b };
    if (v.startsWith("pipeline.") && cat.pipeline.steps.some((x) => `pipeline.${x.name}` === v)) return { md: stageDoc(cat, v.slice(9)), start: lineStart + a, end: lineStart + b };
    const op = cat.ops.find((x) => x.name === v.split("@")[0]);
    if (op) return { md: opDoc(op), start: lineStart + a, end: lineStart + b };
    return null;
  }
  let a = col, b = col;
  while (a > 0 && ID.test(line[a - 1])) a--;
  while (b < line.length && ID.test(line[b])) b++;
  const w = line.slice(a, b);
  if (!w) return null;
  const span = { start: lineStart + a, end: lineStart + b };
  if (/^\s*=(?!=)/.test(line.slice(b))) {
    // a keyword argument: explain it in its call
    const s = scan(text.slice(0, lineStart + a));
    const f = s.frames[s.frames.length - 1];
    const ck = f ? callKind(f, facts(text)) : null;
    if (ck) {
      const hit = kwargsOf(ck, cat).find(([n]) => n === w);
      if (hit) {
        const p = ck.t === "pipeline" ? cat.pipeline.params[w] : undefined;
        const where = ck.t === "pipeline" ? `pipeline.${ck.stage}` : ck.t === "function" ? ck.fn : ck.t === "op" ? ck.op : ck.t === "ctor" ? "Recipe" : ck.t === "gate" ? "gate" : `Recipe.${ck.name}`;
        const tail = p && p.stage && ck.t === "pipeline" && p.stage !== ck.stage ? `\n\nThis param belongs to the **${p.stage}** stage.` : "";
        return { md: `\`${w}\` · ${where}\n\n${hit[1]}${hit[2] ? "\n\n" + hit[2] : ""}${tail}`, ...span };
      }
    }
    return null;
  }
  const before = line.slice(0, a);
  if (/\.\s*$/.test(before) && cat.recipe.methods[w]) return { md: sigDoc(`Recipe.${w}`, cat.recipe.methods[w]), ...span };
  if (w === "Recipe") return { md: sigDoc("Recipe", cat.recipe.ctor), ...span };
  if (w === "gate") return { md: sigDoc("gate", cat.gate), ...span };
  return null;
}

// ------------------------------------------------------------------ diagnostics

/** Columns a lint message points at on its line: the param, function or stage it names. */
export function narrow(line: string, message: string): { start: number; end: number } | null {
  const names = [...message.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  for (const n of names) {
    const kw = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=(?!=)`).exec(line);
    if (kw) return { start: kw.index + 1, end: kw.index + n.length + 1 };
    for (const q of ['"', "'"]) {
      const i = line.indexOf(q + n + q);
      if (i >= 0) return { start: i + 1, end: i + n.length + 3 };
    }
  }
  const op = /^(pipeline\.\w+|[a-z]+\.[a-z_]+(?:@\d+)?)[: ]/.exec(message);
  if (op) {
    const i = line.indexOf(op[1]);
    if (i >= 0) return { start: i + 1, end: i + op[1].length + 1 };
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Replacements a lint message suggests for the name it complains about (best first). */
export function fixesFor(message: string, cat: Catalog | null, bad: string): string[] {
  let pool: string[] = [];
  const mean = /did you mean ([^?)]+)\?/.exec(message);
  if (mean) pool = mean[1].split(/,\s*/);
  const has = /\(has \[([^\]]*)\]\)/.exec(message);
  if (has) pool = [...has[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!pool.length && cat && /unknown (?:function|op)|not a pipeline stage/.test(message))
    pool = [...cat.functions.map((f) => f.name), ...cat.pipeline.steps.map((s) => `pipeline.${s.name}`), ...cat.ops.map((o) => o.name)];
  if (!pool.length && cat && /unknown param/.test(message)) pool = Object.keys(cat.pipeline.params);
  return pool
    .filter((x) => x && x !== bad)
    .map((x) => [x, editDistance(bad, x) - (x.startsWith(bad.slice(0, 3)) ? 1 : 0)] as const)
    .filter(([x, d]) => d <= Math.max(3, Math.floor(x.length / 2)))
    .sort((p, q) => p[1] - q[1])
    .slice(0, 3)
    .map(([x]) => x);
}
