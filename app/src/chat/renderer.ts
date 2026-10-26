// WS6 local chat, renderer side. The shell calls activate(ctx) at startup (src/modules.ts).
import type { RendererContext } from './shared/ext-shim';
import { formatStats } from './shared/stats';
import { ICONS } from './ui/dom';
import { renderChatTab, type ChatTabState } from './ui/ChatTab';
import { renderModelsView } from './ui/ModelsView';
import { ChatStore, makeApi } from './ui/store';
import { injectStyles } from './ui/styles';

export function activate(ctx: RendererContext): void {
  injectStyles();
  const store = new ChatStore(makeApi(ctx.invoke, ctx.on));
  const openChat = (modelId?: string) => ctx.openTab('chat', { modelId } satisfies ChatTabState);

  ctx.registerActivity({ id: 'chat', title: 'Local chat', icon: ICONS.chat, order: 60 });
  ctx.registerSidebarView('chat', { render: (el) => renderModelsView(el, store, openChat) });
  ctx.registerTabType({
    id: 'chat',
    title: (s: ChatTabState) => `Chat · ${store.model(s?.modelId)?.name ?? 'local model'}`,
    key: (s: ChatTabState) => s?.modelId ?? '',
    render: (el, s: ChatTabState) => renderChatTab(el, store, s ?? {}),
  });
  ctx.registerCommand({ id: 'chat.open', title: 'Chat: Open local chat', run: (id?: string) => openChat(id) });
  ctx.registerCommand({ id: 'chat.stopServer', title: 'Chat: Stop the local model server', run: () => store.stop() });

  const status = ctx.registerStatusItem({ id: 'chat', side: 'right', text: 'Local: off', title: 'Local model server', command: 'chat.open' });
  let lastRate = '';
  store.subscribe((parts) => {
    if (!parts.has('server') && !parts.has('messages')) return;
    const st = store.state.server;
    const name = store.model(st.modelId)?.name ?? '';
    const last = [...store.state.messages].reverse().find((m) => m.stats);
    if (last?.stats) lastRate = formatStats(last.stats).split(' · ')[0];
    const text =
      st.phase === 'ready' ? `Local: ${name}${lastRate ? ` · ${lastRate}` : ''}` : st.phase === 'starting' ? `Local: loading ${name}…` : st.phase === 'crashed' ? 'Local: error' : 'Local: off';
    status.update(text);
  });
  void store.init();
}
