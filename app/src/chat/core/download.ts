import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ConfirmRequest } from '../shared/ext-shim';
import { formatBytes } from '../shared/stats';
import type { DownloadProgress, DownloadRequest } from '../shared/types';
import { DOWNLOAD_MARKER } from './models';

/** Downloads at or above this size go through the confirm gate (decision 7: large downloads need a human click). */
export const CONFIRM_BYTES = 1e9;

/** Files a chat server needs; skips the original PyTorch/ONNX copies some repos also carry. */
const WANTED = /(\.safetensors|\.json|\.jinja|\.model|\.tiktoken|\.txt|\.py|\.gguf)$/i;
const SKIP = /(^|\/)(original|onnx|pytorch_model|consolidated)|\.(bin|pt|pth|msgpack|h5)$/i;

export interface RepoFile {
  name: string;
  size: number;
  sha256?: string;
}

export interface DownloadDeps {
  confirm(req: ConfirmRequest): Promise<boolean>;
  progress(p: DownloadProgress): void;
  hubUrl?: string; // https://huggingface.co, overridable for mirrors and tests
  token?: string;
  freeBytes?(dir: string): Promise<number>;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function targetDir(downloadDir: string, repo: string): string {
  if (!REPO_RE.test(repo) || repo.includes('..')) throw new Error(`"${repo}" is not a Hugging Face repo id like org/name`);
  return path.join(downloadDir, ...repo.split('/'));
}

export async function listRepo(repo: string, rev: string, hub: string, token?: string, signal?: AbortSignal): Promise<RepoFile[]> {
  const r = await fetch(`${hub}/api/models/${repo}/revision/${encodeURIComponent(rev)}?blobs=true`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (r.status === 401 || r.status === 403) throw new Error(`${repo} is gated or private; it needs a Hugging Face token`);
  if (r.status === 404) throw new Error(`${repo} was not found on the hub`);
  if (!r.ok) throw new Error(`hub answered ${r.status} for ${repo}`);
  const j: any = await r.json();
  const files: RepoFile[] = (j.siblings ?? [])
    .map((s: any) => ({ name: String(s.rfilename), size: Number(s.lfs?.size ?? s.size ?? 0), sha256: s.lfs?.sha256 }))
    .filter((f: RepoFile) => WANTED.test(f.name) && !SKIP.test(f.name) && !f.name.includes('..') && !path.isAbsolute(f.name));
  if (!files.some((f) => /\.(safetensors|gguf)$/i.test(f.name))) throw new Error(`${repo} has no .safetensors or .gguf weights`);
  return files;
}

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(p), h);
  return h.digest('hex');
}

async function statSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

async function defaultFree(dir: string): Promise<number> {
  let d = dir;
  for (;;) {
    try {
      const s = await fs.statfs(d);
      return s.bavail * s.bsize;
    } catch {
      const up = path.dirname(d);
      if (up === d) return Number.POSITIVE_INFINITY;
      d = up;
    }
  }
}

/**
 * Downloads a model repo into <downloadDir>/<org>/<name>, resuming partial files and checking
 * sha256 of every LFS file. Asks the confirm gate first when the total is CONFIRM_BYTES or more.
 */
export async function downloadRepo(req: DownloadRequest, downloadDir: string, deps: DownloadDeps, signal?: AbortSignal): Promise<DownloadProgress> {
  const hub = (deps.hubUrl ?? 'https://huggingface.co').replace(/\/$/, '');
  const rev = req.revision || 'main';
  const base: DownloadProgress = { repo: req.repo, file: '', doneBytes: 0, totalBytes: 0, phase: 'listing' };
  const report = (p: Partial<DownloadProgress>) => {
    Object.assign(base, p);
    deps.progress({ ...base });
    return { ...base };
  };
  try {
    const dir = targetDir(downloadDir, req.repo);
    report({});
    const files = await listRepo(req.repo, rev, hub, deps.token, signal);
    const total = files.reduce((n, f) => n + f.size, 0);
    report({ totalBytes: total });

    const have = (await Promise.all(files.map((f) => statSize(path.join(dir, f.name))))).reduce((n, s, i) => n + Math.min(s, files[i].size), 0);
    const free = await (deps.freeBytes ?? defaultFree)(downloadDir);
    if (free < total - have) throw new Error(`needs ${formatBytes(total - have)} free on disk, only ${formatBytes(free)} left`);

    // Copilot-requested downloads always ask, whatever the size.
    if (total >= CONFIRM_BYTES || req.requestedBy === 'copilot') {
      report({ phase: 'waiting-confirm' });
      const ok = await deps.confirm({
        action: 'download',
        title: `Download ${req.repo}?`,
        why: req.why ? `${req.why} (large downloads always need your click)` : 'Large model downloads use disk space and bandwidth, so they need your click.',
        details: [
          { label: 'Size', value: formatBytes(total) },
          { label: 'Files', value: String(files.length) },
          { label: 'Into', value: dir },
          { label: 'From', value: `${hub}/${req.repo} (${rev})` },
        ],
        requestedBy: req.requestedBy ?? 'user',
      });
      if (!ok) return report({ phase: 'cancelled', approved: false });
      report({ approved: true });
    }

    let done = 0;
    for (const f of files) {
      if (signal?.aborted) return report({ phase: 'cancelled' });
      const dest = path.join(dir, f.name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      if ((await statSize(dest)) === f.size && f.size > 0) {
        done += f.size;
        report({ phase: 'downloading', file: f.name, doneBytes: done });
        continue;
      }
      let start = await statSize(part);
      if (start > f.size) {
        await fs.rm(part);
        start = 0;
      }
      const headers: Record<string, string> = deps.token ? { authorization: `Bearer ${deps.token}` } : {};
      if (start > 0) headers.range = `bytes=${start}-`;
      const r = await fetch(`${hub}/${req.repo}/resolve/${encodeURIComponent(rev)}/${f.name.split('/').map(encodeURIComponent).join('/')}`, { headers, signal });
      if (!r.ok || !r.body) throw new Error(`${f.name}: hub answered ${r.status}`);
      if (start > 0 && r.status !== 206) start = 0; // server ignored the range: start over
      let got = start;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          got += chunk.byteLength;
          report({ phase: 'downloading', file: f.name, doneBytes: done + got });
          ctl.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(r.body.pipeThrough(counter) as any), createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }));
      if (f.sha256) {
        report({ phase: 'verifying', file: f.name });
        const h = await sha256File(part);
        if (h !== f.sha256) {
          await fs.rm(part, { force: true });
          throw new Error(`${f.name}: checksum mismatch, the partial file was removed; try again`);
        }
      }
      await fs.rename(part, dest);
      done += f.size;
    }
    await fs.writeFile(path.join(dir, DOWNLOAD_MARKER), JSON.stringify({ repo: req.repo, revision: rev, at: new Date().toISOString(), files: files.length, bytes: total }, null, 2));
    return report({ phase: 'done', file: '', doneBytes: total });
  } catch (e) {
    if (signal?.aborted) return report({ phase: 'cancelled' });
    return report({ phase: 'error', error: (e as Error).message });
  }
}
