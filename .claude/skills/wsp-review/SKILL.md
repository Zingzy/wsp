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
- Guests: `bash -c` never `-lc` (login shells reset PATH); no pgrep (use /proc/[0-9]*/comm); close stdin on `claude -p`; strip CLAUDE_CODE_*/CLAUDECODE env; CLAUDE_CONFIG_DIR never HOME.
- Daemon reach: previewUrl + 10s app-level heartbeats + reconnect-with-resubscribe + inbox.rescan after reconnect. Anything assuming a quiet WS survives their ~30s idle sweep is a bug.
- previewUrl survives naps (we depend on it; canary guards it); tokens expire at 60min (refresh at ~50).
- Live tests: WSP_LIVE=1 gated, auto-serialized (never add parallelism flags), respect the 2-machine cap, kill everything created, NEVER touch machines labeled poc=ttl-test, verify zero running at the end.
- list() is best-effort (observed flake): fleet truth is persisted IDs + get(id), never list-only logic for correctness.

## Security laws

- The daemon's query-token is the sole gate on 0.0.0.0: the token check must run before ANY handler registration (there is a test; don't weaken it). Ticket #16 owns the rotation question: don't invent auth changes in unrelated PRs.
- No bearers in URLs on OUR protocol (first-frame auth or 5-min single-purpose tickets). previewUrl's pt_token is theirs, not a precedent for us.
- Nothing may collect, store, or proxy Anthropic credentials outside the user's machine/VM (the carve-out we build under). Model traffic never transits our code.
- Never print or commit key material; .env stays gitignored; fake keys in tests look fake (sk-ant-x).

## Test discipline

- TDD for logic (test exists and failed first, or the report says why not); components need render + interaction tests minimum.
- apps/web tests run under jsdom via the root vitest.workspace.ts: don't add per-file environment hacks.
- No cloud in unit tests: fake backends/stores/daemons in-process. The tcp-proxy harness exists for reconnect tests: reuse it.
- `pnpm test` green without creds AND `tsc --noEmit` clean are merge gates. New source files carry `// SPDX-License-Identifier: AGPL-3.0-only`.

## Design laws (web)

- The approved mock is law for layout/feel (prototype/design-direction branch of the tracker). Where the mock is silent, the ticket wins; conflicts get a coordinator ruling, not silent invention.
- Color law: green = running, ONLY; orange = spend/confirm, ONLY; everything else zinc. Terminal pane darker than chrome (content-well inversion) stays.
- Tokens come from tokens.css; no literal colors in components.
- Phase vocab: code says `napping` (protocol), UI may render it as paused/hollow.

## Process laws

- No process language in source comments: no ticket numbers, plan names, or merge-history narration. A comment states a constraint for the next reader; process lives in the tracker.

- Conventional commit subject <72 chars + a why-paragraph; NO co-author trailers.
- One ticket = one branch = one session; branch names ticket/<n>-<slug>; worktrees under ~/wsp/.claude/worktrees/ (never /tmp).
- Builders never merge to main; the coordinator merges. Ticket branches may be pushed to origin for PR review; main pushes are coordinator-only.
- Deviations from plan/ticket are fine when reality wins, but MUST be reported in the ticket comment: an unreported deviation is a should-fix even when the code is right.
- Comments in code state constraints code can't show, with the source (a law, a measured finding): no narration, no TODO/FIXME/HACK.

## Verdict format

End with: BLOCKERS (n) / SHOULD-FIX (n) / NITS (n), one line each with file:line and the law violated, then MERGE / MERGE-AFTER-FIXES / NEEDS-REWORK. If everything passes, say what the diff did WELL against this list: reviewers who only find faults train builders to hide things.
