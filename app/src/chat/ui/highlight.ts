// A small syntax highlighter for code blocks in chat replies. One regex pass per block, by
// language family; every piece of source is escaped, so model output still cannot inject markup.
import { escapeHtml } from './markdown';

type Family = 'c' | 'hash' | 'json' | 'sql' | 'plain';

const FAMILY: Record<string, Family> = {
  py: 'hash', python: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', shell: 'hash', console: 'hash', toml: 'hash', yaml: 'hash', yml: 'hash', rb: 'hash', ruby: 'hash', r: 'hash', dockerfile: 'hash', make: 'hash', makefile: 'hash',
  js: 'c', javascript: 'c', jsx: 'c', ts: 'c', typescript: 'c', tsx: 'c', c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cuda: 'c', cu: 'c', metal: 'c', java: 'c', kotlin: 'c', swift: 'c', go: 'c', rust: 'c', rs: 'c', cs: 'c', csharp: 'c', php: 'c', scala: 'c', zig: 'c', css: 'c', triton: 'hash',
  json: 'json', jsonc: 'c', sql: 'sql', lua: 'sql', text: 'plain', txt: 'plain', plaintext: 'plain', md: 'plain', markdown: 'plain', diff: 'plain',
};

const KEYWORDS = new Set(
  (
    'if else elif for while do break continue return yield def class import from as with try except finally raise ' +
    'lambda pass global nonlocal assert del in is not and or async await match case switch default function const let var ' +
    'new delete typeof instanceof void this self super extends implements interface type enum export public private protected ' +
    'static readonly abstract struct union typedef namespace using template typename fn mut pub impl trait mod use crate ' +
    'where loop unsafe move ref go chan select defer package func range throw throws catch goto sizeof inline extern ' +
    'register volatile constexpr auto then fi done esac local echo exit export unset source alias kernel device ' +
    'select insert update delete create table into values set where join left right inner outer on group by order having limit end'
  ).split(' '),
);
const LITERALS = new Set('true false True False None null nil undefined NaN Infinity nullptr'.split(' '));

const STR = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\x60(?:\\.|[^\x60\\])*\x60?`;
const NUM = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

function pattern(f: Family): RegExp {
  const com = f === 'hash' ? String.raw`#.*` : f === 'c' ? String.raw`\/\/.*|\/\*[\s\S]*?(?:\*\/|$)` : f === 'sql' ? String.raw`--.*` : '(?!)';
  const deco = f === 'hash' || f === 'c' ? String.raw`@[\w.]+` : '(?!)';
  return new RegExp(`(?<com>${com})|(?<str>${STR})|(?<deco>${deco})|(?<num>${NUM})|(?<id>${IDENT})(?<call>\\s*\\()?|(?<op>[-+*/%=<>!&|^~?:]+)`, 'g');
}
const PATTERNS = new Map<Family, RegExp>();

/** Returns highlighted HTML for one code block. Unknown languages get the C-like rules. */
export function highlight(code: string, lang = ''): string {
  const f: Family = FAMILY[lang.toLowerCase()] ?? (lang ? 'c' : guess(code));
  if (f === 'plain') return escapeHtml(code);
  let re = PATTERNS.get(f);
  if (!re) PATTERNS.set(f, (re = pattern(f)));
  const json = f === 'json';
  let out = '';
  let at = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out += escapeHtml(code.slice(at, m.index));
    at = m.index + m[0].length;
    const g = m.groups!;
    let cls = '';
    let text = m[0];
    if (g.com) cls = 'com';
    else if (g.str) cls = json && /^\s*:/.test(code.slice(at)) ? 'key' : 'str';
    else if (g.deco) cls = 'deco';
    else if (g.num) cls = 'num';
    else if (g.id) {
      text = g.id;
      at = m.index + g.id.length; // leave the "(" for the next pass
      cls = LITERALS.has(g.id) ? 'lit' : KEYWORDS.has(g.id) && !json ? 'kw' : g.call ? 'fn' : /^[A-Z][a-z]/.test(g.id) ? 'type' : '';
    } else if (g.op) cls = 'op';
    out += cls ? `<span class="t-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
  }
  return out + escapeHtml(code.slice(at));
}

function guess(code: string): Family {
  if (/^\s*[{[]/.test(code) && /"\s*:/.test(code)) return 'json';
  if (/^\s*(#|def |import |from \S+ import|\$ )/m.test(code)) return 'hash';
  return 'c';
}
