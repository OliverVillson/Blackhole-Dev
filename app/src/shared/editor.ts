// I3 editor stream API: how the copilot (WS4) writes into the editor while the user watches and edits.

export type DecorationKind = "copilot" | "user" | "ghost";

export interface Hunk {
  id: string;
  file: string;
  streamId?: string;
  startLine: number;
  endLine: number;
  kind: "copilot" | "user";
  state: "pending" | "accepted" | "rejected";
  text: string;
}

export interface UserEditEvent {
  file: string;
  streamId?: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface LineEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

export type StreamAt = "cursor" | "end" | "replaceAll" | { line: number; col?: number };

export interface StreamOptions {
  at?: StreamAt;
  replaceRange?: { startLine: number; endLine: number };
}

export interface EditorStreamApi {
  streamBegin(file: string, opts?: StreamOptions): string;
  streamChunk(id: string, text: string): void;
  streamEnd(id: string): Hunk[];
  streamAbort(id: string): void;
  setGhost(file: string, text: string | null): void;
  onUserEdit(cb: (e: UserEditEvent) => void): () => void;
  onUserEdit(file: string, cb: (e: UserEditEvent) => void): () => void;
  hunks(file: string): Hunk[];
  listHunks(streamId: string): Hunk[];
  acceptHunk(id: string): void;
  rejectHunk(id: string): void;
  acceptAll(file: string): void;
  rejectAll(file: string): void;
  getText(file: string): string;
  applyEdits(file: string, edits: LineEdit[]): Hunk[];
}
