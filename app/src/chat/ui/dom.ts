type Attrs = Record<string, string | number | boolean | undefined | ((e: any) => void)>;

/** Tiny element builder: h('button.btn.pri', { onclick }, 'Send'). Strings are text, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}`, attrs: Attrs = {}, ...kids: (Node | string | false | undefined | null)[]): HTMLElementTagNameMap[K] {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') (el as any)[k] = v;
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== undefined && c !== null && c !== false) el.append(c);
  return el;
}

export const ICONS = {
  chat: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"></path><path d="M8 9h8M8 12h5"></path></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"></path></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>',
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>',
};

export function svg(markup: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'bhc-ico';
  s.innerHTML = markup; // constant markup from ICONS only
  return s;
}
