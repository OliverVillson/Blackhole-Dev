import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { WiredLimit } from '../shared/types';

const run = promisify(execFile);

/** What macOS lets the GPU wire when iogpu.wired_limit_mb is 0: about 2/3 of RAM up to 36 GB, 3/4 above. */
export function defaultWiredMb(totalMb: number): number {
  return Math.floor(totalMb * (totalMb <= 36 * 1024 ? 2 / 3 : 3 / 4));
}

/** Leave 4 GB for macOS and the app; on a 16 GB Mac that is the 12288 MB measured on the M5. */
export function recommendedWiredMb(totalMb: number): number {
  return Math.max(totalMb - 4096, Math.floor(totalMb * 0.75));
}

export interface Shell {
  exec(cmd: string, args: string[]): Promise<string>;
  platform: NodeJS.Platform;
  arch: string;
  totalMb: number;
}

export const realShell: Shell = {
  exec: async (cmd, args) => (await run(cmd, args, { timeout: 120_000 })).stdout,
  platform: process.platform,
  arch: process.arch,
  totalMb: Math.round(os.totalmem() / 2 ** 20),
};

/**
 * Reads the GPU wired limit. `needBytes` is the model size: the limit is "ok" when the model
 * plus 1 GB of KV cache and scratch fits under it.
 */
export async function readWiredLimit(sh: Shell = realShell, needBytes = 0): Promise<WiredLimit> {
  if (sh.platform !== 'darwin' || sh.arch !== 'arm64') return { supported: false, ok: true };
  let current = 0;
  try {
    current = parseInt((await sh.exec('/usr/sbin/sysctl', ['-n', 'iogpu.wired_limit_mb'])).trim(), 10) || 0;
  } catch {
    return { supported: false, ok: true, totalMb: sh.totalMb };
  }
  const effective = current || defaultWiredMb(sh.totalMb);
  // Measured on the M5: the 9.8 GB build peaks at 10.6 GB (decimal) on short prompts. HEX models
  // dequantize prompt experts in 256 MB chunks (flint_mlx.py), so long prompts stay close to that and
  // it fits the default 2/3-of-RAM limit on a 16 GB Mac without a sysctl.
  const needMb = needBytes / 2 ** 20 + 1024;
  return {
    supported: true,
    currentMb: current,
    recommendedMb: recommendedWiredMb(sh.totalMb),
    totalMb: sh.totalMb,
    ok: needBytes === 0 ? current >= recommendedWiredMb(sh.totalMb) : effective >= needMb,
  };
}

/**
 * Raises the limit until the next reboot. macOS shows its own administrator password prompt,
 * so nothing changes without the user typing their password.
 */
export async function setWiredLimit(mb: number, sh: Shell = realShell): Promise<WiredLimit> {
  const n = Math.floor(mb);
  if (!Number.isFinite(n) || n < 1024 || n > sh.totalMb) throw new Error(`wired limit ${mb} MB is outside 1024..${sh.totalMb}`);
  await sh.exec('/usr/bin/osascript', ['-e', `do shell script "/usr/sbin/sysctl iogpu.wired_limit_mb=${n}" with administrator privileges`]);
  return readWiredLimit(sh);
}
