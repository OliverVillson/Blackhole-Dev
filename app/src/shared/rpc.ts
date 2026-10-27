// I1 helper RPC: shapes shared by the main-process client and the renderer.
// Contract: /mnt/project-files/blackhole-dev-app/interfaces/ws1-shell.md (I1) and ws2-recipe.md.

export type Severity = "error" | "warning" | "info";

export interface Problem {
  severity: Severity;
  message: string;
  file: string;
  line: number;
  col?: number;
  endLine?: number;
  endCol?: number;
  code?: string;
}

export interface InitializeParams {
  workspace: string;
  recipesDir: string;
  functionsDir: string;
  modelsDir: string;
  client: "blackhole-dev-app";
  version: string;
}

export interface InitializeResult {
  version: string;
  python: string;
  methods: string[];
}

export interface StepInfo {
  name: string;
  fn: string;
  kind?: "pipeline" | "op" | "function" | "job";
  detail: string;
  line?: number;
  user?: boolean;
}

export interface PlanRow {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
}

export interface PlanResult {
  rows: PlanRow[];
  sizeGb: number | null;
  fits: boolean | null;
  kvGb?: number | null;
  estHours?: number | null;
  problems: Problem[];
  steps: StepInfo[];
}

export interface StepsResult {
  base: string;
  target: string;
  doc: string;
  steps: StepInfo[];
}

export interface Device {
  id: string;
  label: string;
  memGb: number;
}

export interface AnatomyNode {
  path: string;
  label: string;
  kind: string;
  children?: AnatomyNode[];
  lazy?: boolean;
}

export interface AnatomySummary {
  name: string;
  kind: "moe" | "dense";
  layers: number;
  expertsPerLayer?: number;
  topK?: number;
  layerScores?: number[];
  tree: AnatomyNode[];
}

export interface AnatomyPart {
  path: string;
  kind: string;
  rows: [string, string][];
  insert: string;
}

export interface FunctionInfo {
  name: string;
  per: string;
  origin: "builtin" | "user" | "override";
  path: string;
  doc: string;
  usedBy?: string[];
}

/** Every method the renderer may call through helper:call. Keep in sync with blackhole_dev.rpc. */
/** A preset recipe file shipped with blackhole_dev (recipes/*.py, recipes/examples/*.py). */
export interface PresetFile { id: string; file: string; group: string; title: string; description: string; base?: string | null }

export interface HelperMethods {
  "recipe.lint": [{ path: string; text?: string }, { problems: Problem[] }];
  "recipe.plan": [{ path: string; text?: string; device: string; model?: string; inputs?: Record<string, unknown> }, PlanResult];
  "recipe.steps": [{ path: string; text?: string }, StepsResult];
  "recipe.devices": [Record<string, never>, { devices: Device[] }];
  "recipe.bundle": [{ path: string; out?: string; inputs?: Record<string, unknown>; model?: string; target?: string }, { bundle: string; sha256: string; functions: unknown[]; manifest: unknown }];
  "recipe.fromToml": [{ path: string; out?: string }, { path: string; text: string }];
  "recipe.fromPreset": [{ id: string; out?: string }, { path: string; text: string }];
  "recipe.presets": [Record<string, never>, { presets: { id: string; name: string; summary: string; pipeline: boolean; tags: string[] }[] }];
  "recipe.presetFiles": [Record<string, never>, { presets: PresetFile[] }];
  "recipe.copyPreset": [{ file: string }, { path: string; text: string }];
  "recipe.compile": [{ path: string; text?: string }, { raw: unknown; meta: unknown; problems: Problem[] }];
  "anatomy.open": [{ model: string }, { id: string; name: string; layers: number; kind: "moe" | "dense"; summary: string }];
  "anatomy.summary": [Record<string, never>, AnatomySummary];
  "anatomy.get": [{ query: string }, AnatomyPart];
  "functions.list": [Record<string, never>, FunctionInfo[]];
  "functions.source": [{ name: string }, { path: string; text: string; readonly: boolean }];
  "functions.fork": [{ name: string }, { path: string }];
}

export type HelperMethod = keyof HelperMethods;
export type HelperParams<M extends HelperMethod> = HelperMethods[M][0];
export type HelperResult<M extends HelperMethod> = HelperMethods[M][1];

export const HELPER_METHODS = [
  "recipe.lint", "recipe.plan", "recipe.steps", "recipe.devices", "recipe.bundle", "recipe.fromToml",
  "recipe.fromPreset", "recipe.presets", "recipe.presetFiles", "recipe.copyPreset", "recipe.compile", "anatomy.open", "anatomy.summary", "anatomy.get",
  "functions.list", "functions.source", "functions.fork",
] as const satisfies readonly HelperMethod[];

export const RPC_ERRORS = { recipe: -32001, modelNotFound: -32002, cancelled: -32003 } as const;

export interface HelperStatus {
  state: "starting" | "ready" | "down" | "missing";
  version?: string;
  python?: string;
  error?: string;
}
