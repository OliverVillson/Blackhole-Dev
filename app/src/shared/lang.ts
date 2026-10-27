// What blackhole_dev.lang tells the editor about recipe files (lang.catalog), and the Jedi
// answers (lang.complete / lang.signatures / lang.hover). Lines 1-based, columns 0-based.

export interface SigParam {
  name: string;
  label: string;
  default?: unknown;
  required?: boolean;
  kwOnly?: boolean;
}

export interface Sig {
  params: SigParam[];
  doc: string;
}

export interface ParamInfo {
  type?: string;
  default?: unknown;
  required?: boolean;
  help?: string;
  doc?: string;
  stage?: string;
}

export interface Catalog {
  recipe: { ctor: Sig; methods: Record<string, Sig>; fields: Record<string, string>; attrs: Record<string, string> };
  gate: Sig;
  stepOpts: Record<string, string>;
  inputSpec: Record<string, string>;
  inputTypes: string[];
  gateOps: string[];
  gateMetrics: string[];
  pipeline: { steps: { name: string; doc: string }[]; params: Record<string, ParamInfo>; checked: boolean };
  functions: { name: string; per: string; doc: string; params: Record<string, ParamInfo>; origin: string }[];
  ops: { name: string; major: number; doc: string; params: Record<string, ParamInfo> }[];
  query: { top: string[]; children: Record<string, string[]>; filters: Record<string, string>; kinds: string[]; examples: Record<string, string> };
  architectures: string[];
  devices: { id: string; label: string; memGb?: number }[];
  models: { id: string; detail: string }[];
  jedi: boolean;
}

export interface LangPos {
  text: string;
  line: number;
  col: number;
  path?: string;
}

export interface JediItem {
  label: string;
  kind: string;
  detail?: string;
}

export interface JediSignature {
  label: string;
  doc: string;
  params: string[];
  active: number | null;
}
