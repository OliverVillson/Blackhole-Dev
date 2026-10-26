import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalServer } from '../../src/chat/core/server';
import type { LocalModel, ServerSettings } from '../../src/chat/shared/types';
import { DEFAULT_SETTINGS } from '../../src/chat/shared/types';

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-mlx-server.mjs');

export function tmp(prefix = 'bhc-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes a minimal MLX model folder: config.json plus a tiny safetensors file. */
export function mlxFolder(dir: string, cfg: object = { architectures: ['Qwen3MoeForCausalLM'], quantization: { bits: 4, group_size: 64 } }, extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(2048));
  for (const [k, v] of Object.entries(extra)) writeFileSync(path.join(dir, k), v);
  return dir;
}

export function fakeModel(dir = mlxFolder(path.join(tmp(), 'qwen3.6-blackhole-9.8GB'))): LocalModel {
  return { id: dir, name: path.basename(dir), path: dir, format: 'mlx', sizeBytes: 2048, source: 'pipeline', hex: false };
}

let nextPort = 18000 + Math.floor(Math.random() * 20000);
export function settings(over: Partial<ServerSettings> = {}): ServerSettings {
  return { ...DEFAULT_SETTINGS('/home/x').server, port: nextPort++ + Math.floor(Math.random() * 50), ...over };
}

export function fakeServer(opts: { readyTimeoutMs?: number } = {}): LocalServer {
  return new LocalServer({ pollMs: 30, readyTimeoutMs: opts.readyTimeoutMs ?? 10_000, resolve: async () => ({ cmd: process.execPath, pre: [FAKE] }) });
}
