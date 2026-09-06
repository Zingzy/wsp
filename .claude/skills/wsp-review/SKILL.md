---
name: wsp-review
description: Review checklist for wsp diffs and PRs, encoding this repo's accumulated laws, gotchas, and decisions. Load before reviewing ANY wsp branch, PR, or diff: ticket work, plan tasks, or external contributions. Covers architecture boundaries, platform gotchas, test discipline, and style laws that generic review misses.
---

# wsp review

Review wsp changes against the laws this project has already paid for. Generic code review finds generic bugs; this checklist finds violations of decisions we made for reasons. Check every section; report findings with file:line, severity (blocker / should-fix / nit), and WHICH LAW is violated so the builder learns the law, not just the fix.

## Architecture boundaries (blockers)

- Dependency arrows are one-way: clients → protocol ← runtime → engine → backend. A client importing engine, or protocol importing anything, is a blocker.
- Wire types have ONE home: @wsp/protocol. Duplicated shapes in daemon/runtime/web are blockers.
- The six web components own their stub file; cross-component edits need coordinator sign-off (check the ticket).
- No UI framework code in terminal data paths (bytes flow daemon → xterm without React re-renders per chunk).
- Backend-specific behavior stays behind MachineBackend + capability flags. Solari assumptions leaking above the engine layer is a blocker.

## Platform laws (from measured PoC/canary findings; RESULTS.md and the solari skill are the evidence)

- Snapshot only first-life machines; wake-via-resurrect resets first-life; never snapshot after a cross-host restore (502s). The lifecycle types enforce this: code working around them is a blocker.
- Guests: `bash -c` never `-lc` (login shells reset PATH); no pgrep (use /proc/[0-9]*/comm); stdin on `claude -p` is closed, or a stream-json channel the runtime writes and closes on purpose, never a silent open pipe; strip CLAUDE_CODE_*/CLAUDECODE env; CLAUDE_CONFIG_DIR never HOME.
- Daemon reach: previewUrl + 10s app-level heartbeats + reconnect-with-resubscribe + inbox.rescan after reconnect. Anything assuming a quiet WS survives their ~30s idle sweep is a bug.
- previewUrl survives naps (we depend on it; canary guards it); tokens expire at 60min (refresh at ~50).
- Live tests: WSP_LIVE=1 gated, auto-serialized (never add parallelism flags), respect the 2-machine cap, kill everything created, NEVER touch machines labeled poc=ttl-test, verify zero running at the end.
- list() is best-effort (observed flake): fleet truth is persisted IDs + get(id), never list-only logic for correctness.

## Security laws

- The daemon's token is the sole gate on 0.0.0.0. Since #16 (2026-09-05) it travels in the first WebSocket frame, never in a URL; the host mints a fresh token on every start and the daemon reads its token file at every frame. No handler is registered before the auth frame passes and every pre-auth socket carries an error listener (there are tests; don't weaken them). Don't invent auth changes in unrelated PRs; #153 owns the pre-auth payload cap and per-port scoping.
- No bearers in URLs on OUR protocol (first-frame auth or 5-min single-purpose tickets). previewUrl's pt_token is theirs, not a precedent for us.
- Nothing may collect, store, or proxy Anthropic credentials outside the user's machine/VM (the carve-out we build under). Model traffic never transits our code.
- Never print or commit key material; .env stays gitignored; fake keys in tests look fake (sk-ant-x).
- curl|sh is banned in anything that installs user-chosen software (dotfiles presets pin release binaries by sha256; there is a test). The one exemption is the harness vendor's own installer, GOLDEN_SETUP (claude.ai/install.sh over TLS): it is the supported install path, runs only on a first-life builder, and its invocation is recorded in the manifest as setupSha (which pins which installer ran, not its content; the smoke gate is what proves the result). Do not relitigate it in reviews; do not widen it.

## Test discipline

- TDD for logic (test exists and failed first, or the report says why not); components need render + interaction tests minimum.
- apps/web tests run under jsdom via the root vitest.workspace.ts: don't add per-file environment hacks.
- No cloud in unit tests: fake backends/stores/daemons in-process. The tcp-proxy harness exists for reconnect tests: reuse it.
- `pnpm test` green without creds AND `tsc --noEmit` clean are merge gates. When several gates share the machine and a known timing flake trips, do not re-run the full suite in a loop: one full run with every failing file named, each failing file rerun alone and green, and a note that none of them is in the diff is the evidence; the coordinator's merge gate on an idle machine is the final word. New source files carry `// SPDX-License-Identifier: AGPL-3.0-only`.

## Design laws (web)

- The approved mock is law for layout/feel (prototype/design-direction branch of the tracker). Where the mock is silent, the ticket wins; conflicts get a coordinator ruling, not silent invention.
- Merge law: git rerere is off in this repo (it re-applied a wrong hand resolution across worktrees on 2026-09-06); never trust a "Resolved using previous resolution" line, read both files. A branch that no longer merges onto main gets origin/main merged in by a builder as a merge commit that keeps both sides, with each resolution named in the commit message, and the coordinator reads the remerge diff before gating.
- Extension law (his ruling, 2026-09-06, every component, not only the catalog): anything that varies by kind (machine provider, agent adapter, install road, sign-in kind, project-state resolver, config paths, status check, renderer target) sits behind one interface per concern with one registered module per variant, and adding a variant touches one place: the registry entry and its module. Code that switches on an agent, tool, provider or road id outside the registry and its per-variant modules is a finding. A second copy of a predicate, a path rule, a marker parser or a size rule is a finding: write it once and import it. Interfaces stay small and per concern (a resolver is not also an installer). The catalog is the registry for agents and tools; MachineBackend is the one for providers; the harness adapters are the one for agents' wire protocols. Reviewers name the file and line where a switch or a copy lives.
- Color law: green = running, ONLY; orange = spend/confirm, and the middle weight tier (disk 65 to 75 percent in the app and the wizard, sizes 500 MB to 1 GB in the wizard), ONLY; yellow and red exist only as the tiers beside it; everything else zinc. Terminal pane darker than chrome (content-well inversion) stays.
- Tokens come from tokens.css; no literal colors in components.
- Phase vocab: code says `napping` (protocol), UI may render it as paused/hollow.

## Process laws

- Never kill processes by pattern (`pkill -f`, `killall`) in tests, scripts, or your own cleanup: a pattern built from a shell variable that is empty in a later tool call matched and killed the user's live host once. Start processes with a recorded pid and kill that pid. A pattern kill in a diff or a build log is a should-fix.

- No process language in source comments: no ticket numbers, plan names, or merge-history narration. A comment states a constraint for the next reader; process lives in the tracker.

- Conventional commit subject <72 chars + a why-paragraph; NO co-author trailers.
- One ticket = one branch = one session; branch names ticket/<n>-<slug>; worktrees under ~/wsp/.claude/worktrees/ (never /tmp).
- Builders never merge to main; the coordinator merges. Builders push their ticket branch at the first commit and open a draft PR on Zingzy/wsp titled after the ticket, mark it ready when the build report is posted, and push every amend. Main pushes are coordinator-only. PR bodies: ticket link, what it does, status; no em-dashes, no tool names.
- Self-review before any report. Before posting a build or fix report, the builder reviews its own diff with the wsp-pr-review procedure: read every changed file whole, probe each acceptance item and each ruling against a fresh fake HOME or fake backend, walk the silent-bugs list, and revert the fix to prove each new test goes red. Findings are fixed before the report exists, and the report says the self-review ran and what it caught. A report without that line is incomplete.
- Re-fetch before reporting. A fix report is written against the ticket as it is at posting time, not as it was when the round started: re-read every comment posted since the last report and address each review round by number, each item fixed or declined with a reason. Reviews arrive while fixes are in flight; a report that misses one is incomplete.
- A report is text on the ticket. A comment whose body is a file path, a placeholder or a pointer to a local file is not a report; the builder re-reads the posted comment after posting and confirms it holds the report before replying to the coordinator.
- Never `gh issue comment --edit-last`. Every account here shares one GitHub login, so the last comment is often the coordinator's ruling; twice a builder overwrote a ruling with its report. Edit a comment by its id (`gh api -X PATCH repos/.../issues/comments/<id>`) and re-read it afterwards.
- Only the reviewer who opened a thread resolves it. Builders reply on PR threads with the sha and what changed; they never resolve.
- Rulings live on the ticket. A ruling the coordinator gives in a private message or a pre-review is posted as its own ticket comment before the builder acts on it; a report may quote it but cannot be its only home.
- Coordinator pre-review. The coordinator runs a cold reviewer on the branch before handing it to the user's reviewer; that reviewer posts nothing and returns findings to the builder. The user sees a branch only after it survived one full review.
- Deviations from plan/ticket are fine when reality wins, but MUST be reported in the ticket comment: an unreported deviation is a should-fix even when the code is right.
- Comments in code state constraints code can't show, with the source (a law, a measured finding): no narration, no TODO/FIXME/HACK.

## Verdict format

End with: BLOCKERS (n) / SHOULD-FIX (n) / NITS (n), one line each with file:line and the law violated, then MERGE / MERGE-AFTER-FIXES / NEEDS-REWORK. If everything passes, say what the diff did WELL against this list: reviewers who only find faults train builders to hide things.

## A worktree gates only on a base that carries the root vitest config

Since 2026-09-04 main has a root `vitest.config.ts` (from #104). A worktree on a branch that predates it has none, and vitest walks up to `~/wsp`, takes the main checkout as its root and aliases `@wsp/*` to the main checkout's sources. Two builders (#103, #115) watched their tests run against main's protocol and pass or fail for the wrong reason. Before any gate counts, the branch is rebased onto a main that carries the file (`test -f vitest.config.ts` in the worktree root is the check). Reviewers' fresh worktrees merge origin/main first, so their gates were never exposed.

## Long runs on this Mac: what is not installed

`timeout` and `setsid` do not exist on macOS. A gate launched as `timeout 900 pnpm test` or `nohup setsid gate.sh` dies at once and leaves an empty status file that reads as "still running" until someone checks the pid (#104's canary and #110's gate both lost an hour this way). Detach with `nohup sh -c '...' > log 2>&1 &`, record `$!`, and confirm it is alive with `kill -0` before waiting on it; bound a step with the tool's own timeout, not a coreutils one.

## A fix round is its own comment

Appending a fix round to the build report by id hides it: the reviewer reads the ticket top down and the last comment is still the ruling, so the round reads as unanswered (#111 round 2, 2026-09-05). Every fix round is a new comment titled `Fix round N (review round N)` with the sha, each finding by number, the self-review line, and whether a live run was repeated for the changed path. Edit by id only to correct a comment's own text, never to add a round to it.

## Gates cost one run, not three

A builder's gate skips the Electron packaging unless the diff touches apps/desktop: `pnpm -r --filter '!@wsp/desktop' build` for the build step, then `pnpm test`, `pnpm -r exec tsc --noEmit`, `pnpm --filter @wsp/web build`. The desktop package builds in the coordinator's merge gate, which always runs the full `pnpm build`. The coordinator's merge gate runs once, on the branch merged with origin/main in a fresh worktree; the merge onto main then re-checks that origin/main has not moved, merges, builds and pushes without a second test run, since the gated tree and the merged tree are the same. A flaky file that fails in the gate is rerun alone in that worktree before the chain continues.

## Live runs stay out of builders' worktrees, and builders add by path

The coordinator ran a live canary inside a builder's worktree (PR 39, 2026-09-05) and the builder's next `git add -A` committed the canary script, log, pid and output; the second-pass review caught it as a blocker and cost a round. Coordinator live runs happen in a coordinator worktree (`gate-*` or a `live-*` tree), never a builder's. Builders stage by path (`git add <files>`), never `-A` or `.`, and their self-review reads `git show --stat` of every commit in the round so a stray file is seen before the report exists.

## Red-proofs never use git stash, and kill only a pid you recorded

Two builders' red-proof runs did `git stash push` on already-committed paths (which stashes nothing) followed by `git stash pop`, which popped the repository's shared stash into their worktree (2026-09-05, twice). The stash is one list for every worktree; nobody touches it. A red-proof runs the new tests against the base in a throwaway worktree (`git worktree add --detach <tmp> <base>`, copy the test files in, run, remove), or reverts a committed source file with `git checkout <base> -- <file>` and restores it with `git checkout HEAD -- <file>` only after everything is committed. A builder also killed another builder's dev server after finding its pid by port: kill only a pid you started and recorded, never one found by port, name or pattern, and pick your ports per worktree.
