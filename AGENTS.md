# Working on wsp

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

`scripts/test-files.sh <file>...` runs the named test files with
`packages/host/test/memory.test.ts` and
`packages/protocol/test/stub-script.test.ts` at two workers, and refuses a run
naming no file or a folder, since either starts the whole suite. `--tools`
adds `packages/host/test/mcp-record.test.ts`, which a change to what a tool
lists or answers needs. `pnpm check:laws` runs the tests that read the whole
tree (the words, parity, skill, contract and record tests and their kin) and
`cargo fmt --check` when daemon/ changed. `scripts/pre-review.sh [<ticket>]`
is the last command before a branch is called ready: it checks that the branch
holds origin/main and is one commit ahead of it, the commit message, the diff
against the pre-commit hook's rules and for pattern kills, the laws, the size
check and the touched tests, and exits nonzero on any failure. It also runs
the branch's test files on the merge-base and says which go red there, and
given a ticket number prints each acceptance item and ruling the report has to
answer. `--build` builds `@wsp/host` and the packages it loads first, which a
fresh checkout needs before the laws can pass. `scripts/heavy.sh <command>`
runs a command in one of two slots on a Mac, so builders working at once queue
their tsc, `tsup --dts`, builds and test runs instead of swapping; both
scripts put their own vitest and cargo runs through it.
