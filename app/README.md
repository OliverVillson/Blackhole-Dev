# BlackHole-Dev app

The desktop app for BlackHole-Dev: write recipes in Python, plan them from model headers, let the
copilot write them while you watch, and run them on your own VM. Electron + Monaco + xterm.js,
macOS (Apple silicon) first.

## Boot it on a Mac (dev mode)

You need Node 22+, Python 3.11+, git, and the Xcode command line tools (`xcode-select --install`).

```bash
# 1. Get the code (the app lives in Blackhole-Dev/app; the public harness is optional but enables pipeline.* steps)
mkdir -p ~/src && cd ~/src
git clone https://github.com/OliverVillson/Blackhole-Dev.git
git clone https://github.com/OliverVillson/BlackHole-Harness.git

# 2. Python env for the helper (python -m blackhole_dev.rpc)
python3 -m venv ~/bhdev-venv
source ~/bhdev-venv/bin/activate
pip install -e ~/src/BlackHole-Harness -e ~/src/BlackHole-Harness/harness -e ~/src/Blackhole-Dev

# 3. The app
cd ~/src/Blackhole-Dev/app
npm install
npm run dev
```

On first start the app creates `~/BlackHole-Dev/` with `recipes/`, `functions/` and `models/`
and a starter recipe. Then:

- **Settings (gear, bottom left) > Python helper**: paste `~/bhdev-venv/bin/python` (full path,
  e.g. `/Users/you/bhdev-venv/bin/python`) and press *Save and restart*. The status bar shows
  `blackhole_dev <version> · Python <version>` when the helper is up.
- **Settings > Copilot key**: paste your Anthropic key. It is encrypted with the macOS Keychain and
  only ever read by the app's main process. No billing goes through the app.
- **Settings > Checks** lists Python, blackhole_dev, ssh and rsync.

Other commands: `npm run build` (production bundle), `npm start` (run that bundle),
`npm run dist:mac` (unsigned `.dmg` in `dist/`), `npm test`, `npm run typecheck`.

## Layout

```
src/shared/      types shared by main, preload and renderer: I1 helper RPC, I3 editor streams, I4 confirm gate, extension points
src/main/        Electron main: window, menu, Python helper client, confirm gate window, Keychain secrets, licence seam, workspace, terminals
src/preload/     window.bh (the only bridge) and the gate window's bridge
src/renderer/    shell UI: layout, Monaco, I3 implementation, recipe sidebar, functions, anatomy, settings, panels
src/copilot/ src/vm/ src/chat/   workstream modules (each exports activate(ctx) from main.ts and renderer.ts)
src/modules.main.ts, src/modules.renderer.ts   one line per module
```

Interfaces: `/mnt/project-files/blackhole-dev-app/interfaces/ws1-shell.md` in the project files
(the types in `src/shared/` are the source of truth).

### Rules modules follow

- Main-process handlers are registered with `ctx.handle("<module>:<name>")`; a module cannot
  register another module's channels. The renderer calls them with `ctx.invoke`.
- Secrets are readable only in main (`ctx.secrets.get`). The renderer can only set/delete/check them.
- Anything that costs money (VM up/down, launching a run, large downloads, paid API or GPU spend)
  calls `await ctx.gate.confirm({...})` **in main** before acting. The gate is a separate window
  that only a human click can approve (trusted event, 600 ms arm delay); every decision is logged
  to `<userData>/confirm-log.jsonl`.
- `licence.status()` is the paywall seam; it allows everything for now.

## Tests

`npm test` runs unit tests (helper client against a fake helper, gate, secrets, workspace,
module host, keybindings) and the I3 stream tests against real Monaco text models.
`npm run test:e2e` builds the app and drives it under Xvfb (Linux) with Playwright, using
`test/fixtures/fake_helper.py` via `BLACKHOLE_DEV_HELPER`, and writes screenshots.
