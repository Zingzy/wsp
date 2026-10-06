// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { join } from "node:path";
import { HERE_AGENTS, HOME, project, store, THIS_COMPUTER, uuidFor, workspace } from "../fixture-kit.mjs";

/** Settings > Usage in the owner's shape, with a week behind it: Claude Code on an API key kept in wsp's keys, its
 * turns run on this computer and on Boat, Codex on ChatGPT Plus here with its last reading, Hermes Agent and
 * OpenCode installed with no plan limit, and a week of turns at the owner's size, a billion tokens a day nearly all
 * read from cache. The limits and the ledger days are what the host itself keeps; the price table is kept as read,
 * so no shot downloads it. */
const usageState = () => ({
  ...store({
    projects: [project("spoo", HERE, 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" })],
  }),
  "usage-index": { days: { days: usageDays().map(d => d.day) } },
  limits: {
    "claude:vault-key": { key: "claude:vault-key", agent: "claude", label: "Claude Code with an API key", road: "vault", windows: [], keyed: true, readAt: Date.now() - 12 * 60_000, computers: ["box", HERE] },
    "codex:acct_7f3": { key: "codex:acct_7f3", agent: "codex", label: "maya@example.com", road: "named", plan: "plus", windows: [{ kind: "session", usedPercent: 62, resetsAt: Date.now() + 150 * 60_000 }, { kind: "week", usedPercent: 18, resetsAt: Date.now() + 3 * 86_400_000 }], status: "ok", readAt: Date.now() - 20 * 60_000, computers: [HERE] },
  },
});

const dayKey = at => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Seven days of the ledger, one document each, in this computer's zone as the host files them: Claude Code's turns
 * on the key here and on Boat, and Codex's here, none with a cost of its own, so the table prices them all. */
const usageDays = () =>
  Array.from({ length: 7 }, (_, back) => {
    const at = Date.now() - back * 86_400_000;
    const day = dayKey(at);
    const busy = [1.4, 0.6, 1.1, 0.3, 1.8, 0.9, 1.2][back];
    const row = (o, n) => ({ day, hour: 10 + (n % 8), turns: 3 + n, costReported: undefined, ...o });
    const tokens = (input, output, cached) => ({ input: Math.round(input * busy), output: Math.round(output * busy), cached: Math.round(cached * busy), cacheWrite: 0, reasoning: 0 });
    const clean = r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
    return {
      day,
      rows: [
        row({ agent: "claude", account: "claude:vault-key", computer: HERE, project: "pr_spoo", model: "claude-opus-4-5", tokens: tokens(640_000_000, 640_000, 602_000_000), source: "wsp" }, 1),
        row({ agent: "claude", account: "claude:vault-key", computer: "box", project: "pr_spoo", model: "claude-opus-4-5", tokens: tokens(410_000_000, 400_000, 380_000_000), source: "wsp" }, 2),
        row({ agent: "codex", account: "codex:acct_7f3", computer: HERE, project: "pr_spoo", model: "gpt-5.5", tokens: tokens(3_100_000, 6_000, 2_900_000), source: "wsp" }, 3),
      ].map(clean),
    };
  });

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A week of this computer's minute readings as its daemon keeps them, a file a UTC day, with no reading from one
 * to seven each night while it slept, so the chart has its gaps. */
const readingsDays = () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const files = new Map();
  for (let at = now - 7 * 86_400_000; at <= now; at += 60_000) {
    const hour = new Date(at).getHours();
    if (hour >= 1 && hour < 7) continue;
    const t = at / 3_600_000;
    const work = Math.max(0, Math.sin(((hour - 8) / 14) * Math.PI));
    const cpu = Math.min(96, 6 + 38 * work + 9 * Math.abs(Math.sin(t * 3.1)) + 4 * Math.sin(t * 11.7));
    const mem = Math.round((14 + 7 * work + 1.5 * Math.sin(t * 0.7)) * GIB);
    const disk = Math.round(612 * GIB + ((at - (now - 7 * 86_400_000)) / 86_400_000) * 3.2 * GIB);
    const line = JSON.stringify({ at, cpu: Number(cpu.toFixed(1)), load1: Number((cpu / 12).toFixed(2)), mem: { used: mem, total: 32 * GIB }, disk: { used: disk, total: 994 * GIB } });
    const name = `${new Date(at).toISOString().slice(0, 10)}.jsonl`;
    files.set(name, `${files.get(name) ?? ""}${line}\n`);
  }
  return [...files].map(([name, text]) => ({ path: join("readings", name), text }));
};

/** Claude Code's own log of a week of work run outside wsp, in a folder no project holds: what the host's read of
 * this computer's logs files as outside wsp, a message a day. */
const claudeLog = () => {
  const lines = Array.from({ length: 7 }, (_, back) => {
    const at = Date.now() - back * 86_400_000 - 2 * 3_600_000;
    const usage = { input_tokens: 4_000 + back * 900, output_tokens: 6_000 + back * 400, cache_read_input_tokens: 90_000 + back * 11_000, cache_creation_input_tokens: 2_000 };
    return JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), cwd: join(HOME, "notes"), message: { id: `msg_fixture_${back}`, model: "claude-opus-4-5", usage } });
  });
  return { path: join("..", ".claude", "projects", "-notes", `${uuidFor("usage:claude-log")}.jsonl`), text: `${lines.join("\n")}\n` };
};

const usageFiles = () => [
  claudeLog(),
  ...usageDays().map(d => ({ path: join("blobs", "usage-days", d.day), text: JSON.stringify(d) })),
  { path: join("blobs", "prices", "litellm"), text: JSON.stringify({ fetchedAt: Date.now(), table: { "gpt-5.5": { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, provider: "openai" }, "claude-opus-4-5": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheWrite: 6.25e-6, provider: "anthropic" } } }) },
  ...readingsDays(),
];

/** This computer's agents for the Usage fixture: the ones every fixture has, and OpenCode signed in with a key of
 * its own, which prints no limits. */
const USAGE_AGENTS = { ...HERE_AGENTS, agents: { ...HERE_AGENTS.agents, opencode: { version: "1.18.18", status: "1 credentials" }, hermes: { version: "0.4.2", status: "nous (1 credentials):\n  #1 nous-portal" } }, latest: { ...HERE_AGENTS.latest, opencode: "1.18.18", hermes: "0.4.2" } };

export default { build: usageState, files: usageFiles, agents: () => USAGE_AGENTS, keys: { ANTHROPIC_API_KEY: "sk-ant-x-fixture-not-a-key" } };
