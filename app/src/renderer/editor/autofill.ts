// Recipe language support in Monaco: completions as you type (recipe API, function and stage
// names with their args, queries, models, snippets) plus Jedi for generic Python, signature
// help, hovers, lint quick fixes, and the Tab autofill. The recipe answers come from lang.ts
// and the helper's lang.catalog; Jedi answers come from the helper and are skipped when slow.

import * as monaco from "monaco-editor";
import type { Catalog, JediItem, JediSignature } from "../../shared/lang";
import { RECIPE_API, candidates, contextAt, midWord, wordsIn, type Candidate, type CandKind } from "./complete";
import { complete, fixesFor, hover, signature, type Item, type ItemKind } from "./lang";

export interface LangBackend {
  complete(p: { text: string; line: number; col: number; path?: string }): Promise<{ items: JediItem[] }>;
  signatures(p: { text: string; line: number; col: number; path?: string }): Promise<{ signatures: JediSignature[] }>;
  hover(p: { text: string; line: number; col: number; path?: string }): Promise<{ contents: { signature: string; doc: string }[] }>;
}

/** Jedi answers later than this are dropped (the recipe answers show on their own). */
const JEDI_MS = 600;

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export class CompletionSource {
  catalog: Catalog | null = null;
  backend: LangBackend | null = null;
  private functions: Candidate[] = [];
  private wordCache = new WeakMap<monaco.editor.ITextModel, { version: number; words: Set<string> }>();

  setFunctions(fns: { name: string; per?: string; origin?: string; doc?: string }[]): void {
    this.functions = fns.map((f) => ({ label: f.name, kind: "function", detail: `${f.origin === "builtin" ? "built-in" : "my"} function${f.per ? ` · ${f.per}` : ""}` }));
  }

  setCatalog(c: Catalog | null): void {
    this.catalog = c;
  }

  private words(): Candidate[] {
    const out = new Set<string>();
    for (const m of monaco.editor.getModels()) {
      let c = this.wordCache.get(m);
      if (!c || c.version !== m.getVersionId()) {
        c = { version: m.getVersionId(), words: wordsIn(m.getValue()) };
        this.wordCache.set(m, c);
      }
      c.words.forEach((w) => out.add(w));
    }
    return [...out].map((w) => ({ label: w, kind: "word" }));
  }

  pool(): Candidate[] {
    return [...RECIPE_API, ...this.functions, ...this.words()];
  }

  /** Words, keywords and (without a catalog) the old name table, for the cursor's word. */
  basic(model: monaco.editor.ITextModel, pos: monaco.IPosition) {
    const line = model.getLineContent(pos.lineNumber);
    const ctx = contextAt(line, pos.column);
    const pool = this.catalog ? this.pool().filter((c) => c.kind === "keyword" || c.kind === "word") : this.pool();
    return { ctx, items: candidates(ctx, pool) };
  }

  /** What the recipe API offers at the cursor. */
  recipe(model: monaco.editor.ITextModel, pos: monaco.IPosition) {
    return complete(model.getValue(), model.getOffsetAt(pos), this.catalog);
  }

  /** True when Tab has something to complete (else it indents). */
  has(model: monaco.editor.ITextModel, pos: monaco.IPosition): boolean {
    const r = this.recipe(model, pos);
    // in a string an empty prefix still completes; in code Tab right after "(" indents
    if (r.items.length && (r.prefix || !r.generic)) return true;
    return this.basic(model, pos).items.length > 0;
  }
}

const KIND: Record<CandKind, monaco.languages.CompletionItemKind> = {
  api: monaco.languages.CompletionItemKind.Class,
  function: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  word: monaco.languages.CompletionItemKind.Text,
};

const K = monaco.languages.CompletionItemKind;
const ITEM_KIND: Record<ItemKind | string, monaco.languages.CompletionItemKind> = {
  function: K.Function, method: K.Method, class: K.Class, module: K.Module, property: K.Property, variable: K.Variable,
  keyword: K.Keyword, value: K.Value, snippet: K.Snippet, text: K.Text, enum: K.EnumMember, field: K.Field, constant: K.Constant,
  instance: K.Variable, statement: K.Variable, param: K.Variable, path: K.File, file: K.File,
};

/** Characters that open a list of keyword arguments or values, not of words. */
const OPENERS = new Set(["(", ",", " ", "["]);

function pyPos(model: monaco.editor.ITextModel, pos: monaco.IPosition) {
  const uri = model.uri;
  return { text: model.getValue(), line: pos.lineNumber, col: pos.column - 1, path: uri.scheme === "file" ? uri.fsPath : undefined };
}

let installed = false;

export function installCompletion(src: CompletionSource): void {
  if (installed) return;
  installed = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", '"', "'", "(", ",", "[", " "],
    async provideCompletionItems(model, pos, context, token) {
      const range = (back: number) => ({ startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: Math.max(1, pos.column - back), endColumn: pos.column });
      const r = src.recipe(model, pos);
      const out: monaco.languages.CompletionItem[] = r.items.map((it: Item, i) => ({
        label: it.label,
        kind: ITEM_KIND[it.kind] ?? K.Text,
        detail: it.detail,
        documentation: it.doc ? { value: it.doc } : undefined,
        insertText: it.insert ?? it.label,
        insertTextRules: it.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        filterText: it.filter,
        range: range(it.replace),
        sortText: `${it.rank}${String(i).padStart(4, "0")}`,
      }));
      const trig = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
      if (!src.catalog) {
        // an older helper: the name table and the words in open files
        const { ctx, items } = src.basic(model, pos);
        if (trig && OPENERS.has(trig)) return { suggestions: [] };
        return { suggestions: items.map((c, i) => ({ label: c.label, kind: KIND[c.kind], detail: c.detail, insertText: c.insert ?? c.label, range: range(pos.column - ctx.startCol), sortText: `5${String(i).padStart(4, "0")}` })) };
      }
      if (!r.generic || (trig && OPENERS.has(trig))) return { suggestions: out, incomplete: false };
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const afterDot = /\.\s*[A-Za-z_]*$/.test(line);
      if (!r.prefix && !afterDot) return { suggestions: out };
      const seen = new Set(r.items.map((i) => i.label.replace(/=$/, "")));
      const jedi = src.backend && src.catalog.jedi ? await within(src.backend.complete(pyPos(model, pos)), JEDI_MS) : null;
      if (token.isCancellationRequested) return { suggestions: out };
      jedi?.items.forEach((j, i) => {
        if (seen.has(j.label)) return;
        seen.add(j.label);
        out.push({ label: j.label, kind: ITEM_KIND[j.kind] ?? K.Text, detail: j.detail, insertText: j.label, range: range(r.prefix.length), sortText: `3${String(i).padStart(4, "0")}` });
      });
      if (!afterDot || !jedi) {
        const { items } = src.basic(model, pos);
        items.forEach((c, i) => {
          if (seen.has(c.label)) return;
          seen.add(c.label);
          out.push({ label: c.label, kind: KIND[c.kind], detail: c.detail, insertText: c.label, range: range(r.prefix.length), sortText: `${c.kind === "keyword" ? 4 : 6}${String(i).padStart(4, "0")}` });
        });
      }
      return { suggestions: out };
    },
  });

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [",", "=", " "],
    async provideSignatureHelp(model, pos) {
      const s = signature(model.getValue(), model.getOffsetAt(pos), src.catalog);
      const wrap = (signatures: monaco.languages.SignatureInformation[], active: number) => ({ value: { signatures, activeSignature: 0, activeParameter: active }, dispose() {} });
      if (s) return wrap([{ label: s.label, documentation: { value: s.doc }, parameters: s.params.map((p) => ({ label: p.label, documentation: p.doc ? { value: p.doc } : undefined })) }], s.active);
      if (!src.backend || !src.catalog?.jedi) return null;
      const j = await within(src.backend.signatures(pyPos(model, pos)), 1200);
      if (!j?.signatures.length) return null;
      return wrap(j.signatures.map((x) => ({ label: x.label, documentation: { value: x.doc }, parameters: x.params.map((p) => ({ label: p })) })), j.signatures[0].active ?? -1);
    },
  });

  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, pos) {
      const offset = model.getOffsetAt(pos);
      const h = hover(model.getValue(), offset, src.catalog);
      if (h) {
        const a = model.getPositionAt(h.start), b = model.getPositionAt(h.end);
        return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), contents: [{ value: h.md }] };
      }
      const w = model.getWordAtPosition(pos);
      if (!w || !src.backend || !src.catalog?.jedi) return null;
      const j = await within(src.backend.hover(pyPos(model, { lineNumber: pos.lineNumber, column: w.startColumn })), 1500);
      if (!j?.contents.length) return null;
      return {
        range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn),
        contents: j.contents.flatMap((c) => [{ value: "```python\n" + c.signature + "\n```" }, ...(c.doc ? [{ value: c.doc.replace(/\n(?!\n)/g, "  \n") }] : [])]),
      };
    },
  });

  monaco.languages.registerCodeActionProvider("python", {
    provideCodeActions(model, _range, context) {
      const actions: monaco.languages.CodeAction[] = [];
      for (const m of context.markers) {
        if (m.source !== "blackhole") continue;
        const r = new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn);
        const bad = model.getValueInRange(r);
        const quoted = /^(["']).*\1$/.test(bad);
        const core = quoted ? bad.slice(1, -1) : bad;
        if (!core || core.includes("\n")) continue;
        for (const fix of fixesFor(m.message, src.catalog, core)) {
          const text = quoted ? bad[0] + fix + bad[0] : fix;
          actions.push({ title: `Change to ${fix}`, kind: "quickfix", diagnostics: [m], isPreferred: actions.length === 0, edit: { edits: [{ resource: model.uri, textEdit: { range: r, text }, versionId: model.getVersionId() }] } });
        }
      }
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerDocumentSymbolProvider("python", {
    provideDocumentSymbols(model) {
      const out: monaco.languages.DocumentSymbol[] = [];
      const lines = model.getLinesContent();
      lines.forEach((text, i) => {
        const m = /^(\s*)(def|class)\s+([A-Za-z_]\w*)/.exec(text) ?? /^()([A-Za-z_]\w*)\s*=\s*(?:recipe\.)?(step|fn|input|Recipe)\(/.exec(text);
        if (!m) return;
        const isDef = m[2] === "def" || m[2] === "class";
        const name = isDef ? m[3] : m[2];
        const r = { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: text.length + 1 };
        out.push({
          name,
          detail: isDef ? m[2] : `recipe.${m[3]}`,
          kind: m[2] === "class" ? monaco.languages.SymbolKind.Class : isDef ? monaco.languages.SymbolKind.Function : monaco.languages.SymbolKind.Variable,
          range: r,
          selectionRange: r,
          tags: [],
        });
      });
      return out;
    },
  });
}

// Monaco shares one keybinding service across editors, so the Tab command is registered on one
// owner editor and acts on whichever editor has focus. If the owner closes, another takes over.
const editors = new Set<monaco.editor.IStandaloneCodeEditor>();
let owner: monaco.editor.IStandaloneCodeEditor | null = null;

export function bindTabAutofill(editor: monaco.editor.IStandaloneCodeEditor, src: CompletionSource): void {
  editors.add(editor);
  editor.onDidDispose(() => {
    editors.delete(editor);
    if (owner === editor) {
      owner = null;
      const next = editors.values().next().value;
      if (next) register(next, src);
    }
  });
  if (!owner) register(editor, src);
}

function register(ed0: monaco.editor.IStandaloneCodeEditor, src: CompletionSource): void {
  owner = ed0;
  ed0.addCommand(monaco.KeyCode.Tab, () => {
    const ed = [...editors].find((e) => e.hasTextFocus()) ?? ed0;
    const model = ed.getModel();
    const pos = ed.getPosition();
    if (model && pos && !midWord(model.getLineContent(pos.lineNumber), pos.column) && src.has(model, pos)) {
      ed.trigger("keyboard", "editor.action.triggerSuggest", {});
      return;
    }
    ed.trigger("keyboard", "tab", null);
  }, "editorTextFocus && !editorReadonly && !editorHasSelection && !suggestWidgetVisible && !inSnippetMode && !editorTabMovesFocus && !inlineSuggestionVisible");
}
