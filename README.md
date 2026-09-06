# wsp

Cloud workspaces for coding agents, run from your own machine. `npx wsp`
starts an embedded runtime, a status page on localhost, and a WebSocket API
for clients. There is no hosted control plane: you bring your own provider
keys, and every call goes straight from the wsp process to the provider.

Workspaces fork from a golden snapshot in seconds, nap when idle, and wake
with RAM intact. If a paused machine vanishes, wsp rebuilds it from the
snapshot and restores your files. Claude runs inside them over the
provider's exec channel, and your browser reaches each workspace's daemon
directly.

![The shell: workspaces and their threads in the sidebar, the selected workspace's thread and composer in the center, the surface picker in the right panel](docs/screenshots/shell.png)

*The shell. Workspaces and their threads on the left, the thread with its composer in the center, the right panel's surface picker.*

![The terminal drawer under the thread, a shell on the workspace's daemon](docs/screenshots/terminal.png)

*The terminal drawer under the thread: a shell on the workspace, with tabs and splits.*

![The browser pane framing a server the workspace is listening on](docs/screenshots/browser.png)

*The browser pane: the workspace's listening ports as local servers, opened in place.*

![The machine panel: state, reach, size, auto-nap, usage and the golden lineage](docs/screenshots/machine.png)

*The machine panel: state, reach, size and auto-nap, spend so far, the golden lineage, pause and upgrade.*

## Quickstart

Node 22+, pnpm, and a Solari API key. Add an Anthropic key if you want
claude sessions.

```sh
pnpm install && pnpm build
printf 'SOLARI_API_KEY=%s\n' "$YOUR_KEY" > .env
pnpm wsp init       # first run: tick what comes along, build and seal your golden, land in the app
pnpm wsp up         # every start after that: the app on http://127.0.0.1:4400 over the golden you sealed
pnpm wsp doctor     # prove the reach path against one live machine
```

`wsp init` reads what this machine has and what your agents used, then walks
three screens: the agents (the catalog's six, the ones on this Mac ticked),
what they need (one line of counts and the disk line, the tool rows behind
one key), and the sign-ins and keys (logins sign in on the machine after the
build; keys are ticked to copy). One summary, one confirm, then it boots the
machine, runs the sign-ins in your terminal, asks for each secret it cut from
your rc files, seals the golden on Enter, forks your first workspace and opens
the app on it. Every prompt has a flag: `--yes` takes the defaults,
`--recipe <path>` ticks from a recipe `wsp recipe` wrote and goes straight to
the sign-ins, `--manifest <path>` replays a saved `golden-recipe.json` screen
by screen. Both files are saved next to the state so a second golden is a
re-run.

`wsp` reads keys from `.env` in the working directory or from the
environment, and asks once if neither is set. State is a JSON file:
`./.wsp/state.json` in a checkout with a `.env`, `~/.wsp/state.json`
otherwise. One state file belongs to one machine: a WSP_HOME on a shared
or synced drive is not supported.

## The reach path, measured

A browser talks to a workspace's in-guest daemon through a per-workspace
preview URL minted from the provider. TLS ends at the provider's edge. The
edge checks its signed token, and the daemon checks its own token on top,
because the daemon binds 0.0.0.0 and that token is what guards the port.
Preview tokens expire after 60 minutes; wsp reuses a minted URL while it is
under about 50 minutes old, then swaps tokens (the hostname never changes).
The edge drops sockets that stay quiet for about 30 seconds, so clients send
an app-level heartbeat every 10. A paused workspace's URL goes dark and the
same URL routes again about a second after wake.

Running `wsp-daemon` on your own machine (tests, local hacking) will make
macOS and Windows ask about incoming connections, because 0.0.0.0 accepts
from the network. For local runs bind loopback and point it at a token file
of your own, since the in-guest one lives under /root:

```
printf '%s' dev > /tmp/wsp-daemon-token
wsp-daemon --host 127.0.0.1 --token-path /tmp/wsp-daemon-token
```

The file is read at every connection's auth frame, so the host can rotate it
while the daemon runs. Only in-guest deployments need the 0.0.0.0 default,
since the preview edge dials eth0.

`wsp doctor` walks the whole loop against one live machine and prints what
it measured. One run, client in India, machine in us-west:

```
step                   time      note
-----------------------------------------------------------------------------
golden image           0ms       reused v1 (snap_dl414bbklze6)
fork workspace         15.4s     machine ZGVza3RvcC1wb29sLWktMGZk…
deploy daemon          5889ms    tar upload + in-guest npm install (node-pty compile) + start on 0.0.0.0:7070
mint previewUrl        1125ms    expires in 60min, host c66506663eaa315a9131-7070.preview.getsolari.com
ws connect + first op  1354ms    TLS + upgrade + authed manifest.get through the preview edge
heartbeats (3 x 10s)   30.4s     socket alive past the ~30s idle sweep
inbox round trip       3277ms    REST touch -> inbox.file over the preview socket (~2s watcher quiet window)
kill + verify zero     947ms     workspace deleted, no machines left on the account
-----------------------------------------------------------------------------
TOTAL                  58.4s
```

The golden image builds once (28s in the same session) and every later fork
reuses it.

## Live canary

The provider changes under us. On 2026-09-04 its host pool started refusing
a create field it had accepted and ignored two days earlier, and every
`wsp init` booted nothing until someone read the error off a live run. The
canary posts every create body wsp sends to the real API and fails naming
the provider's answer word for word, next to the body it sent.

```sh
pnpm canary                    # about three minutes, a few cents
WSP_LIVE_LONG=1 pnpm canary    # adds the 65 minute createdAt reading, about $0.11
```

It needs `SOLARI_API_KEY` in `.env` at the repo root and a free slot under
the account's machine cap: it holds one machine at a time, kills everything
it makes by id, deletes the snapshot it sealed, and never touches a machine
it did not create. Run it once a day and before every release; a red case is
the signal to change a create body on purpose, not a flake to rerun. Under
`WSP_LIVE=1` the root vitest config runs test files one at a time, so
nothing else live should run beside it.

One more test stays out of the default run for a different reason: the
terminal pane's glyph test (`apps/web/src/terminal/ghostty/glyphs.browser.test.ts`)
starts a Vite dev server and Playwright's Chromium to draw Nerd Font
codepoints through the real pane and read the pixels back. It runs only under
`WSP_RENDER=1 pnpm test`, needs `pnpm exec playwright install chromium` once,
and skips, saying so, when that browser is missing.

What it covers:

- `packages/engine/test/create-canary.live.test.ts`: the builder body from
  `prepareBuilder`, the smoke fork body from `sealGolden` and the fork body
  from `forkGolden`, each asserted 201 and killed until gone; and the listing
  row of a machine it just created carrying `metadata`, `cpu` and `memMb`,
  which the sweep's owner and cost lines read.
- `packages/runtime/test/create-canary.live.test.ts`: the workspace body the
  runtime itself posts (owner label, lifecycle pause, idle backstop), created
  through `workspaces.create` on a snapshot the case takes and deletes, and
  removed through `workspaces.delete` with the machine read gone.
- `packages/engine/test/solari-quirks.live.test.ts`: the platform bugs we
  coded around, one case each, shouting when the platform changes so a guard
  is relaxed on purpose.
- `packages/engine/test/createdat-drift.live.test.ts` (only with
  `WSP_LIVE_LONG=1`): one base
  sandbox with the builder's lifecycle, never exec'd or paused, read right
  after create and at 2, 10 and 65 minutes. A measurement, not a guard: it
  prints every `createdAt` and `expiresAt`, asserts only that the machine
  stayed running and is gone after the kill. Measured 2026-09-04, the
  provider's `createdAt` tracks the wall clock about five minutes behind, so
  nothing in wsp reads it for a decision.

## Capability flags

Backends implement `MachineBackend` plus a `capabilities` descriptor:
`{ liveCloneForks, ramPreservingPause, resize, previewUrls, signedUrls, containers }`.
Clients read the flags instead of assuming. A backend without preview URLs
loses browser reach and the UI says so instead of pretending. Solari is the
first backend, and it reports `containers: false`: its guest kernel (6.6.30)
has no overlayfs or netfilter, so Docker does not run there and services get
installed natively.

## Keys never leave your machine

The runtime runs inside the `wsp` process on your machine, so your provider
key travels only in direct requests from that process to the provider's API.
The app and the WebSocket API bind 127.0.0.1 only.

## Packages

| package | what it is |
|---|---|
| `@wsp/catalog` | the agents and tools wsp can put on a machine: roads, sign-ins, config paths, defaults |
| `@wsp/engine` | machine backends, workspace lifecycle, golden images, vault |
| `@wsp/daemon` | in-guest daemon: ptys, port watch, inbox, process manifest |
| `@wsp/adapter-claude` | drives claude headless inside a workspace |
| `@wsp/protocol` | zod schemas for every wire message |
| `@wsp/runtime` | embeddable runtime: workspaces, sessions, events over WS |
| `@wsp/host` | the `wsp` bin: embedded runtime, serves the app, doctor |
| `wspx` | dev CLI over the same runtime |

## License

AGPL-3.0-only.
