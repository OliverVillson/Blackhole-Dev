import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIRM_BYTES, downloadRepo, targetDir } from '../../src/chat/core/download';
import type { ConfirmRequest } from '../../src/chat/shared/ext-shim';
import type { DownloadProgress } from '../../src/chat/shared/types';
import { tmp } from './helpers';

const weights = Buffer.alloc(300_000, 7);
const files: Record<string, Buffer> = {
  'config.json': Buffer.from('{"architectures":["Qwen3ForCausalLM"]}'),
  'model.safetensors': weights,
  'tokenizer.json': Buffer.from('{}'),
  'pytorch_model.bin': Buffer.alloc(10),
};
let hub: string;
let srv: http.Server;
let fakeSize = 0; // reported LFS size override, to simulate a huge repo
let corrupt = false;
const ranges: string[] = [];

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/models/org/tiny/revision/main') {
      const sib = Object.entries(files).map(([n, b]) =>
        n.endsWith('.safetensors') ? { rfilename: n, size: b.length, lfs: { size: fakeSize || b.length, sha256: createHash('sha256').update(b).digest('hex') } } : { rfilename: n, size: b.length },
      );
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ siblings: sib }));
    }
    if (u.pathname.startsWith('/api/models/')) return res.writeHead(404).end();
    const m = u.pathname.match(/^\/org\/tiny\/resolve\/main\/(.+)$/);
    if (!m || !files[m[1]]) return res.writeHead(404).end();
    let b = files[m[1]];
    if (corrupt && m[1].endsWith('.safetensors')) b = Buffer.alloc(b.length, 1);
    const r = req.headers.range?.match(/bytes=(\d+)-/);
    if (r) {
      ranges.push(`${m[1]}:${r[1]}`);
      res.writeHead(206, { 'content-length': b.length - +r[1] });
      return res.end(b.subarray(+r[1]));
    }
    res.writeHead(200, { 'content-length': b.length });
    res.end(b);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  hub = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

const deps = (confirm: (r: ConfirmRequest) => boolean, seen: DownloadProgress[] = [], asked: ConfirmRequest[] = []) => ({
  hubUrl: hub,
  confirm: async (r: ConfirmRequest) => (asked.push(r), confirm(r)),
  progress: (p: DownloadProgress) => seen.push(p),
  freeBytes: async () => 1e12,
});

describe('downloadRepo', () => {
  it('downloads only the files a server needs, verifies sha256, and marks the folder', async () => {
    const dir = tmp();
    const asked: ConfirmRequest[] = [];
    const res = await downloadRepo({ repo: 'org/tiny' }, dir, deps(() => true, [], asked));
    expect(res.phase).toBe('done');
    expect(asked).toHaveLength(0); // small: no gate
    const out = targetDir(dir, 'org/tiny');
    expect(readFileSync(path.join(out, 'model.safetensors')).equals(weights)).toBe(true);
    expect(existsSync(path.join(out, 'pytorch_model.bin'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(out, '.bh-download.json'), 'utf8')).repo).toBe('org/tiny');
  });
  it('asks the confirm gate for large downloads and writes nothing when declined', async () => {
    fakeSize = CONFIRM_BYTES + 1;
    const dir = tmp();
    const asked: ConfirmRequest[] = [];
    const res = await downloadRepo({ repo: 'org/tiny' }, dir, deps(() => false, [], asked));
    fakeSize = 0;
    expect(res).toMatchObject({ phase: 'cancelled', approved: false });
    expect(asked[0]).toMatchObject({ action: 'download', requestedBy: 'user', title: 'Download org/tiny?' });
    expect(existsSync(targetDir(dir, 'org/tiny'))).toBe(false);
  });
  it('always asks when the copilot requested it', async () => {
    const asked: ConfirmRequest[] = [];
    const res = await downloadRepo({ repo: 'org/tiny', requestedBy: 'copilot', why: 'to test the recipe locally' }, tmp(), deps(() => true, [], asked));
    expect(res).toMatchObject({ phase: 'done', approved: true });
    expect(asked[0].requestedBy).toBe('copilot');
    expect(asked[0].why).toMatch(/test the recipe locally/);
  });
  it('resumes a partial file with a range request', async () => {
    const dir = tmp();
    const out = targetDir(dir, 'org/tiny');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'model.safetensors.part'), weights.subarray(0, 100_000));
    ranges.length = 0;
    const res = await downloadRepo({ repo: 'org/tiny' }, dir, deps(() => true));
    expect(res.phase).toBe('done');
    expect(ranges).toEqual(['model.safetensors:100000']);
    expect(readFileSync(path.join(out, 'model.safetensors')).equals(weights)).toBe(true);
  });
  it('removes a file whose checksum does not match', async () => {
    corrupt = true;
    const dir = tmp();
    const res = await downloadRepo({ repo: 'org/tiny' }, dir, deps(() => true));
    corrupt = false;
    expect(res.phase).toBe('error');
    expect(res.error).toMatch(/checksum/);
    expect(existsSync(path.join(targetDir(dir, 'org/tiny'), 'model.safetensors.part'))).toBe(false);
  });
  it('refuses when the disk is too full, bad repo ids, and unknown repos', async () => {
    expect((await downloadRepo({ repo: 'org/tiny' }, tmp(), { ...deps(() => true), freeBytes: async () => 10 })).error).toMatch(/free on disk/);
    expect((await downloadRepo({ repo: '../etc' }, tmp(), deps(() => true))).error).toMatch(/not a Hugging Face repo id/);
    expect((await downloadRepo({ repo: 'org/missing' }, tmp(), deps(() => true))).error).toMatch(/not found/);
  });
});
