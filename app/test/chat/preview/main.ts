// Standalone preview of the chat feature inside a stand-in of the shell frame, for screenshots.
import { renderChatTab } from '../../../src/chat/ui/ChatTab';
import { ICONS } from '../../../src/chat/ui/dom';
import { renderModelsView } from '../../../src/chat/ui/ModelsView';
import { ChatStore } from '../../../src/chat/ui/store';
import { injectStyles } from '../../../src/chat/ui/styles';
import { fakeApi, MODELS } from './fakeApi';

injectStyles();
const store = new ChatStore(
  fakeApi({
    tokenMs: 8,
    think: 'They want the median of a stream. Two heaps: a max-heap for the lower half, a min-heap for the upper half, rebalance so sizes differ by at most one.',
    reply:
      'Use two heaps so each insert is **O(log n)** and the median is **O(1)**:\n\n```python\nimport heapq\n\nclass RunningMedian:\n    def __init__(self):\n        self.lo, self.hi = [], []  # max-heap (negated), min-heap\n\n    def add(self, x: float) -> None:\n        heapq.heappush(self.lo, -x)\n        heapq.heappush(self.hi, -heapq.heappop(self.lo))\n        if len(self.hi) > len(self.lo):\n            heapq.heappush(self.lo, -heapq.heappop(self.hi))\n\n    def median(self) -> float:\n        if len(self.lo) > len(self.hi):\n            return -self.lo[0]\n        return (-self.lo[0] + self.hi[0]) / 2\n```\n\nThe lower heap always holds the extra element, so `median()` never scans.',
  }),
);
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="sh-top"><span class="sh-logo">BLACKHOLE<b>//</b>DEV</span><nav>File Edit Recipe Run View Help</nav><span class="sh-sp"></span><span class="sh-chip">b300-nebius</span></header>
<div class="sh-mid">
  <aside class="sh-act">
    ${['M6 3h8l4 4v14H6z', 'M15 4c-3 0-4 1.5-4.5 4L8 20', 'M12 3l9 5-9 5-9-5z', 'M3 12h4l3-7 4 14 3-7h4', 'M12 3v6M12 15v6M3 12h6M15 12h6'].map((d) => `<span><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="${d}"/></svg></span>`).join('')}
    <span class="on">${ICONS.chat}</span>
  </aside>
  <section class="sh-side" id="side"></section>
  <main class="sh-main"><div class="sh-tabs"><div>qwen-mac-hex.py</div><div class="on">Chat · qwen3.6-blackhole-9.8GB</div></div><div id="tab" class="sh-tab"></div></main>
</div>
<footer class="sh-foot"><span>⎇ main</span><span>recipe lint ✓</span><span class="sh-sp"></span><span id="st">Local: off</span><span>Copilot: Claude · key set</span></footer>`;
renderModelsView(document.getElementById('side')!, store, () => {});
renderChatTab(document.getElementById('tab')!, store, { modelId: MODELS[0].id });
store.subscribe(() => {
  const s = store.state.server;
  document.getElementById('st')!.textContent = s.phase === 'ready' ? `Local: ${store.model()?.name} · 67.8 tok/s` : 'Local: off';
});
(window as any).demo = async (mode: string) => {
  await store.init();
  if (mode === 'empty') return;
  await store.start(MODELS[0].id);
  if (mode === 'ready') return;
  store.state.wired = { supported: true, currentMb: 12288, recommendedMb: 12288, totalMb: 16384, ok: true };
  store.changed('wired');
  const p = store.send('Write a running median class for a stream of numbers.');
  if (mode === 'streaming') return;
  await p;
};
