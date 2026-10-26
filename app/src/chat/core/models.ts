import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LocalModel } from '../shared/types';

/** Files the pipeline or a download leaves in a model folder to mark where it came from. */
const RECEIPTS = ['blackhole.json', 'blackhole-receipt.json', 'receipt.json'];
export const DOWNLOAD_MARKER = '.bh-download.json';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile()) total += (await fs.stat(p)).size;
    else if (e.isDirectory() && !e.name.startsWith('.')) total += await folderSize(p);
  }
  return total;
}

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Reads one MLX model folder: config.json plus at least one .safetensors file. */
export async function readMlxFolder(dir: string, downloadDir?: string): Promise<LocalModel | undefined> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  if (!names.includes('config.json') || !names.some((n) => n.endsWith('.safetensors'))) return undefined;
  const cfg = (await readJson(path.join(dir, 'config.json'))) ?? {};
  const q = cfg.quantization ?? cfg.quantization_config ?? {};
  let source: LocalModel['source'] = 'other';
  if (RECEIPTS.some((r) => names.includes(r)) || cfg.blackhole || /blackhole/i.test(path.basename(dir))) source = 'pipeline';
  else if (names.includes(DOWNLOAD_MARKER) || (downloadDir && path.resolve(dir).startsWith(path.resolve(downloadDir) + path.sep)))
    source = 'download';
  const hex = /hex/i.test(JSON.stringify(q)) || Boolean(cfg.blackhole?.hex) || names.some((n) => /^hex.*\.json$/i.test(n));
  return {
    id: path.resolve(dir),
    name: path.basename(dir),
    path: path.resolve(dir),
    format: 'mlx',
    sizeBytes: await folderSize(dir),
    source,
    arch: cfg.architectures?.[0] ?? cfg.model_type ?? cfg.text_config?.model_type,
    bits: typeof q.bits === 'number' ? q.bits : undefined,
    hex,
  };
}

/**
 * Finds models under each root, two folders deep (root/model and root/group/model), which
 * covers ~/flint/<model>, ~/.blackhole/models/<org>/<model> and pipeline results copied back.
 */
export async function scanModels(roots: string[], downloadDir?: string): Promise<LocalModel[]> {
  const found = new Map<string, LocalModel>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    const m = await readMlxFolder(dir, downloadDir);
    if (m) {
      found.set(m.id, m);
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.gguf') && !/mmproj/i.test(e.name)) {
        // Split GGUFs: list only the first shard, sized as the whole set.
        const shard = e.name.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/);
        if (shard && shard[2] !== '00001') continue;
        let size = (await fs.stat(p)).size;
        if (shard) {
          size = 0;
          for (const n of await fs.readdir(dir)) if (n.startsWith(`${shard[1]}-`) && n.endsWith('.gguf')) size += (await fs.stat(path.join(dir, n))).size;
        }
        const id = path.resolve(p);
        found.set(id, {
          id,
          name: e.name.replace(/(-\d{5}-of-\d{5})?\.gguf$/, ''),
          path: id,
          format: 'gguf',
          sizeBytes: size,
          source: /blackhole/i.test(e.name) ? 'pipeline' : downloadDir && id.startsWith(path.resolve(downloadDir)) ? 'download' : 'other',
          hex: false,
        });
      } else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') {
        await visit(p, depth - 1);
      }
    }
  };
  for (const r of roots) if (await exists(r)) await visit(r, 2);
  const rank = { pipeline: 0, download: 1, other: 2 };
  return [...found.values()].sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name));
}
