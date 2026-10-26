# app/src/vm: run recipes on a VM (WS5)

Machines, Run on VM, the job monitor and the jobs API (I6). Main side in `main.ts`, UI side in
`renderer.ts`; both export `activate(ctx)` for the shell.

## How a run works

1. **Check** (`vm:job.prepare`): lint and bundle the recipe through the helper (I1), dry-run plan,
   and one ssh round trip that runs `remote/probe.py` with the machine's own `python3`: harness
   venv (`$BLACKHOLE_HOME/venv`, `~/bh-venv`, `~/reaper-venv`), `--recipe` support, `blackhole_dev`
   version, GPUs, disk, jobs and which of them run. Nothing is changed anywhere.
2. **Confirm**: `vm:job.launch` calls the shell's gate (I4) in main with the cost at the user's
   own rate. One approval runs one plan once.
3. **Send**: `mkdir` the job folder, rsync the `.bhr` to `<job>/recipe.bhr`, check its sha256 on the
   machine, install the shipped `blackhole_dev` wheel when the machine has another version.
4. **Start**: `tmux new-session -d -s bh-<job>` running
   `python -m blackhole_pipeline --job <job> --recipe <job>/recipe.bhr >> <job>/events.log`, with the
   environment the installed `blackhole` launcher sets (compile caches, vLLM venv). The job keeps
   running when the laptop sleeps; the TUI sees it like any other job.
5. **Watch**: `tail -c +<offset> -F events.log` over ssh, folded by `events.ts` into stages,
   held-out KL readings and results. A dropped connection resumes from the byte it stopped at.
6. **Stop** runs `remote/stop.py`: SIGTERM to that job's pipeline only (picked by argv, never by a
   pattern that could hit the tmux server or another job), SIGKILL after 40 s, stray vLLM engine
   processes only when no other pipeline runs.
7. **Copy back**: rsync of `<job>/out/` (links followed) to the app's models folder, behind the
   gate (`download`) unless the run's approval already listed it.

## Machines

- `~/.ssh/config` hosts, hosts added in the app (`user@host[:port]`), and VMs from `blackhole up`
  (`$BLACKHOLE_HOME/machines/*.json`, with the provider's price).
- ssh is the system OpenSSH with a ControlMaster per host, so the user's config, ProxyJump, agent
  and keychain work as in their terminal. `BatchMode=yes` everywhere except the terminal.
- `blackhole up` / `down` run the harness's own `blackhole.cloud.cli` with the app's Python
  (`python.path` setting, else the bundled runtime). The app adds only the gate.

## Gate rules (all enforced in main)

| action | gate | notes |
| --- | --- | --- |
| `vm:vm.up`, resume | `vm.up` | shows the provider's offer line and price first |
| `vm:vm.down` | `vm.down` | a delete with models on the VM is refused by `blackhole down` until "Delete anyway" (a second gate) |
| `vm:job.launch` | `run.launch` | cost = rate x plan estimate |
| `vm:job.pull` | `download` | a caller cannot pass "already approved" |
| `vm:copilot.*` | same as above, `requestedBy: "copilot"` | the copilot can only stop a VM, never delete it |

## Tests

`npx vitest run src/vm` runs the unit and UI tests. The end-to-end tests run against a real ssh
host with a stand-in `blackhole_pipeline` when `BHD_TEST_SSH=user@host:port` is set (they make job
folders under that user's `~/.blackhole/jobs`).
