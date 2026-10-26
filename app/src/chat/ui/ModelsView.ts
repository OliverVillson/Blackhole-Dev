import { formatBytes } from '../shared/stats';
import type { LocalModel } from '../shared/types';
import { h } from './dom';
import type { ChatStore } from './store';

const GROUPS: { source: LocalModel['source']; title: string }[] = [
  { source: 'pipeline', title: 'Built by BlackHole' },
  { source: 'download', title: 'Downloaded' },
  { source: 'other', title: 'Other local models' },
];

/** The "Local models" sidebar: every model on this Mac, start/stop, and Hugging Face downloads. */
export function renderModelsView(root: HTMLElement, store: ChatStore, openChat: (modelId: string) => void): () => void {
  root.classList.add('bhc');
  const wrap = h('div.bhc-sb');
  root.replaceChildren(wrap);

  const repo = h('input', { placeholder: 'org/model, e.g. mlx-community/Qwen3-8B-4bit', 'aria-label': 'Hugging Face repo id', spellcheck: false });
  const dlBtn = h('button.bhc-btn.sm', {}, 'Download');
  const dlList = h('div');
  const list = h('div');
  const rescan = h('button.bhc-btn.sm', { title: 'Look for new model folders' }, 'Rescan');

  const renderList = () => {
    list.replaceChildren();
    const st = store.state.server;
    if (!store.state.models.length) {
      list.append(h('div.bhc-hint', {}, `No models found in ${store.state.settings?.modelDirs.join(', ') ?? 'the model folders'}. Finished pipeline runs copied back from the VM appear here.`));
      return;
    }
    for (const g of GROUPS) {
      const ms = store.state.models.filter((m) => m.source === g.source);
      if (!ms.length) continue;
      list.append(h('div.bhc-group.bhc-hd', {}, g.title));
      for (const m of ms) {
        const phase = st.modelId === m.id ? st.phase : 'stopped';
        const row = h(
          'button',
          { class: `bhc-it ${phase === 'ready' ? 'sel' : ''}`, title: `${m.path}\nOpen a chat with this model`, onclick: () => openChat(m.id) },
          h(`span.bhc-dot.${phase}`),
          h('span.nm', {}, m.name),
          m.hex ? h('span.bhc-tag', {}, 'HEX') : m.format === 'gguf' ? h('span.bhc-tag', {}, 'GGUF') : '',
          h('span.sz', {}, formatBytes(m.sizeBytes)),
        );
        list.append(row);
      }
    }
  };

  const renderDownloads = () => {
    dlList.replaceChildren();
    for (const p of Object.values(store.state.downloads)) {
      if (p.phase === 'done' && Date.now() - (p as any).t > 60_000) continue;
      const pct = p.totalBytes ? Math.min(100, (100 * p.doneBytes) / p.totalBytes) : 0;
      const status =
        p.phase === 'downloading'
          ? `${formatBytes(p.doneBytes)} of ${formatBytes(p.totalBytes)} · ${pct.toFixed(0)}%`
          : p.phase === 'waiting-confirm'
            ? `${formatBytes(p.totalBytes)} · waiting for your approval`
            : p.phase === 'error'
              ? p.error ?? 'failed'
              : p.phase;
      dlList.append(
        h(
          'div.bhc-dl',
          {},
          h('div.bhc-row', {}, h('span.nm', { style: 'font-family:var(--f-mono);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis' }, p.repo),
            p.phase === 'downloading' || p.phase === 'listing' || p.phase === 'verifying' ? h('button.bhc-btn.sm.ghost', { onclick: () => store.api.cancelDownload(p.repo) }, 'Cancel') : ''),
          h('div.bhc-bar', {}, h('span', { style: `width:${pct}%` })),
          h('div', { class: p.phase === 'error' ? 'bhc-err' : 'bhc-meta' }, status),
        ),
      );
    }
  };

  const startDownload = () => {
    const r = repo.value.trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
    if (!r) return;
    repo.value = '';
    // The main process asks the confirm gate for anything 1 GB or larger before a byte is written.
    void store.run(() => store.api.download({ repo: r }));
  };
  dlBtn.onclick = startDownload;
  repo.addEventListener('keydown', (e) => e.key === 'Enter' && startDownload());
  rescan.onclick = () => void store.run(() => store.api.rescan());

  wrap.append(
    h('div.bhc-sb-hd', {}, h('span.bhc-hd', {}, 'Local models'), rescan),
    list,
    h('div.bhc-group.bhc-hd', {}, 'Download from Hugging Face'),
    h('div.bhc-dl', {}, repo, h('div.bhc-row', {}, h('span.bhc-meta', { style: 'flex:1' }, 'MLX folders or GGUF. 1 GB and up asks first.'), dlBtn)),
    dlList,
  );

  const unsub = store.subscribe((parts) => {
    if (parts.has('models') || parts.has('server') || parts.has('settings')) renderList();
    if (parts.has('downloads')) {
      for (const p of Object.values(store.state.downloads)) if (p.phase === 'done' && !(p as any).t) (p as any).t = Date.now();
      renderDownloads();
    }
  });
  renderList();
  void store.init();
  return unsub;
}
