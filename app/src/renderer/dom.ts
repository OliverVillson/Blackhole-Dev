// Tiny DOM helpers for the shell (no framework).

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k === "html") el.innerHTML = String(v); // only used for trusted, static SVG icons
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function dirname(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const ICONS = {
  recipes: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  functions: '<svg viewBox="0 0 24 24"><path d="M15 4c-3 0-4 1.5-4.5 4L8 20"/><path d="M7 10h7"/></svg>',
  anatomy: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  logo: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><defs><radialGradient id="bhmt" gradientUnits="userSpaceOnUse" cx="12" cy="12" r="7.63"><stop offset="0.49" stop-color="#ffae42"/><stop offset="0.64" stop-color="#ff6a00"/><stop offset="0.81" stop-color="#d7261e"/><stop offset="0.92" stop-color="#9e1b07"/><stop offset="1" stop-color="#9e1b07" stop-opacity="0"/></radialGradient><radialGradient id="bhmb" gradientUnits="userSpaceOnUse" cx="12" cy="12" r="5.95"><stop offset="0.62" stop-color="#ff6a00"/><stop offset="0.79" stop-color="#d7261e"/><stop offset="1" stop-color="#9e1b07" stop-opacity="0"/></radialGradient><linearGradient id="bhmd" gradientUnits="userSpaceOnUse" x1="0.47" y1="0" x2="23.53" y2="0"><stop offset="0" stop-color="#9e1b07"/><stop offset=".22" stop-color="#ff6a00"/><stop offset=".42" stop-color="#f5efe6"/><stop offset=".6" stop-color="#ffae42"/><stop offset=".8" stop-color="#d7261e"/><stop offset="1" stop-color="#9e1b07"/></linearGradient></defs><path d="M0.47 12A11.53 2.65 0 0 1 23.53 12L17.21 12A5.21 1.2 0 0 0 6.79 12Z" fill="url(#bhmd)"/><path d="M0.47 12A11.53 2.65 0 0 1 23.53 12L17.21 12A5.21 1.2 0 0 0 6.79 12Z" fill="#000000" fill-opacity=".45"/><path d="M4.37 12A7.63 7.63 0 0 1 19.63 12L15.72 12A3.72 3.72 0 0 0 8.28 12Z" fill="url(#bhmt)"/><path d="M6.05 12A5.95 5.95 0 0 0 17.95 12L15.72 12A3.72 3.72 0 0 1 8.28 12Z" fill="url(#bhmb)"/><circle cx="12" cy="12" r="3.72" fill="#000000"/><circle cx="12" cy="12" r="4.06" fill="none" stroke="#f5efe6" stroke-width="0.68"/><path d="M0.47 12A11.53 2.65 0 0 0 23.53 12L17.21 12A5.21 1.2 0 0 1 6.79 12Z" fill="url(#bhmd)"/></svg>',
};

/** Drag data type of a workspace file dragged from a side bar (its absolute path). */
export const FILE_DRAG = "application/x-bh-file";
