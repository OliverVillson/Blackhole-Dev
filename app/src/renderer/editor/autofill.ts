// Tab autofill and Python symbols in Monaco. Tab after a word opens a small dropdown of
// candidates with the best one previewed inline; Tab or Enter accepts it. With no candidate,
// or mid-word, or with a selection, Tab indents as usual.

import * as monaco from "monaco-editor";
import { RECIPE_API, candidates, contextAt, midWord, wordsIn, type Candidate, type CandKind } from "./complete";

export class CompletionSource {
  private functions: Candidate[] = [];
  private wordCache = new WeakMap<monaco.editor.ITextModel, { version: number; words: Set<string> }>();

  setFunctions(fns: { name: string; per?: string; origin?: string; doc?: string }[]): void {
    this.functions = fns.map((f) => ({ label: f.name, kind: "function", detail: `${f.origin === "builtin" ? "built-in" : "my"} function${f.per ? ` · ${f.per}` : ""}` }));
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

  at(model: monaco.editor.ITextModel, pos: monaco.IPosition) {
    const line = model.getLineContent(pos.lineNumber);
    const ctx = contextAt(line, pos.column);
    // The word under the cursor counts as typed, not as a candidate.
    return { ctx, items: candidates(ctx, this.pool()) };
  }
}

const KIND: Record<CandKind, monaco.languages.CompletionItemKind> = {
  api: monaco.languages.CompletionItemKind.Class,
  function: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  word: monaco.languages.CompletionItemKind.Text,
};

let installed = false;

export function installCompletion(src: CompletionSource): void {
  if (installed) return;
  installed = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", '"', "'"],
    provideCompletionItems(model, pos) {
      const { ctx, items } = src.at(model, pos);
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: ctx.startCol, endColumn: pos.column };
      return {
        suggestions: items.map((c, i) => ({
          label: c.label,
          kind: KIND[c.kind],
          detail: c.detail,
          insertText: c.insert ?? c.label,
          range,
          sortText: String(i).padStart(4, "0"),
        })),
      };
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
    if (model && pos && !midWord(model.getLineContent(pos.lineNumber), pos.column) && src.at(model, pos).items.length) {
      ed.trigger("keyboard", "editor.action.triggerSuggest", {});
      return;
    }
    ed.trigger("keyboard", "tab", null);
  }, "editorTextFocus && !editorReadonly && !editorHasSelection && !suggestWidgetVisible && !inSnippetMode && !editorTabMovesFocus && !inlineSuggestionVisible");
}
