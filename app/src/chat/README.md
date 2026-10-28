# Local chat (WS6)

Chat with a model on this Mac once it is downloaded or copied back from a pipeline run (decision 6).

- `main.ts` `activate(ctx)`: model discovery, `mlx_lm.server` lifecycle, gated downloads, chat session. Channels are listed in `shared/types.ts` (`CHANNELS`), all prefixed `chat:`. Returns `{ deactivate }`, which the shell calls on quit so the server never outlives the app.
- `renderer.ts` `activate(ctx)`: activity "Local chat", sidebar view "Local models", tab type `chat` (`openTab('chat', { modelId })`), commands `chat.open` / `chat.stopServer`, status item.
- Each model has its own conversation. `chat:history(modelId)` / `chat:clear(modelId)`; `chat:send` goes to the served model's conversation, and stream events carry `modelId`. Saved after every turn to `<userData>/chat-history/<sha1 of model id>.json` (`core/history.ts`), so they survive a restart.
- Replies: `ui/highlight.ts` colours code blocks (keywords, strings, comments, calls, literals, types) per language family; each block has a language label and Copy button. While streaming the view glides toward the newest line; scrolling up releases it and shows "↓ Latest".
- LLM calls go through the shared I5 layer in `src/llm` (WS4), provider `openai-compatible`.

## Server

Starts `mlx_lm.server --model <folder> --host 127.0.0.1 --port 8080 --trust-remote-code --prompt-concurrency 1 --prefill-step-size 512 --prompt-cache-size 2` (the flags measured on the 16 GB M5; all editable in Chat settings). Executable: the setting, else `~/mlx-venv/bin/mlx_lm.server`, else `mlx_lm.server` on PATH, else `~/mlx-venv/bin/python -m mlx_lm.server`.

- A server already serving the same model on the port (e.g. the one opencode uses) is reused; otherwise the next free port is taken.
- Crashes are explained in plain English (Metal out of memory, mlx_lm missing, port taken, remote code).
- GPU wired limit: nothing to change for the 9.8 GB Qwen3.6 build on a 16 GB Mac (HEX prompts dequantize in small chunks, so it fits the macOS default of 2/3 of RAM). The tab warns only when the model plus 1 GB does not fit under `iogpu.wired_limit_mb` (or that default) and then offers an optional "Raise to 12 GB", which runs `sysctl` through the macOS administrator prompt (resets on reboot).
- GGUF models and other servers: set "External server" to a llama.cpp / Ollama `/v1` URL.

## Models

Scanned two folders deep in `ctx.paths.models`, `~/flint`, `~/keep`, `~/.blackhole/models`, `~/BlackHole/models` (editable). Grouped as Built by BlackHole (receipt file, `blackhole` in the name or config), Downloaded, Other. HEX-packed models are tagged.

## Downloads (I4)

`chat:download({ repo })` from the sidebar, or `{ action: "download", model, why, requestedBy: "copilot" }` from the copilot. Main calls `ctx.gate.confirm` itself for 1 GB and up and for every copilot request; a decline returns `{ phase: "cancelled", approved: false }`. Only the files a server needs are fetched, partial files resume, LFS files are sha256-checked, free disk space is checked first.

## Tests

`npx vitest run test/chat` (35 tests). `app/test/chat/fake-mlx-server.mjs` stands in for mlx_lm.server (same flags, SSE, OOM crash). `app/test/chat/preview/` renders the panel in a stand-in shell frame for screenshots.
