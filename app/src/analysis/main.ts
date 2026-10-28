// Analysis module, main process: runs analyses and forks models through the Python helper,
// with the confirm gate in front of big reads and full copies (core.ts).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MainContext } from "../shared/ext";
import { estimateAnalysis, forkModel, runAnalysis, scriptTemplate, type Deps } from "./core";
import { CH, DEFAULT_SETTINGS, type AnalysisSettings, type ForkRequest, type RunRequest } from "./shared";

const SETTINGS_KEY = "analysis";

export function activate(ctx: MainContext) {
  const dir = join(ctx.paths.workspace, "analysis");
  const settings = (): AnalysisSettings => ({ ...DEFAULT_SETTINGS, ...ctx.settings.get<Partial<AnalysisSettings>>(SETTINGS_KEY, {}) });
  const deps: Deps = {
    call: (method, params, timeoutMs) => ctx.helper.call(method, params, timeoutMs),
    confirm: (r) => ctx.gate.confirm(r),
    settings,
  };
  ctx.helper.onNotify("progress", (p: { message?: string; fraction?: number }) => ctx.send(CH.progress, p));

  ctx.handle(CH.list, () => ctx.helper.call("analysis.list", {}));
  ctx.handle(CH.models, () => ctx.helper.call("model.list", {}));
  ctx.handle(CH.source, (name: string) => ctx.helper.call("analysis.source", { name }));
  ctx.handle(CH.forkScript, (name: string, newName?: string) => ctx.helper.call("analysis.fork", { name, newName }));
  ctx.handle(CH.estimate, (req: RunRequest) => estimateAnalysis(deps, req));
  ctx.handle(CH.run, (req: RunRequest) => runAnalysis(deps, req));
  ctx.handle(CH.forkModel, (req: ForkRequest) => forkModel(deps, req));
  ctx.handle(CH.lineage, (path: string) => ctx.helper.call("model.lineage", { path }));
  ctx.handle(CH.newScript, (name: string) => {
    const stem = (name || "my-analysis").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "my-analysis";
    mkdirSync(dir, { recursive: true });
    let path = join(dir, `${stem.replace(/-/g, "_")}.py`);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${stem.replace(/-/g, "_")}_${n}.py`);
    writeFileSync(path, scriptTemplate(stem));
    return path;
  });
  ctx.handle(CH.settings, () => settings());
  ctx.handle(CH.setSettings, (patch: Partial<AnalysisSettings>) => {
    const next = { ...settings(), ...patch };
    if (!(next.confirmGb > 0) || !(next.remoteConfirmMb > 0)) throw new Error("limits must be positive numbers");
    ctx.settings.set(SETTINGS_KEY, next);
    return next;
  });
}
