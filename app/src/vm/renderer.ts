// WS5 renderer side: the Machines view, the Run on VM dialog, job monitor tabs, the status bar
// item and the ssh terminal, mounted into the shell's slots.

import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { VmRendererContext } from "./ctx";
import { summary } from "./events";
import type { Host, JobRef, JobUpdate, RemoteJob } from "./shared";
import { jobKey } from "./shared";
import { vmApi } from "./ui/api";
import { JobMonitor, type MonitorState } from "./ui/JobMonitor";
import { Machines } from "./ui/Machines";
import { RunOnVm } from "./ui/RunOnVm";
import "./ui/vm.css";

const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>';

function mount(el: HTMLElement, node: ReactElement): () => void {
  const root = createRoot(el);
  root.render(node);
  return () => root.unmount();
}

export function activate(ctx: VmRendererContext): void {
  const api = vmApi(ctx);
  const labels = new Map<string, string>();
  const hostLabel = (id: string) => labels.get(id) ?? id.replace(/^\w+:/, "");
  void api.hosts().then((hs) => hs.forEach((h) => labels.set(h.id, h.label)));
  api.onHosts((hs: Host[]) => hs.forEach((h) => labels.set(h.id, h.label)));

  const openTerminal = async (hostId: string, mode: "tui" | "attach" | "shell", job?: string) => {
    const t = await api.terminalArgs(hostId, mode, job);
    await ctx.terminal.create({ title: t.title, cmd: t.cmd, args: t.args });
  };

  const openMonitor = (job: JobRef, estHours?: number) => {
    const state: MonitorState = { job, hostLabel: hostLabel(job.hostId), estHours };
    ctx.openTab("job-monitor", state);
  };

  const ask = (question: string): Promise<boolean> =>
    new Promise((resolve) => {
      let answered = false;
      const m = ctx.showModal({
        title: "Are you sure?",
        width: 460,
        render(el, close) {
          el.innerHTML = "";
          const box = document.createElement("div");
          box.className = "bhvm";
          box.style.cssText = "padding:20px 22px;display:flex;flex-direction:column;gap:16px";
          const p = document.createElement("p");
          p.style.margin = "0";
          p.textContent = question;
          const row = document.createElement("div");
          row.className = "row";
          row.style.justifyContent = "flex-end";
          const done = (v: boolean) => {
            answered = true;
            resolve(v);
            close();
          };
          for (const [label, v, cls] of [["Cancel", false, "btn"], ["Stop job", true, "btn dng"]] as const) {
            const b = document.createElement("button");
            b.className = cls;
            b.textContent = label;
            b.onclick = () => done(v);
            row.append(b);
          }
          box.append(p, row);
          el.append(box);
          return () => !answered && resolve(false);
        },
      });
      void m;
    });

  ctx.registerActivity({ id: "vm", title: "Machines and jobs", icon: ICON, order: 40 });
  ctx.registerSidebarView("vm", {
    render: (el) => mount(el, createElement(Machines, {
      api,
      openJob: (h: Host, j: RemoteJob) => openMonitor({ hostId: h.id, name: j.name }, j.estHours),
      openTerminal: (h: Host) => void openTerminal(h.id, "tui"),
    })),
  });

  ctx.registerTabType({
    id: "job-monitor",
    title: (s: MonitorState) => `job · ${s.job.name}`,
    render: (el, s: MonitorState) => mount(el, createElement(JobMonitor, {
      api,
      tab: s,
      ask,
      openTerminal: (mode) => void openTerminal(s.job.hostId, mode, s.job.name),
    })),
  });

  const runOnVm = (path?: string) => {
    const recipe = path ?? ctx.workspace.activeFile();
    if (!recipe || !recipe.endsWith(".py")) {
      ctx.showModal({
        title: "Run on VM",
        width: 420,
        render(el, close) {
          el.innerHTML = "";
          const box = document.createElement("div");
          box.className = "bhvm";
          box.style.cssText = "padding:20px 22px;display:flex;flex-direction:column;gap:14px";
          box.textContent = "Open a recipe (.py) first, or right-click one in the Recipes sidebar.";
          const b = document.createElement("button");
          b.className = "btn";
          b.textContent = "OK";
          b.style.alignSelf = "flex-end";
          b.onclick = close;
          box.append(b);
          el.append(box);
        },
      });
      return;
    }
    ctx.showModal({
      title: "Run on VM",
      width: 820,
      render: (el, close) => mount(el, createElement(RunOnVm, { api, recipe, close, onLaunched: (ref: JobRef) => openMonitor(ref) })),
    });
  };

  ctx.registerCommand({ id: "blackhole.runOnVm", title: "Run on VM…", keybinding: "Cmd+R", run: (path?: string) => runOnVm(path) });
  ctx.registerRecipeAction({ id: "vm.runOnVm", title: "Run on VM…", run: (path) => runOnVm(path) });
  ctx.registerCommand({ id: "blackhole.machines", title: "Machines and jobs", run: () => ctx.executeCommand("workbench.view", "vm") });

  // status bar: the running job(s) and their stage, else nothing to say
  const status = ctx.registerStatusItem({ id: "vm.status", side: "right", text: "no job running", title: "Machines and jobs", command: "blackhole.machines" });
  const live = new Map<string, JobUpdate>();
  api.onJob((u: JobUpdate) => {
    live.set(jobKey(u.job), u);
    const running = [...live.values()].filter((x) => x.state.status === "running");
    if (running.length === 1) {
      const r = running[0];
      status.update(`${hostLabel(r.job.hostId)} · ${summary(r.state)}${r.link !== "live" ? " · reconnecting" : ""}`);
    } else if (running.length > 1) status.update(`${running.length} jobs running`);
    else {
      const last = [...live.values()].pop();
      status.update(last ? `${last.job.name} · ${summary(last.state)}` : "no job running");
    }
  });
}
