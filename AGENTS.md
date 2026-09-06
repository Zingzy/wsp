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

Adding or renaming a verb, a flag or a tool input touches the table, the tool
and the skill row in one change. The check is

```
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 packages/host/test/parity.test.ts packages/host/test/skill.test.ts
```
