// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderChatTab } from '../../src/chat/ui/ChatTab';
import { highlight } from '../../src/chat/ui/highlight';
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
    expect(html).toContain('<pre data-lang="py"><code>x <span class="t-op">&lt;</span> <span class="t-num">1</span></code></pre>');
    expect(html).toContain('<button class="bhc-copy" type="button">Copy</button>');
  });
  it('highlights keywords, strings, comments, calls and literals', () => {
    const py = highlight('def f(x):  # hi\n    return print("a<b", None, 3)', 'python');
    expect(py).toContain('<span class="t-kw">def</span> <span class="t-fn">f</span>(');
    expect(py).toContain('<span class="t-com"># hi</span>');
    expect(py).toContain('<span class="t-str">&quot;a&lt;b&quot;</span>');
    expect(py).toContain('<span class="t-lit">None</span>');
    expect(py).toContain('<span class="t-num">3</span>');
    const ts = highlight('const s = `x` // c\n/* <b> */ new Map<string>()', 'ts');
    expect(ts).toContain('<span class="t-com">// c</span>');
    expect(ts).toContain('<span class="t-com">/* &lt;b&gt; */</span>');
    expect(ts).toContain('<span class="t-type">Map</span>');
    expect(highlight('{"a": "b", "n": 1}', 'json')).toContain('<span class="t-key">&quot;a&quot;</span>');
    expect(highlight('<script>', 'text')).toBe('&lt;script&gt;');
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
  it('gives each model its own conversation', async () => {
    const store = new ChatStore(fakeApi());
    const el = document.createElement('div');
    document.body.append(el);
    renderChatTab(el, store, { modelId: MODELS[0].id });
    await until(() => el.querySelector('.bhc-title')?.textContent === MODELS[0].name);
    const chat = async (text: string) => {
      [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Start model'))!.click();
      await until(() => el.querySelector('.bhc-chip')!.textContent === 'ready');
      el.querySelector('textarea')!.value = text;
      el.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await until(() => !store.state.live && el.querySelectorAll('.bhc-user').length > 0);
    };
    await chat('hi qwen');
    const picker = el.querySelector('select')!;
    picker.value = MODELS[1].id;
    picker.dispatchEvent(new Event('change'));
    await until(() => el.textContent!.includes(`Chat with ${MODELS[1].name}`));
    expect(el.querySelector('.bhc-user')).toBeNull();
    await chat('hi flint');
    expect([...el.querySelectorAll('.bhc-user')].map((u) => u.textContent)).toEqual(['hi flint']);
    picker.value = MODELS[0].id;
    picker.dispatchEvent(new Event('change'));
    await until(() => el.querySelector('.bhc-user')?.textContent === 'hi qwen');
    expect(el.querySelectorAll('.bhc-user').length).toBe(1);
  });
  it('follows the stream, lets go when the user scrolls up, and offers a way back', async () => {
    const store = new ChatStore(fakeApi({ tokenMs: 5 }));
    const el = document.createElement('div');
    document.body.append(el);
    renderChatTab(el, store, { modelId: MODELS[0].id });
    const sc = el.querySelector('.bhc-scroll') as HTMLElement;
    let height = 2000;
    Object.defineProperty(sc, 'scrollHeight', { get: () => height });
    Object.defineProperty(sc, 'clientHeight', { get: () => 500 });
    await until(() => el.querySelector('.bhc-title')?.textContent === MODELS[0].name);
    [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Start model'))!.click();
    await until(() => el.querySelector('.bhc-chip')!.textContent === 'ready');
    el.querySelector('textarea')!.value = 'go';
    el.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // Glides to the bottom over several frames instead of jumping.
    await until(() => sc.scrollTop === 1500);
    const jump = el.querySelector('.bhc-jump') as HTMLElement;
    expect(jump.hidden).toBe(true);
    sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    sc.scrollTop = 800;
    sc.dispatchEvent(new Event('scroll'));
    height = 2600;
    await tick(60);
    expect(sc.scrollTop).toBe(800);
    expect(jump.hidden).toBe(false);
    jump.click();
    await until(() => sc.scrollTop === 2100);
    expect(jump.hidden).toBe(true);
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
