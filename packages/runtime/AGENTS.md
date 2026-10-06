# Runtime

The host's core: workspaces, threads, turns, transcripts and joined computers. Paths are under packages/runtime/ unless they start at the repo root.

## How it works

A turn is a process on the workspace's computer, not the host's: it writes a log there, and a new host re-opens it.
Find code by name: `src/runtime.ts` is the hub; its parts live in folders under `src/`. No code compares the kind string: ask `moduleOf()` or `isLocalWorkspace()`.
An agent writes everything in its copy, the gh on its PATH included, and the daemon there may run as root.

## Invariants

1. A host that restarts re-opens each running turn by its handle and reads its log from the first byte, so a reply that landed while it was down is kept (`test/local-exec.test.ts`).
2. A re-opened turn writes no row twice: `turnWritten()` counts what it wrote and the replay skips that much (`test/subagents.test.ts`).
3. Where a request came from is stamped off its token, never the client's word: a thread's token reads as relayed (`test/spawn-guard.test.ts`).
4. Nothing posts as the person through a copy's gh (`postAsPerson()`), and a merge sends the head the person was shown (`test/pull-request.test.ts`).
5. A transcript that does not parse is set aside and every later turn is still written (`test/transcript-index.test.ts`).
6. A computer's record is read and written in its turn with `change()`, so two writers never drop each other's fields (`test/places-setup.test.ts`).

## Traps

- `withDaemon()` never reads a computer's block: call `copyBlocked()` before any act inside a copy; `aside` and `rewind` still skip it (#1383).
- `readPullRequest()` without force answers a fact minutes old: a verb acting on a check passes force, while merge keeps the held fact on purpose (#1466, #1718).
- `mergeIn()` refuses while the lead has a turn running, leaving out the asking thread's own turn, since its tool call runs inside it (#1476).
- Three roads make a worktree record: all go through `worktreeRecordAt()`, which keeps `madeFor`, or the thread's own tree refuses it (#1607).
- `ls-remote --exit-code` exits 2 for a branch never pushed as well as one deleted: ask `branchGoneAtRemote()` (#1607).
- A daemon op on a folder outside the home needs it in the roots file first. `writeDaemonRoots()` writes it whole from every live checkout; the import road writes it through `kind.roots` with its two paths alone (#1607, #1645, #1774).
- A folder record no thread names stands on nothing: count with `bareFolder()` (`packages/protocol/src/projects.ts`); the recipe's `removeFolder` still counts every record (#1634).
- A new kind of turn row is counted in `turnWritten()` and skipped while replaying, or a restart writes it twice (#1577, #1613, #1644).
- A prompt held back at launch goes in the seed file on disk, never in memory alone (#1620, #1665).
- `end()` hands `settleCut()` a fresh literal: change the row through its entry in `sessions` (#1646).
- A turn's rows carry the agent's session id (`claudeSessionId`) while `sessions` is keyed by the id the launch was given, which a Codex thread's first process does not share: an op that takes an id off a row looks up both, as `answer()` does (#1776).
- `sharedFolder()` compares the cwd exactly, so two threads in subfolders of one repo read as not sharing it (#1664).
- Trim a transcript with `dropOldest()`, and set aside any blob that does not parse or that the table refuses (#1520, #1666, #1722).
- An undo is wsp's only when its owner row reads installed, never when any id of its group does (#1481).
- A vault value reaches a computer somebody owns on stdin with `withEnvFromInput()` (`packages/engine/src/run-env.ts`), and a clone there runs no setup-git (#1482).
- A daemon or CLI one version behind still answers: gate a new op or flag on its version, and fake a missing op as the daemon refuses it (#1484, #1613).

## One home for

| Rule | File | Function |
|---|---|---|
| what a caller may see and drive | `src/account/rules.ts` | `refusalFor()` |
| the folder a turn or a command starts in | `src/machines/kinds.ts` | `threadFolder()` |
| a git host read for a workspace | `src/account/pull-requests.ts` | `readHost()` |
| a git host named from a remote | `packages/catalog/src/git-hosts.ts` | `gitHostOf()` |
| a computer busy with a setup | `src/places/setup.ts` | `settingNow()` |
