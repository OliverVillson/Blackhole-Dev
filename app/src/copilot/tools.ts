// Copilot tools. Cheap ones run on their own (read, lint, plan, anatomy, edit files).
// Expensive ones (VM up/down, run launch, big downloads) only *request* the action:
// the owning module's main handler opens the human confirmation gate (I4) itself,
// so nothing the model says can approve it.
import { z } from "zod";
import type { LlmTool } from "../llm/types";

export type ToolSide = "helper" | "editor" | "module" | "gated";

interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  side: ToolSide;
  description: string;
  schema: S;
  /** JSON Schema sent to the model (kept by hand so descriptions read well). */
  json: LlmTool["input_schema"];
}

const str = (description: string) => ({ type: "string", description });

function spec<S extends z.ZodTypeAny>(s: ToolSpec<S>): ToolSpec<S> {
  return s;
}

export const TOOLS = [
  spec({
    name: "read_file",
    side: "editor",
    description: "Read a recipe or function file from the workspace. Lines are numbered.",
    schema: z.object({ path: z.string().min(1) }),
    json: { type: "object", properties: { path: str("Workspace-relative path, e.g. recipes/qwen-mac.py") }, required: ["path"] },
  }),
  spec({
    name: "list_files",
    side: "editor",
    description: "List the recipe files in the user's workspace (recipes folder). Use it before reading or creating a recipe so names do not clash.",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "write_file",
    side: "editor",
    description:
      "Write a whole file (a new recipe, a full rewrite, or the rest of a file you were writing when interrupted). The content is typed into the user's editor as pending changes they accept or reject. Use it whenever you are not streaming a path= fence in your reply, and never say a file is written unless this tool or edit_file succeeded.",
    schema: z.object({
      path: z.string().min(1),
      content: z.string(),
      mode: z.enum(["new", "rewrite", "append"]).optional(),
    }),
    json: {
      type: "object",
      properties: {
        path: str("Workspace-relative path, e.g. recipes/int4.py"),
        content: str("The complete file text (for mode=append, only the lines to add)"),
        mode: { type: "string", enum: ["new", "rewrite", "append"], description: "new (default): a file that does not exist yet; rewrite: replace the whole file; append: continue after the last line you wrote" },
      },
      required: ["path", "content"],
    },
  }),
  spec({
    name: "edit_file",
    side: "editor",
    description:
      "Make targeted edits to an existing file. Each edit replaces one exact, unique occurrence of `find`. Lines the user typed are locked: an edit touching them is refused. Use a fenced block instead to write a new file or a whole rewrite.",
    schema: z.object({
      path: z.string().min(1),
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).min(1),
    }),
    json: {
      type: "object",
      properties: {
        path: str("Workspace-relative path"),
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { find: str("Exact text to replace, unique in the file"), replace: str("Replacement text") },
            required: ["find", "replace"],
          },
        },
      },
      required: ["path", "edits"],
    },
  }),
  spec({
    name: "lint_recipe",
    side: "helper",
    description: "Lint a recipe (syntax, unknown steps/functions, bad params, blackhole lint rules). Checks the live editor buffer.",
    schema: z.object({ path: z.string().min(1) }),
    json: { type: "object", properties: { path: str("Recipe path") }, required: ["path"] },
  }),
  spec({
    name: "plan_recipe",
    side: "helper",
    description: "Dry-run plan: output size, whether it fits the device, KV cache, estimated run hours. No GPU, no cost.",
    schema: z.object({ path: z.string().min(1), device: z.string().min(1), model: z.string().optional() }),
    json: {
      type: "object",
      properties: {
        path: str("Recipe path"),
        device: str("Device id from list_devices, e.g. mac16 or b300"),
        model: str("Optional base model override"),
      },
      required: ["path", "device"],
    },
  }),
  spec({
    name: "list_devices",
    side: "helper",
    description: "List target devices the planner knows (id, label, memory).",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "open_model",
    side: "helper",
    description: "Open a model's anatomy (headers only, no weights downloaded): a local folder or a Hub id.",
    schema: z.object({ model: z.string().min(1) }),
    json: { type: "object", properties: { model: str("Local path or Hub id, e.g. Qwen/Qwen3-30B-A3B") }, required: ["model"] },
  }),
  spec({
    name: "model_summary",
    side: "helper",
    description: "Summary of the open model: kind, layers, experts per layer, top-k, part tree.",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "model_query",
    side: "helper",
    description: 'Look up parts of the open model with an anatomy query, e.g. "layers[3].moe.experts[rank<0.25]".',
    schema: z.object({ query: z.string().min(1) }),
    json: { type: "object", properties: { query: str("Anatomy query") }, required: ["query"] },
  }),
  spec({
    name: "list_functions",
    side: "helper",
    description: "List named functions recipes can call (built-in, user, and user overrides of built-ins).",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "function_source",
    side: "helper",
    description: "Read the Python source of a named function, built-in or user.",
    schema: z.object({ name: z.string().min(1) }),
    json: { type: "object", properties: { name: str("Function name, e.g. reap-prune") }, required: ["name"] },
  }),
  spec({
    name: "list_machines",
    side: "module",
    description: "List the SSH hosts and cloud VMs the user has set up (read-only, free).",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "job_status",
    side: "module",
    description: "State of runs on a machine: pass hostId alone to list jobs, or hostId and name for one job's stages and progress (read-only, free).",
    schema: z.object({ hostId: z.string().min(1), name: z.string().optional() }),
    json: { type: "object", properties: { hostId: str("Host id from list_machines"), name: str("Job name") }, required: ["hostId"] },
  }),
  spec({
    name: "list_analyses",
    side: "module",
    description: "List the analyses (plots and stats over a model: overview, layer-stats, expert-stats, reap-scores, weight-histogram, quant-error, job-results, compare, and the user's own) with what each reads.",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "list_models",
    side: "module",
    description: "List the models in the user's models folder (downloaded, finished runs copied back, forks) with their lineage.",
    schema: z.object({}),
    json: { type: "object", properties: {} },
  }),
  spec({
    name: "run_analysis",
    side: "module",
    description:
      "Run a named analysis on a model and get its report (stats, tables, chart data). Analyses that read only headers are free; one that reads more weights than the user's limit opens a confirmation dialog the user decides.",
    schema: z.object({ name: z.string().min(1), model: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }),
    json: {
      type: "object",
      properties: {
        name: str("Analysis name from list_analyses, e.g. expert-stats"),
        model: str("Model folder or Hub id; omit to use the model open_model opened"),
        params: { type: "object", description: "The analysis's parameters, e.g. {\"layer\": 3}" },
      },
      required: ["name"],
    },
  }),
  spec({
    name: "request_action",
    side: "gated",
    description:
      "Ask the user to approve an expensive action: start or stop a cloud VM, launch a run, or download a large model. The user sees a confirmation dialog and decides; you cannot approve it. Only call it when the user asked for the action.",
    schema: z.object({
      action: z.enum(["vm.up", "vm.down", "run.launch", "download"]),
      why: z.string().min(1),
      recipe: z.string().optional(),
      host: z.string().optional(),
      preset: z.string().optional(),
      model: z.string().optional(),
    }),
    json: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["vm.up", "vm.down", "run.launch", "download"] },
        why: str("One sentence the user reads in the dialog"),
        recipe: str("Recipe path (run.launch)"),
        host: str("SSH host or VM id (run.launch, vm.down)"),
        preset: str("VM preset (vm.up)"),
        model: str("Model id (download)"),
      },
      required: ["action", "why"],
    },
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export const TOOL_BY_NAME = new Map<string, (typeof TOOLS)[number]>(TOOLS.map((t) => [t.name, t]));

export function llmTools(): LlmTool[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.json }));
}

/** Validate a tool call's input. Returns an error message for the model on failure. */
export function validateToolInput(name: string, input: unknown): { ok: true; value: any } | { ok: false; error: string } {
  const t = TOOL_BY_NAME.get(name);
  if (!t) return { ok: false, error: `Unknown tool ${name}` };
  if (input && typeof input === "object" && "__invalid_json" in (input as object)) {
    return { ok: false, error: JSON.stringify({ INVALID_JSON: (input as { __invalid_json: string }).__invalid_json }) };
  }
  const r = t.schema.safeParse(input ?? {});
  if (!r.success) return { ok: false, error: `Invalid input for ${name}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ok: true, value: r.data };
}

/** Helper (I1) methods each helper-side tool maps to. Main only forwards these. */
export const HELPER_METHODS: Record<string, string> = {
  lint_recipe: "recipe.lint",
  plan_recipe: "recipe.plan",
  list_devices: "recipe.devices",
  open_model: "anatomy.open",
  model_summary: "anatomy.summary",
  model_query: "anatomy.get",
  list_functions: "functions.list",
  function_source: "functions.source",
};

/** Main-process channels of the owning modules (WS5 vm:, WS6 chat:). Each handler calls the I4 gate itself
 *  and returns {approved: false} when the user declines. vm:copilot.down only stops a VM (disk kept). */
export const GATED_CHANNELS: Record<string, string> = {
  "vm.up": "vm:copilot.up",
  "vm.down": "vm:copilot.down",
  "run.launch": "vm:copilot.launch",
  download: "chat:download",
};

/** Read-only module channels the copilot may call freely. */
export const MODULE_CHANNELS: Record<string, string> = {
  list_machines: "vm:hosts.list",
  job_status: "vm:job.state",
  list_analyses: "analysis:list",
  list_models: "analysis:models",
  run_analysis: "analysis:run",
};

/** Apply find/replace edits to text, refusing any that touch locked lines. Lines are 1-based. */
export function planEdits(
  text: string,
  edits: { find: string; replace: string }[],
  locked: (line: number) => boolean,
): { ok: true; edits: { startLine: number; startCol: number; endLine: number; endCol: number; text: string }[] } | { ok: false; error: string } {
  const out: { startLine: number; startCol: number; endLine: number; endCol: number; text: string }[] = [];
  const pos = (off: number) => {
    const before = text.slice(0, off);
    const line = before.split("\n").length;
    const col = off - (before.lastIndexOf("\n") + 1) + 1;
    return { line, col };
  };
  const taken: [number, number][] = [];
  for (const e of edits) {
    const i = text.indexOf(e.find);
    if (i < 0) return { ok: false, error: `Not found: ${JSON.stringify(e.find.slice(0, 80))}` };
    if (text.indexOf(e.find, i + 1) >= 0) return { ok: false, error: `Not unique, add more context: ${JSON.stringify(e.find.slice(0, 80))}` };
    const j = i + e.find.length;
    if (taken.some(([a, b]) => i < b && j > a)) return { ok: false, error: "Edits overlap." };
    taken.push([i, j]);
    const s = pos(i);
    const en = pos(j);
    for (let l = s.line; l <= en.line; l++) {
      if (locked(l)) return { ok: false, error: `Line ${l} was written by the user and is locked. Edit around it.` };
    }
    out.push({ startLine: s.line, startCol: s.col, endLine: en.line, endCol: en.col, text: e.replace });
  }
  return { ok: true, edits: out };
}

export function numbered(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
    .join("\n");
}
