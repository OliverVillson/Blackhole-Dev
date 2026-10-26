// Analysis module: types shared by main and renderer, the channel names, and number formatting.
// Report blocks are what blackhole_dev.analysis.Report produces (Python side is the source of truth).

export interface ParamSpec { type: string; default: unknown; required: boolean }

export interface AnalysisInfo {
  name: string;
  title: string;
  doc: string;
  needs: "headers" | "weights" | "none";
  params: Record<string, ParamSpec>;
  origin: "builtin" | "user" | "override";
  path: string;
  group: string;
}

export interface ModelBrief { id: string; path: string | null; name: string; layers: number; kind: "moe" | "dense" }

export interface ModelRow {
  path: string;
  name: string;
  parent: string | null;
  forkedAt: string | null;
  mode: string | null;
  edits: number;
  base: string | null;
  sizeBytes: number;
  parentChanged?: boolean | null;
}

export interface Series { name: string; values: (number | null)[] }
export interface Tile { label: string; value: unknown; note?: string; tone?: "ok" | "warn" | "bad" }

export type Block =
  | { kind: "text"; text: string }
  | { kind: "tiles"; title?: string; items: Tile[] }
  | { kind: "line"; title: string; x: (number | string)[]; series: Series[]; xlabel?: string; ylabel?: string; logy?: boolean; note?: string }
  | { kind: "bar"; title: string; labels: string[]; series: Series[]; xlabel?: string; ylabel?: string; horizontal?: boolean; note?: string }
  | { kind: "hist"; title: string; edges: number[]; counts: number[]; xlabel?: string; logy?: boolean; note?: string }
  | { kind: "heatmap"; title: string; rows: string[]; cols: string[]; values: (number | null)[][]; label?: string; xlabel?: string; ylabel?: string; note?: string }
  | { kind: "scatter"; title: string; series: { name: string; x: number[]; y: number[]; labels?: string[] }[]; xlabel?: string; ylabel?: string; note?: string }
  | { kind: "table"; title?: string; columns: string[]; rows: unknown[][] }
  | { kind: "image"; title?: string; png: string };

export interface Report {
  title: string;
  name: string;
  blocks: Block[];
  metrics: Record<string, unknown>;
  params: Record<string, unknown>;
  reads: number;
  seconds: number;
  model: string | null;
}

export interface Estimate { bytes: number | null; known: boolean; remote: boolean; seconds: number | null; needs: string; model: ModelBrief | null }

/** What to run: a named analysis, or a script file (path, with the editor's unsaved text). */
export interface RunRequest {
  name?: string;
  path?: string;
  text?: string;
  model?: string;
  params?: Record<string, unknown>;
  requestedBy?: "user" | "copilot";
}

export type RunOutcome =
  | { ok: true; report: Report; estimate?: Estimate; approved?: boolean }
  | { ok: false; cancelled: true; reason: string }
  | { ok: false; cancelled?: false; error: string };

export interface ForkRequest { src: string; name?: string; mode?: "link" | "copy"; note?: string; requestedBy?: "user" | "copilot" }

export interface AnalysisSettings {
  /** Ask before an analysis reads more than this many GB from local files. */
  confirmGb: number;
  /** Ask before reading more than this many MB from a model read in place on the Hub (a download). */
  remoteConfirmMb: number;
}

export const DEFAULT_SETTINGS: AnalysisSettings = { confirmGb: 2, remoteConfirmMb: 256 };

export const CH = {
  list: "analysis:list",
  models: "analysis:models",
  source: "analysis:source",
  forkScript: "analysis:fork-script",
  newScript: "analysis:new-script",
  estimate: "analysis:estimate",
  run: "analysis:run",
  forkModel: "analysis:fork-model",
  lineage: "analysis:lineage",
  settings: "analysis:settings",
  setSettings: "analysis:set-settings",
  progress: "analysis:progress",
} as const;

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return "unknown";
  if (s < 1) return "under a second";
  if (s < 90) return `~${Math.round(s)} s`;
  return `~${Math.round(s / 60)} min`;
}

/** Compact, readable numbers: 1,284 / 12.9K / 3.2B, small values to 4 significant digits. */
export function fmtNum(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a === 0) return "0";
  const trim = (x: string) => x.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  if (a >= 1e12) return `${trim((v / 1e12).toFixed(1))}T`;
  if (a >= 1e9) return `${trim((v / 1e9).toFixed(a >= 1e10 ? 1 : 2))}B`;
  if (a >= 1e6) return `${trim((v / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e4) return `${trim((v / 1e3).toFixed(1))}K`;
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  if (a >= 100) return v.toFixed(1);
  if (a >= 0.001) return String(Number(v.toPrecision(4)));
  return v.toExponential(2);
}
