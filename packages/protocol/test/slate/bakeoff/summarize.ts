// SPDX-License-Identifier: AGPL-3.0-only
// Folds results/runs and the hand judgments into results/results.json and results/table.md.
// Run from packages/protocol: npx tsx test/slate/bakeoff/summarize.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPTS } from "./prompts.js";
import type { Run } from "./run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const runs = readdirSync(join(RESULTS, "runs")).filter(f => f.endsWith(".json")).sort()
  .map(f => JSON.parse(readFileSync(join(RESULTS, "runs", f), "utf8")) as Run);
/** One line per valid slate: does it do what the prompt asked. Keyed agent-syntax-prompt. */
const judged: Record<string, string> = existsSync(join(HERE, "judgments.json")) ? JSON.parse(readFileSync(join(HERE, "judgments.json"), "utf8")) as Record<string, string> : {};
const key = (r: Run): string => `${r.agent}-${r.syntax}-${r.prompt}`;

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
const groups = [...new Set(runs.map(r => `${r.syntax}|${r.agent}`))].sort();
const summary = groups.map(g => {
  const [syntax, agent] = g.split("|");
  const rs = runs.filter(r => r.syntax === syntax && r.agent === agent);
  return {
    syntax, agent, model: rs[0]!.model, runs: rs.length,
    firstValid: rs.filter(r => r.firstValid).length,
    validWithinTwo: rs.filter(r => r.validWithinTwo).length,
    meanSlateTokens: mean(rs.map(r => r.writes[0]!.slateTokens)),
    meanApiOutputTokens: mean(rs.map(r => r.writes[0]!.apiOutputTokens ?? 0)),
    referenceTokens: rs[0]!.referenceTokens,
  };
});

const codes = (syntax: string): [string, number][] => {
  const count = new Map<string, number>();
  for (const r of runs.filter(x => x.syntax === syntax)) for (const w of r.writes) for (const e of w.errors) {
    const k = `${e.code} ${e.name}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]);
};

writeFileSync(join(RESULTS, "results.json"), `${JSON.stringify({ summary, errorCodes: { lines: Object.fromEntries(codes("lines")), jsx: Object.fromEntries(codes("jsx")) }, runs: runs.map(r => ({ ...r, judgment: judged[key(r)] })) }, null, 2)}\n`);

const md: string[] = [
  "# Slate syntax bake-off",
  "",
  "Each prompt written once per syntax per agent from the reference alone; a refused write gets the validator's errors once. Tokens are the first write's slate, characters / 4; API tokens are what the agent reported for that call, thinking included.",
  "",
  "| syntax | agent | first try valid | valid within two | mean slate tokens | mean API output tokens | reference tokens |",
  "|---|---|---|---|---|---|---|",
  ...summary.map(s => `| ${s.syntax} | ${s.agent} (${s.model}) | ${s.firstValid}/${s.runs} | ${s.validWithinTwo}/${s.runs} | ${s.meanSlateTokens} | ${s.meanApiOutputTokens} | ${s.referenceTokens} |`),
  "",
  "## Error codes, every write",
  "",
  ...(["lines", "jsx"] as const).map(s => `- ${s}: ${codes(s).map(([c, n]) => `${c} x${n}`).join(", ") || "none"}`),
  "",
  "## Every run",
  "",
  "| prompt | agent | syntax | first write | second write | slate tokens | does it do what was asked |",
  "|---|---|---|---|---|---|---|",
  ...PROMPTS.flatMap(p => runs.filter(r => r.prompt === p.id).map(r => {
    const w = (i: number): string => { const x = r.writes[i]; return x === undefined ? "" : x.valid ? "valid" : x.errors.map(e => e.code).join(" "); };
    return `| ${p.id} | ${r.agent} | ${r.syntax} | ${w(0)} | ${w(1)} | ${r.writes[0]!.slateTokens} | ${judged[key(r)] ?? ""} |`;
  })),
  "",
];
writeFileSync(join(RESULTS, "table.md"), md.join("\n"));
console.log(md.slice(0, 14).join("\n"));
