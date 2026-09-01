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

## Quickstart

Node 22+, pnpm, and a Solari API key. Add an Anthropic key if you want
claude sessions.

```sh
pnpm install && pnpm -r build
printf 'SOLARI_API_KEY=%s\n' "$YOUR_KEY" > .env
npx wsp             # status shell on http://127.0.0.1:4400
npx wsp doctor      # prove the reach path against one live machine
```

`wsp` reads keys from `.env` in the working directory or from the
environment, and asks once if neither is set. State is a JSON file:
`./.wsp/state.json` in a checkout with a `.env`, `~/.wsp/state.json`
otherwise.

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
from the network. For local runs bind loopback and supply a token inline,
since the in-guest token file lives under /root:

```
WSP_DAEMON_TOKEN=dev wsp-daemon --host 127.0.0.1
```

(`--token-path <file>` works too.) Only in-guest deployments need the
0.0.0.0 default, since the preview edge dials eth0.

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

## Capability flags

Backends implement `MachineBackend` plus a `capabilities` descriptor:
`{ liveCloneForks, ramPreservingPause, resize, previewUrls, signedUrls }`.
Clients read the flags instead of assuming. A backend without preview URLs
loses browser reach and the UI says so instead of pretending. Solari is the
first backend.

## Keys never leave your machine

The runtime runs inside the `wsp` process on your machine, so your provider
key travels only in direct requests from that process to the provider's API.
The status shell and the WebSocket API bind 127.0.0.1 only.

## Packages

| package | what it is |
|---|---|
| `@wsp/engine` | machine backends, workspace lifecycle, golden images, vault |
| `@wsp/daemon` | in-guest daemon: ptys, port watch, inbox, process manifest |
| `@wsp/adapter-claude` | drives claude headless inside a workspace |
| `@wsp/protocol` | zod schemas for every wire message |
| `@wsp/runtime` | embeddable runtime: workspaces, sessions, events over WS |
| `@wsp/host` | the `wsp` bin: embedded runtime, status shell, doctor |
| `wspx` | dev CLI over the same runtime |

## License

AGPL-3.0-only.
