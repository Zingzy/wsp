// SPDX-License-Identifier: AGPL-3.0-only
// One host's month in the shape an owner's host answered: wsp's threads beside a
// far larger use the agents logged outside wsp, split by source and by account,
// outside wsp counted in both. The command line's table and the Usage page are
// each tested against these answers.
import type { UsedAnswer } from "../../src/usage.js";

const DAY = 86_400_000;
const SINCE = Date.UTC(2026, 8, 11);
const outside = (day: number): number => (day < 27 ? 0 : 21_922_166_667);
const threads = (day: number): number => (day < 28 ? 0 : 6_900_000);

export const USED_BY_SOURCE: UsedAnswer = {
  range: "month",
  split: "source",
  rows: [
    { key: "log", label: "Outside wsp", tokens: { input: 65_641_500_000, output: 125_000_000, cached: 62_400_000_000, cacheWrite: 3_220_000_000, reasoning: 0 }, costList: 44_925.05, estimate: 44_925.05, saved: 250_000, priced: true },
    { key: "wsp", label: "wsp threads", tokens: { input: 13_700_000, output: 100_000, cached: 12_900_000, cacheWrite: 640_000, reasoning: 0 }, costReported: 5.07, costList: 3.56, estimate: 8.63, saved: 47, priced: true, turns: 21 },
  ],
  series: Array.from({ length: 30 }, (_, i) => ({ t: SINCE + i * DAY, tokens: outside(i) + threads(i) })),
  lines: [
    { key: "log", label: "Outside wsp", points: Array.from({ length: 30 }, (_, i) => outside(i)) },
    { key: "wsp", label: "wsp threads", points: Array.from({ length: 30 }, (_, i) => threads(i)) },
  ],
  since: SINCE,
  until: SINCE + 30 * DAY,
  logs: { agents: ["Claude Code", "Codex"], computers: ["zingzy's MacBook Pro"] },
};

/** The same month by account: the logs outside wsp are counted with the threads, as every split counts them. */
export const USED_BY_ACCOUNT: UsedAnswer = {
  ...USED_BY_SOURCE,
  split: "account",
  rows: [
    { key: "claude@here", label: "Claude Code with an API key", agent: "claude", tokens: { input: 65_647_120_132, output: 125_037_700, cached: 62_405_050_000, cacheWrite: 3_220_440_000, reasoning: 0 }, costReported: 3.56, costList: 44_925.05, estimate: 44_928.61, priced: true, turns: 12 },
    { key: "codex:acct-1", label: "Codex with ChatGPT Plus", agent: "codex", tokens: { input: 8_150_000, output: 50_000, cached: 7_800_000, cacheWrite: 0, reasoning: 0 }, costList: 7.15, estimate: 7.15, priced: true, turns: 9 },
    { key: "claude@pl_hetzner", label: "Claude Code signed in on hetzner", agent: "claude", tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 }, costList: 0, estimate: 0, priced: true, turns: 0 },
  ],
  lines: [
    { key: "claude@here", label: "Claude Code with an API key", points: Array.from({ length: 30 }, (_, i) => outside(i) + threads(i)) },
    { key: "codex:acct-1", label: "Codex with ChatGPT Plus", points: Array.from({ length: 30 }, (_, i) => (i < 29 ? 0 : 8_200_000)) },
  ],
};
