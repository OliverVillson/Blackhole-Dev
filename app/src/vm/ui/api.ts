// Typed calls to the vm:* handlers over the shell's generic bridge.
import type { UpSpec } from "../cloud";
import type {
  ForgetResult, Host, JobRef, JobUpdate, LaunchOptions, LaunchPlan, Probe, PullProgress, RemoteJob, VmOffer,
} from "../shared";
import { CH } from "../shared";

export interface Bridge {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
}

export function vmApi(b: Bridge) {
  return {
    hosts: (): Promise<Host[]> => b.invoke(CH.hostsList),
    addHost: (spec: string, label?: string, identityFile?: string): Promise<Host> => b.invoke(CH.hostsAdd, spec, label, identityFile),
    updateHost: (id: string, prefs: { ratePerHour?: number; currency?: string; venv?: string; label?: string }): Promise<Host> => b.invoke(CH.hostsUpdate, id, prefs),
    removeHost: (id: string): Promise<void> => b.invoke(CH.hostsRemove, id),
    forgetHost: (id: string): Promise<ForgetResult> => b.invoke(CH.hostsForget, id),
    testHost: (id: string): Promise<{ ok: boolean; latencyMs: number; probe?: Probe; error?: string }> => b.invoke(CH.hostsTest, id),
    offer: (spec: UpSpec): Promise<VmOffer> => b.invoke(CH.vmOffer, spec),
    up: (spec: UpSpec): Promise<{ approved: boolean; name?: string }> => b.invoke(CH.vmUp, spec, "user"),
    down: (hostId: string, o: { keepDisk: boolean; force?: boolean; resume?: boolean }): Promise<{ approved: boolean; done?: boolean; blockedBy?: string[]; message?: string }> =>
      b.invoke(CH.vmDown, hostId, o, "user"),
    prepare: (recipe: string, hostId: string, o?: { jobName?: string }): Promise<LaunchPlan> => b.invoke(CH.jobPrepare, recipe, hostId, o),
    launch: (planId: string, o: LaunchOptions): Promise<JobRef | null> => b.invoke(CH.jobLaunch, planId, { ...o, requestedBy: "user" }),
    jobs: (hostId: string): Promise<RemoteJob[]> => b.invoke(CH.jobList, hostId),
    watch: (ref: JobRef): Promise<JobUpdate> => b.invoke(CH.jobWatch, ref),
    unwatch: (ref: JobRef): Promise<void> => b.invoke(CH.jobUnwatch, ref),
    stop: (ref: JobRef): Promise<string> => b.invoke(CH.jobStop, ref),
    pull: (ref: JobRef, dest?: string): Promise<{ approved: boolean; dest?: string }> => b.invoke(CH.jobPull, ref, { dest, requestedBy: "user" }),
    exportBundle: (bundle: string): Promise<string | null> => b.invoke(CH.jobExport, bundle),
    terminalArgs: (hostId: string, mode: "tui" | "attach" | "shell", job?: string): Promise<{ cmd: string; args: string[]; title: string }> =>
      b.invoke(CH.terminalArgs, hostId, mode, job),
    onJob: (cb: (u: JobUpdate) => void) => b.on(CH.evJob, cb),
    onLog: (cb: (l: { scope: string; text: string }) => void) => b.on(CH.evLog, cb),
    onPull: (cb: (p: PullProgress) => void) => b.on(CH.evPull, cb),
    onHosts: (cb: (h: Host[]) => void) => b.on(CH.evHosts, cb),
  };
}

export type VmApi = ReturnType<typeof vmApi>;
