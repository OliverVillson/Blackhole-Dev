// Long error text (Hugging Face's 401 page, tracebacks) shown as one readable line plus the full
// text behind a "details" toggle. Pure, so the copilot panel, toasts and tests share it.

const HUB_DENIED = /\b40[13] Client Error|Repository Not Found|GatedRepoError|gated repo|Invalid username or password/i;
const HEAD_MAX = 200;

export interface ErrorParts {
  /** One line a person can act on. */
  head: string;
  /** The whole original text, for details and Copy. */
  full: string;
  /** Whether `full` says more than `head`. */
  more: boolean;
}

/** The Hub repo id a Hugging Face error is about, from its URL (huggingface.co/org/name/resolve/...). */
export function hubRepoFrom(text: string): string | null {
  const m = /huggingface\.co\/(?:api\/models\/)?([\w.-]+\/[\w.-]+)\/(?:resolve|tree|revision)\b/.exec(text);
  return m ? m[1] : null;
}

export function splitError(text: string): ErrorParts {
  const full = String(text ?? "").trim();
  let head: string;
  if (HUB_DENIED.test(full) && /huggingface/i.test(full)) {
    const cut = full.search(/(?:[A-Za-z]*Error: )*\b40[13] Client Error|Repository Not Found|GatedRepoError/i);
    const prefix = (cut > 0 ? full.slice(0, cut) : "").replace(/[\s:]+$/, "");
    const repo = hubRepoFrom(full);
    const tried = repo && !prefix.includes(repo) ? ` (tried ${repo})` : "";
    head = `${prefix ? prefix + ": " : ""}this repo is gated or private on Hugging Face, or the id is wrong${tried}. Add a Hugging Face token in Settings`;
  } else {
    head = (full.split("\n").find((l) => l.trim()) ?? "").replace(/\s*\(Request ID: [^)]*\)/g, "").trim();
    if (head.length > HEAD_MAX) head = head.slice(0, HEAD_MAX).replace(/\s+\S*$/, "") + "…";
  }
  return { head: head || full, full, more: full !== head && full.length > 0 };
}
