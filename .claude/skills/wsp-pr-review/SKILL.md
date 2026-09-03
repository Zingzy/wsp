---
name: wsp-pr-review
description: Review a wsp pull request from just its number or URL. Maps the PR to its wayfinder ticket on Zingzy/wsp-map and the plan it serves, reviews the diff for ticket fidelity, product behaviour, blast radius, silent bugs and library misuse, runs the gates, then posts a full internal review on the ticket and a short code-only review on the PR. Use when asked to "review PR 3", "review #3", or given a github.com/Zingzy/wsp/pull URL.
---

# wsp PR review

You get a PR number. You leave two comments: the whole truth on the ticket, and a short code review on the PR that would read fine in a public repo. Load `wsp-review` first; it holds the laws. This skill is the procedure around them.

## 1. Resolve the PR to its ticket and plan

```
gh pr view <n> --repo Zingzy/wsp --json number,title,headRefName,body,isDraft,url,commits,files
```

- Branch `ticket/<t>-<slug>` gives the ticket number `t` on Zingzy/wsp-map. If the branch is not shaped like that, take the `Ticket:` link from the PR body. If neither exists, stop and say so; do not review blind.
- Read the ticket and every comment on it: `gh issue view <t> --repo Zingzy/wsp-map --json title,body,comments`. Comments carry three things you need: coordinator rulings (they refine or override the body), the build report (gates, deviations, what was run live), and earlier review rounds.
- The ticket body names its plan ("Plan 5 task 3", a `plans/0N-*.md` link). Fetch that plan at HEAD of the `plans` branch, never from memory or a local copy:
  `gh api "repos/Zingzy/wsp-map/contents/plans/0N-name.md?ref=plans" -q .content | base64 -d`
  Read the task the ticket cites and the section around it. Map #1 on wsp-map holds the decisions batches and the later list; skim it when the ticket touches a decided question.
- If `gh` cannot reach api.github.com, rerun the same command once with the sandbox disabled. It is an environment quirk, not a permissions problem.

## 2. Get the code in front of you

- Worktree under `~/wsp/.claude/worktrees/review-<t>` from the PR branch. Never `/tmp`.
- Merge `main` into it in a throwaway commit first. Conflicts are a finding (say which files). A branch on a stale main hides integration bugs, so the review runs on the merged tree.
- `pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm -r exec tsc --noEmit`. Tests need the build first (bin-signals). Record the numbers.
- Read the whole diff, not the PR description of it. `gh pr diff <n> --repo Zingzy/wsp`. Then read every changed file in full, not just the hunks; the bug is usually in the line above the hunk.

## 3. How to think

Work through these in order and write findings as you go. A finding is file:line, what goes wrong, the concrete input or state that triggers it, and the one-line fix.

**Ticket fidelity.** Walk the ticket's acceptance list item by item. Each is met, deviated with a stated reason in the build report, or missing. A deviation nobody reported is a finding even when the code is right. A ticket item quietly narrowed ("the live run was skipped") is a finding.

**Plan alignment.** Does the change move the plan the way the plan says, or does it invent a shape the plan did not decide? Where the ticket and the plan disagree, the ticket wins if a coordinator ruling says so, otherwise flag it and ask for the ruling on the ticket. Do not rule yourself.

**Product view.** Sit in the chair of the person running this. For the path the change touches: what do they see on the first run, on a slow run, on failure, on rerun? Is every string plain and true? Does anything boot a machine, upload bytes, or delete state, and does the person know before it happens? Is the step idempotent and resumable, since the remote will drop mid-way one day? Is cost visible? A change that works but leaves the person guessing what happened is not done.

**Blast radius.** Load `blast-radius`. For every changed export, grep the callers across the monorepo. Then check the shapes that outlive a process: protocol types, event names and payloads, persisted files under WSP_HOME (recipe, state, pointer files), snapshot recipes, capability flags, CLI flags. A change to any of those needs either a migration, a reader that accepts both, or a note that nothing shipped reads the old shape. Mark each risk reversible or not: killing a machine, dropping a snapshot, deleting a file, uploading to a golden are not reversible.

**Silent bugs.** These are the ones that pass tests and bite later. Look for each explicitly:
- swallowed errors: empty `catch`, `.catch(() => {})`, a result checked for truthiness that can legitimately be falsy
- defaults that hide missing data: `?? 0`, `|| ''`, `?.length ?? 0` where the missing case should fail loudly
- time: `setTimeout`-based waits where an event or condition exists, polling that never fires because the poller resets the clock (the idle bug), clocks reset by a repeated event (the deploying-daemon bug)
- unawaited promises, fire-and-forget writes, listeners added on every reconnect without removal
- width and truncation off by one; paths built with string concatenation instead of `path.join`; `HOME` read from env instead of the injected host
- process scope too wide: a sweep, kill, or delete that matches things it did not create (the builder sweep, the pattern kill)
- retries without a cap, backoff without jitter on a shared platform
- tests that assert on what they set up, mocks that never exercise the real branch, `it.skip`, `it.only`, a test that passes with the change reverted (try that for the core test)
- `--yes` and non-TTY paths taking a different route than the interactive one

**Read the docs of what the code uses.** Do not trust the PR's description of a library or platform API. For every API the diff calls, open the source of truth: `node_modules/<pkg>` types and README at the version in the lockfile, the platform notes in the `solari` skill (`references/api.md` holds measured behaviour that beats the vendor docs), Node's own docs for fs and child_process edge cases. Verify option names, default values, what happens on error, and whether the call blocks. When the behaviour is uncertain, run a ten-line script and read the value. `clack`'s `initialValue` semantics, Solari's `createdAt` resetting on resume, and Homebrew on Linux's PATH have each cost a round of review because someone reasoned instead of running.

**Security and credentials.** Token paths, Keychain reads, anything printed or logged, license notices on vendored data, SPDX headers on new files. The laws are in `wsp-review`; check each one against the diff rather than skimming.

**Laws.** Every section of `wsp-review`, applied to the diff. Name the law next to the finding so the builder learns the law.

## 4. Severity

There is one severity: fix it. Nits get fixed too, every time, so do not sort findings into blocker, should-fix and nit; the ladder only invites arguing about the bottom rung. List every finding as something to change before merge, ordered by how much breaks if it ships. Say plainly when something is a preference rather than a bug, and still list it.

Verdict is one of: MERGE (no findings), FIX THEN MERGE (findings, none needs a redesign), REWORK (the approach is wrong for the ticket or plan). Never merge or approve for merge yourself; merging is the coordinator's job.

## 5. What you do not care about

- CI status on the PR. Checks may be red, missing, or stale; you ran the gates in your worktree and those numbers are the truth. Never wait on checks, never cite them.
- Whether the PR is a draft. Review what is there.
- Commit count or commit shape on the branch; the coordinator squashes or keeps as they see fit. Commit messages still follow the laws (subject length, why paragraph, no trailers, no em-dashes) and a violation is a finding.

## 6. Existing comments

Before posting, read what is already on both sides.

- Ticket: earlier review rounds and the builder's replies. Do not re-raise what was fixed; say "fixed since last round" for each earlier finding you re-checked.
- PR review threads:
  ```
  gh api graphql -f query='query{repository(owner:"Zingzy",name:"wsp"){pullRequest(number:<n>){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:5){nodes{body author{login}}}}}}}}'
  ```
  For each unresolved thread: if the code it points at was fixed or the concern no longer applies on the merged tree, reply with one line saying why and resolve it:
  ```
  gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<id>"}){thread{isResolved}}}'
  ```
  If it still applies, leave it open and fold it into this round's list. Do not resolve a thread you did not check.

## 7. Post, always

Post both comments every time, even when the gate failed, even when you are unsure about a finding, even when the verdict is REWORK. A review that stays in the terminal helps nobody. Mark uncertainty inside the finding ("could not reproduce; reasoning from the clack source") rather than by holding it back.

**On the ticket (wsp-map), one comment, the full review:**
verdict; ticket fidelity per acceptance item; plan alignment and any ruling you need from the coordinator; every finding with file:line and the law; gate numbers from your worktree; what you ran live and what it showed (machine ids you created and killed, never anything you did not create); threads resolved on the PR and why; a line on what the diff did well. Link the PR.

**On the PR (Zingzy/wsp), the code review only:**
```
gh pr review <n> --repo Zingzy/wsp --comment --body "..."         # or --request-changes when there are findings
```
Inline comments for findings that point at a line, via the review API with `path`, `line`, `side: RIGHT`. Rules for everything on the PR:
- One-line summary first, then the findings, each two sentences at most: what breaks, how to fix.
- Only about the code and its behaviour. No plan names, no plan text, no ticket text, no rulings, no build-report quotes, no process laws by name, no wsp-map links beyond the one already in the PR body, nothing about coordinators, builders, sessions, or agents.
- The PR must read like a review in a public repository, because this one will be.
- Sentence case, plain words, no em-dashes, no praise, no emoji.
- Never approve. Use comment or request changes.

## 8. Re-review

When the builder pushes fixes: diff only since your last review (`gh pr diff` against the sha you reviewed), re-run the gates on the merged tree, check each earlier finding off by name, resolve the PR threads you opened that are now fixed, and post a short round-two comment on both sides in the same shape. Do not re-review the parts that did not change unless the fix touched them.

## 9. Do not

- Edit the branch. You review; the builder fixes. If the request says "review and fix", commit fixes on the branch with amend, push with force-with-lease, and say in both comments exactly what you changed.
- Touch machines you did not create. Kill only by recorded id. Never label anything `poc`.
- Reason about platform behaviour you could measure in a minute.
- Soften a finding because the build report sounds confident.
