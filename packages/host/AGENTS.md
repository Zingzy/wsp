# Host

The `wsp` command, its MCP tool server and the host process. Paths are under packages/host/ unless they start at the repo root.

## How it works

A verb is a socket client of the running host (`dialHost()`); only the host holds keys and the runtime, one host per state file.
Each host start rewrites the MCP configs and skill copies naming its state, so a shape already written there must be moved (`refreshServers()`, `refreshSkills()`).
The daemon binary carries a Rust tool server that answers byte for byte like `src/mcp.ts`; `test/mcp-record.test.ts` run with `WSP_WRITE_RECORD=1` writes its record.
A box's agent is root there and can go around anything its daemon enforces, so a limit belongs on the host too.

## Invariants

1. On add, the key a box answers with is held against the pin before a sudo password goes out or anything runs as root. On remove and update `placeSudoReader()` checks the record's key only when sudo asks for a password; a root login or a passwordless sudo rides known_hosts: `test/places.test.ts`.
2. Under a folder a recipe ships or digests, a link is followed only to a file: `test/places-add.test.ts`, `test/recipes.test.ts`.
3. No secret lands from a config row: a name like a secret, a token-shaped value or a URL with a login is cut: `test/recipes.test.ts`.
4. The host caps guest sessions per workspace itself: `test/guest.test.ts`.
5. The binary's tool server line always carries `--state`, with `--host` too; old node lines naming this state move at start: `test/mcp-switch.test.ts`.
6. A served host writes into the wsp home it was handed, never the person's: `test/listen.test.ts`.
7. With the cloud off no page, tool or skill line names a cloud: `test/cloud.test.ts`.
8. A host whose program file is gone stops on Linux and keeps serving on a Mac; an update in place is not gone: `test/stop-signals.test.ts`, `test/host-lock.test.ts`.

## Traps

- A recursive fs.watch does not follow links: watch a skill at its real path, a file through its folder by name, never the home (#1481, #1482).
- A road that changes what a computer follows emits recipes.changed, or the watch set never moves (#1481).
- A leave or undo that deletes on a box treats a missing, partial or overwritten record as "keep everything"; write records whole, merge a repeat add (#1729).
- macOS has no timeout command: a bounded shell run kills its own group, ends when the work ends, keeps job notices out of output, bounds its drain (#1735, #1681).
- Read free disk on a computer you own on the install folder's volume, never df on the home or /root (#1679).
- `test/memory.test.ts` runs the built dists, so rebuild them on the base commit for a before reading; every bus event sits in a 5000-event ring (#1694).
- Cloud-only words go inside `<!-- cloud -->` spans; `test/cloud.test.ts` is outside the parity check command, so run it too (#1700).
- A change to a tool's words, input or answer moves the Rust record: rerun `test/mcp-record.test.ts`, run the `WSP_WRITE_RECORD=1` line it prints, read the diff line by line, build words from their functions (#1297, #1585, #1623).
- A test gated on an env variable skips quietly in CI: name the file in a CI step and the variable in `GATES` (`vitest.env.ts`) (#1297).

## One home for

| Rule | File | Function |
|---|---|---|
| files under a folder a recipe ships, links followed only to files | `src/folder-files.ts` | `folderFiles()` |
| a value shaped like a token | `src/token-shapes.ts` | `tokenShaped()` |
| a name shaped like a secret | `packages/collect/src/detect/shell-rc.ts` | `isSecretName()` |
| the program a process runs is gone | `src/host-lock.ts` | `programGone()` |
| the volume df reads on a computer you own | `packages/engine/src/golden-tools.ts` | `prefixVolume()` |
| a shell command bounded by killing its group | `packages/engine/src/machine-context.ts` | `boundedCommand()` |
| a tools probe with its own drain bound | `src/server-tools.ts` | `stdioScript()` |
| the line an agent's config starts the tools with | `src/mcp-install.ts` | `mcpServerSpec()` |
