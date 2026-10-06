# Working on wsp

## Map

- `packages/protocol`: the wire shapes, the words a person reads and the daemon's version record. Every package reads it.
- `packages/runtime`: the host's core, the records of workspaces, threads, turns, transcripts and joined computers.
- `packages/host`: the `wsp` command line, the MCP tools, and the host process that serves the app.
- `packages/engine`: the roads that build, fork and run machines. `packages/catalog`: the agents and tools wsp knows.
- `packages/collect`: what a computer holds, read for a recipe. `packages/adapter-claude` and its siblings: one agent each.
- `packages/keys` and `packages/own-file`: link keys, and the one writer under the owner's state folder.
- `apps/web`: the React app. `apps/desktop`: the shell around it. `daemon`: the Rust daemon and tool server.
- `packages/wspx`: the npm package that installs `wsp`. `packages/daemon`: node tests of the daemon's wire.
- `skills/wsp/SKILL.md`: what an agent reads about the command line and the tools.

## Notes

Read the note of the area you change before you change it; each lists its traps and the one home for each rule.
A fix for a fault that came from a rule nobody knew, a regression, or knowledge only the code held adds one line
to that area's note in the same commit.

- `packages/runtime/AGENTS.md`
- `packages/host/AGENTS.md`
- `packages/protocol/AGENTS.md`
- `apps/web/AGENTS.md`
- `daemon/AGENTS.md`

## The command line, the MCP tools and the skill are one contract

Every capability exists in all three or in none. The command line's verbs
(`packages/host/src/verbs.ts`) and its other lines (`COMMAND_LINES` in
`packages/host/src/cli.ts`) each have an MCP tool in `packages/host/src/mcp.ts`
named by the verb's words joined with `_`, and a row in the verbs table of
`skills/wsp/SKILL.md` naming the tool with its inputs in parentheses. A tool
with no verb, or a verb with no tool, is listed in
`packages/host/test/parity.test.ts` with the reason.

Every `wsp ...` line the skill shows, fenced or inline, and every one in the
MCP server's instructions, parses against the flag table its command reads,
so a renamed verb or a stale flag fails the suite. A fenced line that is not
a real command ends in `# illustrative` and is skipped.

Every verb answers under one contract, stated once in
`packages/protocol/src/exit.ts` and in the skill's contract section. With
`--json` stdout carries JSON alone: one object per line, frames first, the
last line the result; a verb with no stream prints the result alone. The
result is the entry's output shape (which every entry must carry) less the
fields its frames carried (`stream` on the entry: exec's `output`, import's
`plan`, fork's `workspace` and `notice`). A refusal or a failure is one line
on stderr, the failure object under `--json`, and the exit code is its
class's: 0 ok, 1 provider, 2 auth, 3 usage. The class is read off the kind
stamped on the error where it was born (`usageRefusal`, `authRefusal`, the
engine's kinds), never off its words. An MCP tool returns the same object as
a tool error. `wsp exec` alone exits with the command's own code.

Adding or renaming a verb, a flag or a tool input touches the table, the tool
and the skill row in one change. The check is

```
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 packages/host/test/parity.test.ts packages/host/test/skill.test.ts packages/host/test/contract.test.ts
```

## Before a branch is called ready

`scripts/test-files.sh <file>...` runs the named tests with memory and
stub-script at two workers and refuses a run naming no file; `--tools` adds
the tool record. `pnpm check:laws` runs the tests that read the whole tree.
`scripts/pre-review.sh [<ticket>]` is the last command before a branch is
called ready: one commit on origin/main, the hooks' rules, the laws, the
touched tests and their red proof on the merge-base, and the ticket's lines
to answer; `--build` builds the packages first. `scripts/heavy.sh <command>`
queues heavy runs into two slots on a Mac.

## Glossary

The words to use in code and to people. This list is the target; `packages/protocol/test/person-words.test.ts`
holds the app to the subset it names (golden, vault, lineage, volatile, head, Reach, upgrade, machine, this Mac).
Shipped exceptions: the locked Computers copy says machine for a cloud's machines, the wsp skill says coordinator
thread, and `wsp snapshot` is a verb.

- **host**: the process that holds a state file and serves the app, the command line and the tools. One per state file. Avoid: server, backend.
- **computer**: a real computer a person owns or sits at, named in the app by its own name. Avoid: machine, device, this Mac.
- **place**: the code's word for a computer as a row of `wsp places` (`PlaceView`). The app says computer. Avoid: node.
- **box**: a Linux computer of the person's own, added over ssh or joined, its daemon running as root. Avoid: VM, server.
- **machine**: what wsp makes for a workspace on a box or at a cloud provider. The app says computer. Avoid: container, sandbox.
- **daemon**: the Rust binary on every computer serving files, git, terminals and ports to the host. Avoid: agent.
- **project**: a repo or folder on one computer that threads run in. Avoid: repo, workspace.
- **workspace**: the record a thread runs on, `local` or `cloud` (`WorkspaceKind`). A project folder's threads share one. Avoid: environment.
- **thread**: one conversation in the sidebar, the turns that share a thread id (`ThreadView`). Avoid: chat, task, session.
- **turn**: one run of the agent's process for one message. Avoid: job, run.
- **session**: the runtime's row for a turn and the harness's own id it resumes (`SessionView`). Never a word a person reads. Avoid: thread.
- **lead**: the thread at the top of a tree, which started the others. Avoid: parent, coordinator.
- **agent**: a coding agent a thread runs: claude, codex, opencode, cursor. Avoid: model, bot, AI.
- **harness**: an agent's own command line and session files, driven by an adapter (`HarnessCatalog`). Avoid: provider.
- **image**: the person's tools and sign-ins, sealed by `wsp init`, that a machine boots from. Avoid: golden, snapshot.
- **recipe**: the tools, configs, skills and folders a computer follows, minted from what the agents used. Avoid: manifest, dotfiles.
- **worktree**: a git worktree a thread started with `--branch` runs in. Avoid: branch folder, copy.
- **checkpoint**: what the daemon keeps per turn so a thread can rewind. Avoid: snapshot, undo.
- **sign-in**: an agent's or a tool's own login, run by the person at a terminal. Avoid: auth, credentials.
- **update**: moving a computer's daemon or the app to a newer build. Avoid: upgrade.
- **slate**: a thread's live panel beside the chat. Avoid: canvas, artifact.
- **relay**: the service that gives a host no one can reach inbound an https address. Avoid: tunnel, proxy.
