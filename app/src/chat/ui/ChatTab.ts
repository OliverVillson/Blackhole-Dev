import { formatBytes, formatStats, splitOrphanThink } from '../shared/stats';
import type { ChatMessage, ChatStats, LocalModel } from '../shared/types';
import { h, ICONS, svg } from './dom';
import { renderMarkdown } from './markdown';
import type { ChatStore } from './store';

const PHASE_TEXT = { stopped: 'stopped', starting: 'loading model…', ready: 'ready', stopping: 'stopping…', crashed: 'stopped with an error' };

const LOGO = [
  '      .  -~~~~~-  .      ',
  '   .~   .-===-.   ~.   ',
  '  (    ( ●     )    )  ',
  '   `~.  `-===-\'  .~`   ',
  "      '  -~~~~~-  '      ",
].join('\n');

function statsLine(s: ChatStats, extra?: string): HTMLElement {
  const el = h('div.bhc-stats');
  const [rate, ...rest] = formatStats(s).split(' · ');
  el.append(h('span', { class: s.genTokS >= 40 ? 'fast' : '' }, rate), ` · ${rest.join(' · ')}`);
  if (s.counted === 'chunks') el.title = 'Token counts are stream chunks; the server did not report usage.';
  if (extra) el.append(` · ${extra}`);
  return el;
}

function thinking(reasoning: string, tokens: number | undefined, open: boolean, live: boolean): HTMLElement {
  const d = h('details.bhc-think', { open });
  const label = live ? `Thinking… ${tokens ?? ''}${tokens ? ' tokens' : ''}` : `Thought for ${tokens ? `${tokens.toLocaleString()} tokens` : 'a while'}`;
  d.append(h('summary', {}, label), h('div', {}, reasoning.trim()));
  return d;
}

function assistant(m: ChatMessage): HTMLElement {
  const el = h('div.bhc-ai');
  if (m.reasoning) el.append(thinking(m.reasoning, m.stats?.reasoningTokens, false, false));
  const body = h('div');
  body.innerHTML = renderMarkdown(m.content); // renderMarkdown escapes all model text
  el.append(body);
  if (m.stopped) el.append(h('div.bhc-note', {}, 'Stopped.'));
  if (m.error) el.append(h('div.bhc-err', {}, m.error));
  if (m.stats) el.append(statsLine(m.stats));
  return el;
}

export interface ChatTabState {
  modelId?: string;
}

export function renderChatTab(root: HTMLElement, store: ChatStore, tabState: ChatTabState = {}): () => void {
  root.classList.add('bhc');
  const wrap = h('div.bhc-tab');
  root.replaceChildren(wrap);

  // ---- top bar
  const title = h('span.bhc-title');
  const picker = h('select', { 'aria-label': 'Model' });
  const phaseChip = h('span.bhc-chip');
  const startBtn = h('button.bhc-btn.pri');
  const gearBtn = h('button.bhc-btn.ghost', { 'aria-label': 'Chat settings', title: 'Settings and server log' }, svg(ICONS.gear));
  const top = h('div.bhc-top', {}, title, picker, phaseChip, h('span.bhc-sp'), startBtn, gearBtn);

  const banners = h('div');
  const scroll = h('div.bhc-scroll');
  const col = h('div.bhc-col');
  scroll.append(col);
  const side = h('aside.bhc-side', { hidden: true });
  const body = h('div.bhc-body', {}, scroll, side);

  // ---- composer
  const input = h('textarea', { rows: 1, placeholder: 'Message the model. Enter sends, Shift+Enter adds a line.', 'aria-label': 'Message' });
  const sendBtn = h('button.bhc-btn.pri', {}, 'Send');
  const clearBtn = h('button.bhc-btn.ghost', {}, 'New chat');
  const meta = h('span.bhc-meta');
  const live = h('span.bhc-live');
  const comp = h('div.bhc-comp', {}, h('div.bhc-col', {}, input, h('div.bhc-row', {}, meta, h('span.bhc-sp'), live, clearBtn, sendBtn)));
  wrap.append(top, banners, body, comp);

  let selected = tabState.modelId ?? store.state.server.modelId;
  let liveEl: { box: HTMLElement; think?: HTMLDetailsElement; thinkBody?: HTMLElement; text: HTMLElement; stats: HTMLElement } | undefined;
  let atBottom = true;
  scroll.addEventListener('scroll', () => {
    atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  });
  const stick = () => {
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  };

  const current = (): LocalModel | undefined => store.model(selected) ?? store.state.models[0];
  const serving = () => store.state.server.phase === 'ready' && store.state.server.modelId === current()?.id;

  // ---- renderers
  const renderTop = () => {
    const st = store.state.server;
    const m = current();
    title.textContent = m?.name ?? 'Local chat';
    picker.replaceChildren(
      ...store.state.models.map((x) => h('option', { value: x.id, selected: x.id === m?.id }, `${x.name} · ${formatBytes(x.sizeBytes)}${x.hex ? ' · HEX' : ''}`)),
    );
    picker.disabled = !store.state.models.length || st.phase === 'starting';
    const mine = st.modelId === m?.id || st.phase === 'stopped';
    const phase = mine ? st.phase : 'stopped';
    phaseChip.replaceChildren(h(`span.bhc-dot.${phase}`), mine ? PHASE_TEXT[phase] : `serving ${store.model(st.modelId)?.name ?? 'another model'}`);
    const running = serving() || (mine && st.phase === 'starting');
    startBtn.replaceChildren(svg(running ? ICONS.stop : ICONS.play), running ? 'Stop model' : 'Start model');
    startBtn.className = `bhc-btn ${running ? '' : 'pri'}`;
    startBtn.disabled = !m || st.phase === 'stopping';
    meta.textContent = st.phase === 'ready' && st.baseUrl ? `${st.baseUrl} · OpenAI-compatible, also usable by the copilot` : m ? `${m.format.toUpperCase()} · ${m.arch ?? 'unknown arch'}${m.bits ? ` · ${m.bits}-bit` : ''}` : '';
    sendBtn.disabled = !serving() && !store.state.live;
  };

  const renderBanners = () => {
    banners.replaceChildren();
    const st = store.state.server;
    const w = store.state.wired;
    const m = current();
    if (st.phase === 'crashed' && st.modelId === m?.id && st.error) {
      banners.append(
        h(
          'div.bhc-banner.bad',
          {},
          h('div', {}, h('b', {}, st.error), h('div.bhc-sub', {}, st.hint ?? '')),
          h('div.bhc-acts', {}, h('button.bhc-btn.sm', { onclick: () => openSide('log') }, 'Server log')),
        ),
      );
    }
    if (w?.supported && !w.ok && m?.format === 'mlx' && !store.state.settings?.server.externalBaseUrl) {
      const cur = w.currentMb ? `${(w.currentMb / 1024).toFixed(1)} GB` : 'the macOS default';
      const rec = w.recommendedMb ?? 0;
      banners.append(
        h(
          'div.bhc-banner',
          {},
          h(
            'div',
            {},
            h('b', {}, `The GPU may only wire ${cur} of memory; ${m.name} is ${formatBytes(m.sizeBytes)}.`),
            h('div.bhc-sub', {}, `Raising the limit to ${(rec / 1024).toFixed(0)} GB keeps the model in GPU memory instead of paging. macOS asks for your password; it resets on reboot.`),
          ),
          h('div.bhc-acts', {}, h('button.bhc-btn.sm', { onclick: () => store.run(async () => ((store.state.wired = await store.api.setWired(rec)), store.changed('wired'))) }, `Raise to ${(rec / 1024).toFixed(0)} GB`)),
        ),
      );
    }
    if (store.state.error) banners.append(h('div.bhc-banner.bad', {}, h('b', {}, store.state.error)));
  };

  const renderMessages = () => {
    col.replaceChildren();
    liveEl = undefined;
    const msgs = store.state.messages;
    if (!msgs.length && !store.state.pending) {
      const m = current();
      col.append(
        h(
          'div.bhc-empty',
          {},
          h('pre', { 'aria-hidden': 'true' }, LOGO),
          h('b', {}, m ? `Chat with ${m.name}` : 'No local models yet'),
          m
            ? serving()
              ? 'The model is loaded. Ask it anything; replies stream with live tokens per second.'
              : 'Start the model to load it into memory. The first load reads the whole model from disk and can take a few minutes.'
            : 'Copy a finished model back from your VM, or download one from Hugging Face in the Local models sidebar.',
        ),
      );
      return;
    }
    for (const m of msgs) col.append(m.role === 'user' ? h('div.bhc-user', {}, m.content) : m.role === 'assistant' ? assistant(m) : '');
    if (store.state.pending) {
      col.append(h('div.bhc-user', {}, store.state.pending));
      const text = h('div');
      const stats = h('div.bhc-stats');
      const box = h('div.bhc-ai', {}, text, stats);
      col.append(box);
      liveEl = { box, text, stats };
      renderLive();
    }
    stick();
  };

  let raf = 0;
  const renderLive = () => {
    const lv = store.state.live;
    if (!lv || !liveEl) return;
    const { content, reasoning } = splitOrphanThink(lv.content, lv.reasoning);
    if (reasoning && !liveEl.think) {
      liveEl.think = thinking('', undefined, true, true) as HTMLDetailsElement;
      liveEl.thinkBody = liveEl.think.querySelector('div')!;
      liveEl.box.prepend(liveEl.think);
    }
    if (liveEl.think && liveEl.thinkBody) {
      liveEl.thinkBody.textContent = reasoning;
      liveEl.thinkBody.scrollTop = liveEl.thinkBody.scrollHeight;
      const sum = liveEl.think.querySelector('summary')!;
      const r = lv.meter.result().reasoningTokens;
      if (content) {
        sum.textContent = `Thought for ${r.toLocaleString()} tokens`;
        if (liveEl.think.open && !liveEl.think.dataset.touched) liveEl.think.open = false;
      } else sum.textContent = `Thinking… ${r.toLocaleString()} tokens`;
    }
    liveEl.text.innerHTML = renderMarkdown(content);
    liveEl.text.append(h('span.bhc-cur'));
    const rate = lv.meter.liveTokS();
    const n = lv.meter.result().completionTokens;
    liveEl.stats.textContent = n ? `${rate.toFixed(1)} tok/s · ${n} tokens` : 'reading the prompt…';
    live.textContent = n ? `${rate.toFixed(1)} tok/s` : '';
    stick();
  };

  const renderComposer = () => {
    const busy = Boolean(store.state.live);
    sendBtn.textContent = busy ? 'Stop' : 'Send';
    sendBtn.className = `bhc-btn ${busy ? '' : 'pri'}`;
    sendBtn.disabled = !busy && !serving();
    clearBtn.disabled = busy || !store.state.messages.length;
    if (!busy) live.textContent = '';
    input.placeholder = serving() ? 'Message the model. Enter sends, Shift+Enter adds a line.' : 'Start the model to chat.';
  };

  // ---- side drawer: settings + log
  let sideMode: 'settings' | 'log' | undefined;
  const openSide = (mode: 'settings' | 'log') => {
    sideMode = sideMode === mode ? undefined : mode;
    side.hidden = !sideMode;
    renderSide();
  };
  const field = (label: string, el: HTMLElement, check = false) => h(check ? 'label.bhc-field.bhc-check' : 'label.bhc-field', {}, ...(check ? [el, label] : [label, el]));
  const renderSide = () => {
    if (!sideMode) return;
    const s = store.state.settings;
    const tabs = h(
      'div.bhc-row',
      {},
      h('button', { class: `bhc-btn sm ${sideMode === 'settings' ? 'pri' : ''}`, onclick: () => ((sideMode = 'settings'), renderSide()) }, 'Settings'),
      h('button', { class: `bhc-btn sm ${sideMode === 'log' ? 'pri' : ''}`, onclick: () => ((sideMode = 'log'), renderSide()) }, 'Server log'),
      h('span.bhc-sp'),
      h('button.bhc-btn.sm.ghost', { 'aria-label': 'Close', onclick: () => openSide(sideMode!) }, '✕'),
    );
    if (sideMode === 'log') {
      const pre = h('pre.bhc-log', {}, store.state.logs.join('\n') || 'No server output yet.');
      side.replaceChildren(tabs, ...(store.state.server.command ? [h('div.bhc-hd', {}, 'Command'), h('div.bhc-cmd', {}, store.state.server.command)] : []), h('div.bhc-hd', {}, 'Output'), pre);
      pre.scrollTop = pre.scrollHeight;
      return;
    }
    if (!s) return;
    const g = s.generation;
    const sv = s.server;
    const num = (v: number, step = 1) => h('input', { type: 'number', value: v, step });
    const maxT = num(g.maxTokens, 1024);
    const temp = num(g.temperature, 0.05);
    const topP = num(g.topP, 0.05);
    const think = h('input', { type: 'checkbox', checked: g.thinking });
    const sys = h('textarea', { rows: 3, placeholder: 'Optional system prompt' });
    sys.value = g.systemPrompt;
    const exe = h('input', { value: sv.executable, placeholder: 'auto: ~/mlx-venv/bin/mlx_lm.server' });
    const port = num(sv.port);
    const trc = h('input', { type: 'checkbox', checked: sv.trustRemoteCode });
    const conc = num(sv.promptConcurrency);
    const pre = num(sv.prefillStepSize, 128);
    const cache = num(sv.promptCacheSize);
    const ext = h('input', { value: sv.externalBaseUrl, placeholder: 'e.g. http://127.0.0.1:11434/v1 for Ollama' });
    const env = h('input', { value: Object.entries(sv.env).map(([k, v]) => `${k}=${v}`).join(' '), placeholder: 'BLACKHOLE_HEX_PROMPT=matvec' });
    const save = h('button.bhc-btn.pri', {
      onclick: () =>
        store.saveSettings({
          generation: { maxTokens: +maxT.value, temperature: +temp.value, topP: +topP.value, thinking: think.checked, systemPrompt: sys.value },
          server: {
            executable: exe.value.trim(),
            port: +port.value,
            trustRemoteCode: trc.checked,
            promptConcurrency: +conc.value,
            prefillStepSize: +pre.value,
            promptCacheSize: +cache.value,
            externalBaseUrl: ext.value.trim(),
            env: Object.fromEntries(env.value.split(/\s+/).filter((x) => x.includes('=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])),
          },
        }),
    }, 'Save');
    side.replaceChildren(
      tabs,
      h('div.bhc-hd', {}, 'Replies'),
      field('Max tokens (thinking included)', maxT),
      field('Temperature', temp),
      field('Top-p', topP),
      field('Let the model think first', think, true),
      field('System prompt', sys),
      h('div.bhc-hd', {}, 'Server'),
      field('mlx_lm.server or python executable', exe),
      field('Port', port),
      field('Trust remote code', trc, true),
      field('Prompt concurrency', conc),
      field('Prefill step size', pre),
      field('Prompt cache size', cache),
      field('Environment', env),
      field('External server instead (llama.cpp, Ollama)', ext),
      h('div.bhc-meta', {}, 'Server changes apply the next time a model starts. The defaults are the settings measured on a 16 GB M5.'),
      h('div.bhc-row', {}, save),
    );
  };

  // ---- actions
  startBtn.onclick = () => {
    const m = current();
    if (!m) return;
    if (serving() || (store.state.server.phase === 'starting' && store.state.server.modelId === m.id)) void store.stop();
    else void store.start(m.id);
  };
  gearBtn.onclick = () => openSide('settings');
  picker.onchange = () => {
    selected = picker.value;
    tabState.modelId = selected;
    renderAll();
    void store.refreshWired();
  };
  const submit = () => {
    if (store.state.live) return void store.abort();
    const t = input.value;
    if (!t.trim() || !serving()) return;
    input.value = '';
    input.style.height = '';
    atBottom = true;
    void store.send(t);
  };
  sendBtn.onclick = submit;
  clearBtn.onclick = () => void store.clear();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  });
  // A thinking block the user opened or closed by hand is left alone when the answer starts.
  col.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest('summary')?.parentElement;
    if (d) d.dataset.touched = '1';
  });

  const renderAll = () => {
    renderTop();
    renderBanners();
    renderMessages();
    renderComposer();
    renderSide();
  };
  const unsub = store.subscribe((parts) => {
    if (parts.has('live') && parts.size === 1) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderLive);
      return;
    }
    if (parts.has('server') || parts.has('models')) renderTop();
    if (parts.has('server') || parts.has('wired') || parts.has('error') || parts.has('models') || parts.has('settings')) renderBanners();
    if (parts.has('messages') || (parts.has('live') && !liveEl)) renderMessages();
    if (parts.has('messages') || parts.has('live') || parts.has('server')) renderComposer();
    if ((parts.has('logs') && sideMode === 'log') || (parts.has('settings') && sideMode === 'settings') || (parts.has('server') && sideMode === 'log')) renderSide();
  });
  renderAll();
  void store.init().then(() => {
    if (!selected) selected = store.state.server.modelId ?? store.state.models[0]?.id;
    renderAll();
  });
  return () => {
    cancelAnimationFrame(raf);
    unsub();
  };
}
