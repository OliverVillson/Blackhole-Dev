// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderChatTab } from '../../src/chat/ui/ChatTab';
import { renderMarkdown } from '../../src/chat/ui/markdown';
import { renderModelsView } from '../../src/chat/ui/ModelsView';
import { ChatStore } from '../../src/chat/ui/store';
import { injectStyles } from '../../src/chat/ui/styles';
import { fakeApi, MODELS } from './preview/fakeApi';

globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
globalThis.cancelAnimationFrame ??= (id: number) => clearTimeout(id);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await tick(10);
  expect(f()).toBe(true);
};

describe('markdown', () => {
  it('escapes model output and renders code fences', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **b** `c`\n\n```py\nx < 1\n```');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<pre data-lang="py"><code>x &lt; 1</code></pre>');
  });
});

describe('chat tab', () => {
  it('starts a model, streams a reply with thinking, and shows tok/s', async () => {
    injectStyles();
    const store = new ChatStore(fakeApi());
    const el = document.createElement('div');
    document.body.append(el);
    renderChatTab(el, store, { modelId: MODELS[0].id });
    await until(() => el.querySelector('.bhc-title')?.textContent === 'qwen3.6-blackhole-9.8GB');
    // Wired-limit banner for a 9.8 GB model on the macOS default
    await until(() => el.textContent!.includes('Raise to 12 GB'));

    const start = [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Start model'))!;
    start.click();
    await until(() => el.textContent!.includes('ready'));
    expect(el.textContent).toContain('http://127.0.0.1:8080/v1');

    const input = el.querySelector('textarea')!;
    input.value = 'say hello';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await until(() => !!el.querySelector('.bhc-stats') && el.querySelector('.bhc-stats')!.textContent!.includes('67.8 tok/s'));
    expect(el.querySelector('.bhc-user')!.textContent).toBe('say hello');
    expect(el.querySelector('.bhc-think summary')!.textContent).toMatch(/Thought for \d+ tokens/);
    expect(el.querySelector('pre code')!.textContent).toContain('hello from a 9.8 GB model');
    expect(el.querySelector('.bhc-stats')!.textContent).toContain('prefill 1076 tok/s');
  });
  it('lists models by source in the sidebar and opens a chat on click', async () => {
    const store = new ChatStore(fakeApi());
    const el = document.createElement('div');
    const opened: string[] = [];
    renderModelsView(el, store, (id) => opened.push(id));
    await until(() => el.querySelectorAll('.bhc-it').length === 3);
    expect([...el.querySelectorAll('.bhc-group')].map((g) => g.textContent)).toEqual(['Built by BlackHole', 'Downloaded', 'Download from Hugging Face']);
    expect(el.textContent).toContain('HEX');
    (el.querySelector('.bhc-it') as HTMLElement).click();
    expect(opened).toEqual([MODELS[0].id]);
  });
});
