# wsp

Your setup, on your computers, for coding agents.

wsp runs your coding agents as threads in your projects: in a folder on this computer, and on other computers of yours that you add over ssh. You start a thread with a task, read its reply, send the next message and stop it, from the command line, the app, or another agent over MCP.

## Before you start

- Node 22 or newer, on macOS or Linux.
- A coding agent on this computer, signed in the way you already use it: Claude Code, Codex, OpenCode or Cursor's agent. wsp starts it as you would and holds no model key of its own.
- For another computer you add: ssh to it as root or as a login whose sudo runs as root, systemd, and Node 22 or newer there.

## Install

```sh
npm i -g @wsp-labs/wsp
```

The desktop app carries the same command. It installs with `curl --proto '=https' --tlsv1.2 -fsSL https://usewsp.com/install | sh`, or from the [releases page](https://github.com/wsp-labs/wsp/releases).

## First steps

```sh
wsp add ~/code/api                          # a folder on this computer becomes the project api
wsp run api "fix the flaky terminal test"   # an agent works in that folder; you read its reply
wsp threads                                 # who is working, where, on which branch
wsp send <thread> "now add a test for it"
wsp add me@build-box                        # another computer of yours, over ssh
```

The first line that needs a host starts one and says so; `wsp down` stops it. `wsp --help` lists every verb, and `wsp <verb> --help` its flags.

To let an agent on this computer drive wsp, give it the tools:

```sh
wsp mcp install --agent claude   # or codex, gemini, opencode
```

## More

The docs are at [usewsp.com/docs](https://usewsp.com/docs) and the source at [github.com/wsp-labs/wsp](https://github.com/wsp-labs/wsp). wsp is licensed AGPL-3.0-only.
