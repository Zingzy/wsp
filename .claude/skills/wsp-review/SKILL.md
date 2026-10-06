---
name: wsp-review
description: Review checklist for wsp diffs and PRs, encoding this repo's accumulated laws, gotchas, and decisions. Load before reviewing ANY wsp branch, PR, or diff: ticket work, plan tasks, or external contributions. Covers architecture boundaries, platform gotchas, test discipline, and style laws that generic review misses.
---

# wsp review

Review wsp changes against the laws this project has already paid for. Generic code review finds generic bugs; this checklist finds violations of decisions we made for reasons. Check every section; report findings with file:line, severity (blocker / should-fix / nit), and WHICH LAW is violated so the builder learns the law, not just the fix.

## Architecture boundaries (blockers)

- Dependency arrows are one-way: clients → protocol ← runtime → engine → backend. A client importing engine, or protocol importing anything, is a blocker.
- Wire types have ONE home: @wsp/protocol. Duplicated shapes in daemon/runtime/web are blockers.
- The six web components own their stub file; cross-component edits need a ruling on the ticket from whoever lands the change.
- No UI framework code in terminal data paths (bytes flow daemon → xterm without React re-renders per chunk).
- Backend-specific behavior stays behind MachineBackend + capability flags. Solari assumptions leaking above the engine layer is a blocker.

## Platform laws (from measured PoC/canary findings; RESULTS.md and the solari skill are the evidence)

- Snapshot only first-life machines; a wake never replaces a machine, only a rebuild and an image move do (each resets first-life); never snapshot after a cross-host restore (502s). The lifecycle types enforce this: code working around them is a blocker.
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
- curl|sh is banned in anything that installs user-chosen software, and no road downloads a script and runs it: every release and vendor row names the artifact it installs and a sha256 per arch from the catalog's pins table (packages/catalog/src/release-pins.ts, the casks' own pins, the harness pin in roads.ts), checked with sha256sum before the unpack; the harness itself is the vendor's binary at a pinned version with the sums the vendor's manifest publishes, GOLDEN_SETUP, run on a first-life builder and recorded in the manifest as setupSha. A row that reads a vendor's current version off the network, a release road with no tag, or a download piped into a shell is a finding. A pin moves by a bump of the table (node packages/catalog/scripts/pin-release.mjs <repo> <tag>), never by a road reading latest.

## Threat model (blockers)

An agent writes everything in a workspace: its files, its links, its `.git`, its branch names. On a computer that holds workspaces the daemon runs as root over them. Code that trusts what is in a workspace is a blocker, and so is a second copy of one of these rules.

- Open a file inside a workspace by descriptor, with no link followed and a regular-file check: `write_file_inside`, `write_file_in` and `open_inside` in `daemon/crates/wsp-runtime/src/bundle.rs`, the leaf open in `fs::write_file`, and `git/stored.rs` for a stopped copy. A write by path in the daemon's root paths fails `daemon/crates/wsp-daemon/tests/threat_model.rs` unless its function is named there with the reason.
- Resolve a path, then use and store the resolved one, never the name asked for: `paths::resolve_inside` answers the realpath it checked.
- Cap every read of a file an agent wrote: `git/stored.rs` caps each ref, config, list and object, and `ssh_host_key_inside` never reads past the longest key.
- `--` or `--end-of-options` before every git operand an agent chose: build the line with `GitLine` (`daemon/crates/wsp-runtime/src/git_line.rs`); its own words are `&'static str`, and the threat model test refuses git run any other way.
- Allowlist the environment, never denylist it: start from `env_clear()` and add the names meant, as `exec::run_exec` does.
- Name tools by full path in anything detached or run as root: `apps/desktop/src/self-update.ts` runs `/usr/bin/ditto`, `/usr/bin/codesign` and `/usr/bin/plutil`.
- Fence agent text by its length, never a fixed marker: `fenceFor` in `packages/protocol/src/quote.ts`.
- Never fetch while rendering agent content: `namesAnAddress` in `apps/web/src/components/chat/MermaidBlock.tsx` refuses a diagram that names an address before Mermaid draws it.

## Test discipline

- TDD for logic (test exists and failed first, or the report says why not); components need render + interaction tests minimum.
- apps/web tests run under jsdom via the root vitest.workspace.ts: don't add per-file environment hacks.
- No cloud in unit tests: fake backends/stores/daemons in-process. The tcp-proxy harness exists for reconnect tests: reuse it.
- `pnpm test` green without creds AND `tsc --noEmit` clean are the landing gate's rules: it runs them once, on the change merged with main, and its run is the final word. A builder's own gate is the files it touched (below). New source files carry `// SPDX-License-Identifier: AGPL-3.0-only`. Generated files carry no SPDX line: `packages/protocol/src/generated` is what the protocol crate writes, and a header there is a hand edit the CI diff refuses.

## Design laws (web)

- The design language is the wsp-design skill (`.claude/skills/wsp-design/`), and its locked mockup in `references/mockup/` is law for layout and feel. Load it for any diff that touches apps/web. Where the mock is silent, the ticket wins; conflicts get a ruling on the ticket, not silent invention.
- Merge law: git rerere is off in this repo (it re-applied a wrong hand resolution across worktrees on 2026-09-06); never trust a "Resolved using previous resolution" line, read both files. A branch that no longer merges onto main gets origin/main merged in by a builder as a merge commit that keeps both sides, with each resolution named in the commit message, and whoever lands the change reads the remerge diff before gating.
- Extension law (his ruling, 2026-09-06, every component, not only the catalog): anything that varies by kind (machine provider, agent adapter, install road, sign-in kind, project-state resolver, config paths, status check, renderer target) sits behind one interface per concern with one registered module per variant, and adding a variant touches one place: the registry entry and its module. Code that switches on an agent, tool, provider or road id outside the registry and its per-variant modules is a finding. A second copy of a predicate, a path rule, a marker parser or a size rule is a finding: write it once and import it. Interfaces stay small and per concern (a resolver is not also an installer). The catalog is the registry for agents and tools; MachineBackend is the one for providers; the harness adapters are the one for agents' wire protocols. Reviewers name the file and line where a switch or a copy lives.
- Color law: the wsp-design skill's token table names every colored use in the app (the four `--status-*` thread tokens with a working thread in rose pink, `--warning` for a cloud's Full and At limit, `--error-foreground` for a refusal sentence, `--success` for the agents panel's sign-in dot, and a slate piece's good, warning, bad, info and one accent tone on its words, figures and meter fills), and a use it does not name is a finding. Outside that table: green = a running machine or workspace, and a line count's additions, ONLY; red = a destructive confirm, the top weight tier, and a line count's deletions, ONLY (line counts are the added and deleted lines on the changed-files card under a reply, the Changes pane and the PR pane, in `--success` and `--error-foreground`: his ruling, 2026-10-01, on wsp-map#1560); orange = spend, and the middle weight tier (disk 70 to 90 percent, sizes 200 MB to 1 GB), ONLY; yellow exists only as the tier between (yellow from 50 MB, red from 1 GB and from 90 percent of the disk); the tables live in the protocol (`sizeTone`, `diskTone` in format.ts) and the app and the wizard both read them; everything else zinc. Terminal pane darker than chrome (content-well inversion) stays.
- Destructive tier (his ruling, 2026-09-22): an act after which something does not come back is neutral where it stands, as every other action in a row or a slot is, and takes the danger ink and edge on hover; red stands at rest only on the confirmation's own button, which is the solid `destructive` variant. A destructive act never wears the accent, and there is one destructive tier for the whole app: remove a computer, remove a project, revoke a device, end a workspace.
- Tokens come from tokens.css; no literal colors in components.
- Phase vocab: code says `napping` (protocol), UI may render it as paused/hollow.

## Process laws

- Never kill processes by pattern (`pkill -f`, `killall`) in tests, scripts, or your own cleanup: a pattern built from a shell variable that is empty in a later tool call matched and killed the user's live host once. Start processes with a recorded pid and kill that pid. A pattern kill in a diff or a build log is a should-fix.

- No process language in source comments: no ticket numbers, plan names, or merge-history narration. A comment states a constraint for the next reader; process lives in the tracker.

- Conventional commit subject <72 chars + a why-paragraph; NO co-author trailers.
- One ticket = one branch = one worktree. A builder works in its own worktree and writes nothing outside it except under a `mktemp -d`; it never runs git reset, clean or checkout -f anywhere else.
- Builders never merge to main and never push it. When the change is done the builder pushes its branch and opens one PR on Zingzy/wsp (CI runs only on a PR).
- PR bodies, the one rule: the body names its wsp-map ticket (`wsp-map#<n> stays open`, or the issue link), says what the change does and its status, and carries no attribution footer (no "Generated with" line, no robot emoji), no em dashes and no tool names. The ticket number belongs in the body; the no-ticket-numbers rule is for code comments. `scripts/pr-body-check.mjs` refuses a body that breaks this, in CI and by hand (`node scripts/pr-body-check.mjs <file>`).
- Self-review before any report. Before posting a build or fix report, the builder reviews its own diff with the wsp-pr-review procedure: read every changed file whole, probe each acceptance item and each ruling against a fresh fake HOME or fake backend, walk the silent-bugs list, and revert the fix to prove each new test goes red. Findings are fixed before the report exists, and the report says the self-review ran and what it caught. A report without that line is incomplete.
- Re-fetch before reporting. A fix report is written against the ticket as it is at posting time, not as it was when the round started: re-read every comment posted since the last report and address each review round by number, each item fixed or declined with a reason. Reviews arrive while fixes are in flight; a report that misses one is incomplete.
- A report is text on the ticket. A comment whose body is a file path, a placeholder or a pointer to a local file is not a report; the builder re-reads the posted comment after posting and confirms it holds the report before replying.
- Never `gh issue comment --edit-last`. Every account here shares one GitHub login, so the last comment is often a ruling; twice a builder overwrote a ruling with its report. Edit a comment by its id (`gh api -X PATCH repos/.../issues/comments/<id>`) and re-read it afterwards.
- Only the reviewer who opened a thread resolves it. Builders reply on PR threads with the sha and what changed; they never resolve.
- Rulings live on the ticket. A ruling given in a private message or a pre-review is posted as its own ticket comment before the builder acts on it; a report may quote it but cannot be its only home.
- Pre-review. Whoever lands the change runs a cold reviewer on the branch before handing it to the owner's reviewer; that reviewer posts nothing and returns findings to the builder. The owner sees a branch only after it survived one full review.
- Deviations from plan/ticket are fine when reality wins, but MUST be reported in the ticket comment: an unreported deviation is a should-fix even when the code is right.
- A fix round for a finding caused by an unknown rule, a regression or knowledge only the code held adds one line to that area's AGENTS.md (packages/runtime, packages/host, packages/protocol, apps/web, daemon) in the same commit; check the line is there and true, and its absence is a should-fix.
- Comments in code state constraints code can't show, with the source (a law, a measured finding): no narration, no TODO/FIXME/HACK.

## Verdict format

End with: BLOCKERS (n) / SHOULD-FIX (n) / NITS (n), one line each with file:line and the law violated, then MERGE / MERGE-AFTER-FIXES / NEEDS-REWORK. If everything passes, say what the diff did WELL against this list: reviewers who only find faults train builders to hide things.

## A worktree gates only on a base that carries the root vitest config

Since 2026-09-04 main has a root `vitest.config.ts` (from #104). A worktree on a branch that predates it has none, and vitest walks up to `~/wsp`, takes the main checkout as its root and aliases `@wsp/*` to the main checkout's sources. Two builders (#103, #115) watched their tests run against main's protocol and pass or fail for the wrong reason. Before any gate counts, the branch is rebased onto a main that carries the file (`test -f vitest.config.ts` in the worktree root is the check). Reviewers' fresh worktrees merge origin/main first, so their gates were never exposed.

## Long runs on a Mac: what is not installed

`timeout` and `setsid` do not exist on macOS. A gate launched as `timeout 900 pnpm test` or `nohup setsid gate.sh` dies at once and leaves an empty status file that reads as "still running" until someone checks the pid (#104's canary and #110's gate both lost an hour this way). Detach with `nohup sh -c '...' > log 2>&1 &`, record `$!`, and confirm it is alive with `kill -0` before waiting on it; bound a step with the tool's own timeout, not a coreutils one.

## A fix round is its own comment

Appending a fix round to the build report by id hides it: the reviewer reads the ticket top down and the last comment is still the ruling, so the round reads as unanswered (#111 round 2, 2026-09-05). Every fix round is a new comment titled `Fix round N (review round N)` with the sha, each finding by number, the self-review line, and whether a live run was repeated for the changed path. Edit by id only to correct a comment's own text, never to add a round to it.

## A builder's gate is the files it touched

A builder builds the packages and runs, at two workers, the test files its change touches plus `packages/host/test/memory.test.ts` and `packages/protocol/test/stub-script.test.ts`: `pnpm exec vitest run --minWorkers=1 --maxWorkers=2 <files>`. A change to anything a tool lists or answers with (a tool input, an output shape, a schema an answer embeds) also runs `packages/host/test/mcp-record.test.ts`, and a stale record is regenerated with the lines it prints and committed. A verb, flag or tool input change also runs AGENTS.md's parity, skill and contract check. A test that times out is rerun alone before it counts as a failure. Never the whole suite: several builders running it at once on one computer starve it and fail the timing tests (2026-10-05); the landing gate runs it once, on the change merged with main. Every test stops what it starts, even when it fails. A gate is waited for in the same turn: a run left going when the turn ends is a report with no gate (2026-09-11, twice).

A live check runs on a throwaway host only: `env -i`, `--state <mktemp>/state.json` alone, never `WSP_HOME`, never the person's `~/.wsp`; the builder stops what it started and confirms with `ps`.

## Live runs stay out of builders' worktrees, and builders add by path

A live canary once ran inside a builder's worktree (PR 39, 2026-09-05) and the builder's next `git add -A` committed the canary script, log, pid and output; the second-pass review caught it as a blocker and cost a round. Live runs by whoever lands the change happen in their own worktree (`gate-*` or a `live-*` tree), never a builder's. Builders stage by path (`git add <files>`), never `-A` or `.`, and their self-review reads `git show --stat` of every commit in the round so a stray file is seen before the report exists.

## Red-proofs never use git stash, and kill only a pid you recorded

Two builders' red-proof runs did `git stash push` on already-committed paths (which stashes nothing) followed by `git stash pop`, which popped the repository's shared stash into their worktree (2026-09-05, twice). The stash is one list for every worktree; nobody touches it. A red-proof runs the new tests against the base in a throwaway worktree (`git worktree add --detach <tmp> <base>`, copy the test files in, run, remove), or reverts a committed source file with `git checkout <base> -- <file>` and restores it with `git checkout HEAD -- <file>` only after everything is committed. A builder also killed another builder's dev server after finding its pid by port: kill only a pid you started and recorded, never one found by port, name or pattern, and pick your ports per worktree.
