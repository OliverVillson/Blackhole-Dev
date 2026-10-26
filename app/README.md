# BlackHole-Dev app

The desktop app for BlackHole-Dev: write recipes in Python, plan them from model headers, let the
copilot write them while you watch, and run them on your own VM. Electron + Monaco + xterm.js,
macOS (Apple silicon) first.

## Boot it on a Mac (dev mode)

You need Node 22+, Python 3.11+, git, and the Xcode command line tools (`xcode-select --install`).
Each block below is safe to paste as a whole.

**1. Get the code.** Both repos, side by side (the harness gives you the `pipeline.*` steps and the
presets):

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/OliverVillson/Blackhole-Dev.git
git clone https://github.com/OliverVillson/BlackHole-Harness.git
```

If you already have one of them, skip that line and `git pull` in it instead.

**2. Python environment** for the helper the app talks to (`python -m blackhole_dev.rpc`):

```bash
python3 -m venv ~/bhdev-venv
source ~/bhdev-venv/bin/activate
pip install -e ~/src/BlackHole-Harness
pip install -e ~/src/BlackHole-Harness/harness
pip install -e ~/src/Blackhole-Dev
```

**3. The app:**

```bash
cd ~/src/Blackhole-Dev/app
npm install
npm run dev
```

`npm install` and `npm run dev` both check that the Electron binary is really there and download it
when it is not (Electron's own installer can exit silently without it, which shows up as
"Electron uninstall"). If the check still fails it prints why and what to run. To check everything
at once (Electron, Node, node-pty, the Python helper, ssh, rsync):

```bash
cd ~/src/Blackhole-Dev/app
source ~/bhdev-venv/bin/activate
npm run doctor
```

On npm 12 and newer, `npm install` may also warn that some packages' install scripts are not yet
allowed. Allow the ones the app needs, then install again:

```bash
cd ~/src/Blackhole-Dev/app
npm install-scripts approve electron node-pty fsevents
npm install
```

If Electron is still missing after that, clear its download cache and reinstall it:

```bash
cd ~/src/Blackhole-Dev/app
unset ELECTRON_SKIP_BINARY_DOWNLOAD ELECTRON_OVERRIDE_DIST_PATH
rm -rf ~/Library/Caches/electron node_modules/electron
npm install
npm run doctor
```

To update later, `git pull --autostash` in `~/src/Blackhole-Dev` (it keeps a local `allowScripts`
entry that `npm install-scripts approve` writes into `package.json`), then `npm install` in `app/`.

`node-pty` is what gives the TERMINAL panel a real TTY; it builds from source on Apple silicon and
takes a few seconds. If it fails, the app still runs and the terminal falls back to plain pipes.

On first start the app creates `~/BlackHole-Dev/` with `recipes/`, `functions/` and `models/`
and a starter recipe. Then:

- **Settings (gear, bottom left) > Python helper**: paste the full path of the venv's Python,
  `/Users/<you>/bhdev-venv/bin/python`, and press *Save and restart*. The status bar shows
  `blackhole_dev <version> · Python <version>` when the helper is up.
- **Settings > Copilot key**: paste your Anthropic key. It is encrypted with the macOS Keychain and
  only ever read by the app's main process. No billing goes through the app.
- **Copilot without an API key**: pick a model under *Claude · your Claude Code sign-in* in the Copilot
  panel. It runs the Claude Code you installed and signed into yourself (`curl -fsSL https://claude.ai/install.sh | bash`,
  then `claude` once in Terminal), so turns count against your own Claude plan. The app never sees that login.
  Claude Code's built-in tools are switched off; it only gets the copilot's tools, and VM starts, runs and
  downloads still need your click.
- **Settings > Checks** lists Python, blackhole_dev, ssh and rsync.

Other commands: `npm run doctor` (environment check), `npm run build` (production bundle), `npm start` (run that bundle),
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
