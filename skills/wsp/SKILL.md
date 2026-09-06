---
name: wsp
description: How to run work on wsp workspaces from the command line or the MCP tools. Every verb and tool with its arguments and an example, the loop for building a ticket on a workspace, where the person has to step in, what a machine costs and where its limits are, and the rules learned the hard way. Read it before opening a thread, sending into one, forking a workspace or bringing a project home.
---

# wsp

wsp runs cloud machines called workspaces, forked in seconds from a golden image the person sealed with wsp init, each with coding agents working inside it as threads. The host on the person's computer (wsp up, or the desktop app) owns the machines and the keys; the wsp command line and the wsp MCP server are thin clients of that same host, so whatever you do here shows in the person's sidebar and they can read and answer any thread. Start with `workspaces` (or `wsp threads` on the command line) to see what is running. Open a thread with `thread_new`, giving the workspace, the task and the agent to run; it returns the reply when the turn ends. Continue a thread with `send`; run a command on a machine with `exec`; `snapshot` a workspace with a project loaded as a project golden and `new` from it so the next machine starts with the project in place; `export` brings a folder and its agent sessions home.

## Verbs and tools

The command line and the MCP server call the same functions. Every verb takes `--json` (one JSON line per protocol value, nothing else printed) and `--state <path>` (the state file the host serves; default `~/.wsp/state.json`, or `./.wsp/state.json` in a checkout with a `.env`). A workspace is named by its name, or by its id when two share a name. A thread is named by its id or by a prefix that picks exactly one.

| command line | MCP tool | what it does |
|---|---|---|
| `wsp threads [--in <workspace>]` | `workspaces`, `threads` | the sidebar's rows: workspace, agent, state (running, completed, interrupted, failed), who opened it (person, cli, agent), the folder it works in, the title |
| `wsp new <name> [--from <project golden>]` | `new` | a workspace forked from the golden's head, or from a project golden by project name or snapshot id; booted and reachable when it returns |
| `wsp fork <workspace> [--name <n>] [--send "<task>" [--agent] [--cwd] [--notify]]` | `fork` | a sibling from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread |
| `wsp pause <workspace>` | `pause` | naps the machine; it wakes on the next thread or command |
| `wsp thread new --in <workspace> [--agent <id>] [--cwd <path>] [--notify <thread\|me>] "<task>"` | `thread_new` | opens a thread and follows its first turn to the reply |
| `wsp send <thread> "<message>"` | `send` | a message into an existing thread; follows the turn to the reply |
| `wsp exec <workspace> -- <command...>` | `exec` | runs the command on the machine, each word as given; output lines and the exit code |
| `wsp snapshot <workspace>` | `snapshot` | a project golden: the golden plus the loaded project as it stands |
| `wsp export <workspace> <folder> [--from <path>] [--replace] [--agents <ids>]` | `export` | the folder and the agent sessions keyed to it come home to this computer |
| `wsp import <folder> --to <workspace>` | none | not here yet; import a project from the app's import dialog |

`wsp mcp` serves these tools over stdio; `wsp mcp install --agent <id>` writes the server into that agent's own MCP config and this skill into its skills folder. Only agents the catalog knows an MCP config for get the server: claude, codex, gemini, opencode. The rest get the skill and a by-hand line.

### thread new

```
wsp thread new --in dev --cwd /Users/zingzy/wsp --notify me "Read ticket 308 ... and build it."
```

`--in` is required. `--agent` names the agent to run in the thread; the host's default is claude, and a thread runs only on an agent the host has an adapter for (today, claude). `--cwd` is an absolute path on the machine; without it the thread starts in the workspace's imported project folder, else in the home folder. A thread's folder decides which project state (sessions, memory, CLAUDE.md) the agent loads, so put a thread where its project is. `--notify me` sends one line to the person when each turn ends; `--notify <thread>` sends that line into another thread as a message (steered into its running turn or queued). The line reads `thread 1a2b3c4d finished (completed, 12m 4s, $0.41): <last line of the reply>`.

The command line streams the reply to stderr as it arrives and prints the last message on stdout when the turn ends, exit 0; a failed turn prints its reason on stderr, exit 1. The first stdout line is `thread <id>`, the id `send` takes. The MCP tool returns the reply text with the thread id, workspace id, agent and outcome.

### send

```
wsp send 1a2b3c4d "Also cover the codex case in the test."
```

A message into a thread whose turn is not running starts a new turn (outcome `started`). Into a thread whose turn is running: when the agent can take input mid-turn (Claude Code does) the message joins the running turn (outcome `steered`) and the reply is that turn's; otherwise the message waits for the running turn to end and then runs (outcome `queued`). The command line says which on stderr. A person's message on the same thread lands in order with yours. Never start a second thread to hurry a running one.

### exec

```
wsp exec dev -- sh -c 'cd /Users/zingzy/wsp && git status --short'
```

Each word after `--` reaches the machine as one argument; a shell line goes through `sh -c`. The command's exit code is the verb's. A non-zero exit is a result; the machine going away is an error. The machine runs as root with home /root and no login shell, so `bash -c`, never `bash -lc`.

### new, fork, snapshot

```
wsp snapshot dev                      # project golden of dev: its golden plus the imported project
wsp new dev-2 --from wsp              # a machine from that project golden, project in place, no upload
wsp fork dev --send "Run the gate."   # a sibling machine from dev's golden version, first thread opened
```

`fork` copies the golden version, not the live disk: work on the source's disk is not on the fork. Fork from a project golden when the fork needs the project. When a fork's first turn fails, the workspace still exists and the error names it; continue with `thread new` on it, do not fork again. `snapshot` takes only a running first-life machine with a project imported; a woken machine or one without a project is refused in one line and nothing is taken.

### export

```
wsp export dev /Users/zingzy/wsp-from-dev --agents claude
```

The folder must not exist on this computer unless `--replace`. `--from` is the folder's path on the machine, the same path as the destination when absent. The sessions keyed to the folder land in each agent's home here, keyed to the new path.

## The loop for building with wsp

1. One workspace with the repo imported (the app's import dialog on a fresh workspace, or `new --from` a project golden taken after an import). `wsp threads --in <workspace>` shows what is on it.
2. One thread per ticket, each in its own worktree: the brief opens with `git worktree add -b ticket/<n>-<slug> <folder> origin/main`, and `--cwd` points at the repo. Two threads writing in one checkout collide.
3. The brief names the ticket, the files to read whole, the laws (the repo's review skill), the exact test commands and the proof required. A brief that says "fix the bug" comes back with a guess.
4. Start builder threads with `--notify me` when you are a person, or `--notify <your thread>` when you are an agent that wants to keep working; then do not poll `threads`, the line arrives. Both `wsp thread new` and the `thread_new` tool follow the first turn and return only when it ends, so over MCP a coordinator runs one builder at a time. On the command line a builder that should run beside you is started detached, `nohup wsp thread new ... > /tmp/<name>.log 2>&1 &` (a Mac has no `setsid`; a wsp machine does), and its id is the log's first `thread <id>` line.
5. A review is its own thread on the same workspace with the branch name and the review skill; the builder fixes in its thread through `send`.
6. Work leaves the machine by `git push` from the thread (only when the golden signed in to GitHub during wsp init) or by `export` to this computer.
7. Gates (full test runs, builds, packaging) run on the person's machine or one at a time on the workspace. A 2 vCPU, 4 GB machine runs one build or one agent at a time; two starve the daemon and the app reads the machine as not answering.

## Where the person steps in

- Sign-ins happen on the machine during wsp init: the tool's login page opens on the person's computer. A thread cannot sign in for them; if `gh auth status` fails on the machine, say so and export instead of pushing.
- Keys (the Solari key, an Anthropic key) live in the person's `.env` and never reach a thread. A secret a thread needs is asked for through wsp, not typed into a terminal.
- The account holds two machines at once. A third `new` or `fork` is refused; the person decides which workspace to pause.
- A pause or a wake that does not return is stuck on the provider side; tell the person rather than retrying in a loop.
- Every workspace is the golden's size (2 vCPU, 4 GB); there is no size to choose at fork yet.
- Importing a project is done from the app; `wsp import` is not here yet.
- wsp init is the person's to run: it opens sign-ins in their browser.

## Costs and limits

- A workspace costs about $0.11 an hour while awake (2 vCPU at $0.035 per vCPU-hour plus 4 GB at $0.01 per GB-hour). Snapshots are free up to 10 GB an organization, then $0.05 per GB-month from 2026-10-01.
- A workspace naps by itself after 20 minutes without a person, a thread or a command touching it; the next thread or exec wakes it.
- A turn is cut after 10 minutes with no output from the agent, and at 6 hours in all. A long silent step (a full install, a build) needs output flowing or it ends the turn.
- The root disk is 20 GB; wsp keeps 2 GB free and skips tool installs that would go under it.
- One thread runs one agent process; a 4 GB machine runs one build or one agent at a time. Put a second builder on a second workspace, not a second thread on the same one.
- The model, effort and permission mode are the agent's own defaults; the command line and the MCP tools cannot choose them yet. Choose the role by the brief and the agent, and keep review threads short.

## Rules learned the hard way

- A send into a running thread steers it or waits behind it, never a second concurrent turn (#274).
- A thread's end reaches its parent thread or the person only when its start said `--notify`; nothing polls (#286).
- A thread works in `--cwd` or the workspace's project folder; a relative `--cwd` is refused before anything starts (#280).
- A turn ends on 10 minutes of silence, not a 15 minute wall clock; long steps must print (#295).
- `thread new` and `send` return when the reply is complete, not when the process is reaped minutes later (#293).
- A turn's process group dies with the turn; a server that must outlive it starts with `setsid nohup ... &` (#275).
- Snapshot only a running first-life machine with a project loaded; a woken machine is refused (#223).
- Export refuses an existing folder; `--replace` overwrites it on purpose (#224).
- A resumed thread runs in the folder its session started in, whatever folder is followed in the app (#236).
- A send carries its own request id, so two clients sending the same text do not adopt each other's turn (#239).
- The MCP server and the command line refuse a host of another version in one line; restart it with wsp up (#290).
- Not here yet: choosing the model or effort (#291), stopping a running turn (#287), a wake verb and exec on a napping workspace (#268), picking a machine size (#301), a GitHub credential on the machine (#279). A thread's title follows its latest message (#288), and a title with newlines breaks the threads table (#292).
