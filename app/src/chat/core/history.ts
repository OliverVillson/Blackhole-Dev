import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../shared/types';

/**
 * One saved conversation per model, as <dir>/<sha1 of the model id>.json. Model ids are folder
 * paths, so they are hashed rather than used as file names.
 */
export class HistoryFiles {
  constructor(readonly dir: string) {}

  file(modelId: string): string {
    return path.join(this.dir, `${createHash('sha1').update(modelId).digest('hex').slice(0, 20)}.json`);
  }

  load(modelId: string): ChatMessage[] {
    try {
      const raw = JSON.parse(readFileSync(this.file(modelId), 'utf8'));
      return raw?.modelId === modelId && Array.isArray(raw.messages) ? raw.messages : [];
    } catch {
      return []; // no file yet, or a damaged one: start fresh rather than refuse to chat
    }
  }

  save(modelId: string, messages: ChatMessage[]): void {
    const f = this.file(modelId);
    if (!messages.length) {
      if (existsSync(f)) rmSync(f, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    // Write then rename, so a crash mid-write never leaves half a conversation.
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ modelId, savedAt: new Date().toISOString(), messages }));
    renameSync(tmp, f);
  }
}
