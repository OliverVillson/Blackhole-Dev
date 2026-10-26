// The shell commands the app runs on a host. One place builds them, so the Run on VM dialog's
// "What will run" preview is the exact text that later runs.

/** POSIX single-quote: safe for any string in sh, bash and zsh. */
export function q(s: string): string {
  // keep a leading ~/ outside the quotes so the remote shell still expands it
  if (s.startsWith("~/")) return "~/" + q(s.slice(2));
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const jobsDir = (home: string) => `${home}/jobs`;
export const jobDir = (home: string, name: string) => `${jobsDir(home)}/${name}`;
export const tmuxName = (job: string) => `bh-${job}`.replace(/[.:]/g, "-").slice(0, 60);

/** "qwen-mac-qhex" + now -> "qwen-mac-qhex-1026-101803", the shape TUI jobs already have. */
export function jobName(recipe: string, now = new Date()): string {
  const slug = recipe.toLowerCase().replace(/\.(py|bhr)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "recipe";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${slug}-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function validJobName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);
}

/**
 * The command tmux runs. It takes the environment the installed `blackhole` launcher sets (compile
 * caches, the vLLM venv, attention backend) so a run from the app behaves like a run from the TUI,
 * then appends the pipeline's stdout to events.log, which the TUI and the app both tail.
 */
export function pipelineCommand(o: { venv: string; dir: string; extra?: string[] }): string {
  const launcher = "$HOME/.local/bin/blackhole";
  return [
    `cd ${q(o.dir)}`,
    `[ -f "${launcher}" ] && eval "$(grep '^export ' "${launcher}")"`,
    `export PYTORCH_CUDA_ALLOC_CONF=\${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}`,
    `. ${q(o.venv + "/bin/activate")}`,
    `exec python -u -m blackhole_pipeline --job ${q(o.dir)} --recipe ${q(o.dir + "/recipe.bhr")}` +
      (o.extra?.length ? " " + o.extra.map(q).join(" ") : "") +
      ` >> ${q(o.dir + "/events.log")} 2>&1`,
  ].join("; ");
}

/** Starts the pipeline in a detached tmux session, so it survives the laptop closing. */
export function tmuxLaunch(o: { venv: string; dir: string; session: string; extra?: string[] }): string {
  return `tmux new-session -d -s ${q(o.session)} -c ${q(o.dir)} ${q("bash -c " + q(pipelineCommand(o)))}`;
}

export const mkdirJob = (dir: string) => `mkdir -p ${q(dir)}`;
export const sha256Of = (file: string) => `sha256sum ${q(file)} 2>/dev/null || shasum -a 256 ${q(file)}`;

/** Writes a small file from stdin, atomically. */
export const writeFile = (path: string) => `cat > ${q(path + ".part")} && mv ${q(path + ".part")} ${q(path)}`;

export function installWheel(venv: string, wheel: string): string {
  return `${q(venv + "/bin/pip")} install --quiet --no-deps --force-reinstall ${q(wheel)}`;
}

/** From byte `offset` on, and then every line as it lands. tail -c +N is 1-based. */
export function tailEvents(dir: string, offset = 0): string {
  const f = `${dir}/events.log`;
  return `touch ${q(f)} && exec tail -c +${offset + 1} -F ${q(f)} 2>/dev/null`;
}

/** Stops one job's pipeline: remote/scripts.ts STOP_PY, run as `python3 - <dir> <session>`. */
export const stopJob = (dir: string, session: string) => `python3 - ${q(dir)} ${q(session)}`;

/** What `job.pull` copies: the job's out/ folder, symlinks followed (out/ holds links to the artifacts). */
export function rsyncPullArgs(o: { target: string; dir: string; dest: string; sshArgs: string[] }): string[] {
  return ["-a", "-L", "--partial", "--progress", "-e", ["ssh", ...o.sshArgs].map(q).join(" "),
    `${o.target}:${o.dir}/out/`, o.dest.endsWith("/") ? o.dest : o.dest + "/"];
}

export function rsyncPushArgs(o: { target: string; file: string; remote: string; sshArgs: string[] }): string[] {
  return ["-a", "--partial", "-e", ["ssh", ...o.sshArgs].map(q).join(" "), o.file, `${o.target}:${o.remote}`];
}

/** The TUI on the host, for the embedded terminal: the installed launcher, else the venv's command. */
export function tuiCommand(venv: string | null): string {
  const v = venv ? `. ${q(venv + "/bin/activate")} 2>/dev/null; ` : "";
  return `bash -lc ${q(`${v}command -v blackhole >/dev/null && exec blackhole; exec "$HOME/.local/bin/blackhole"`)}`;
}

export function attachCommand(session: string): string {
  return `tmux attach -t ${q(session)} || exec bash -l`;
}
