// SPDX-License-Identifier: AGPL-3.0-only
// wsp usage's accounts table as a person reads it.
import { describe, expect, it } from "vitest";
import { usedAsk, type AccountRow, type UsedAnswer } from "@wsp/protocol";
import { usageTableLines } from "../src/verbs.js";
import { readUsage } from "../src/verbs/client.js";
import { USED_BY_ACCOUNT, USED_BY_SOURCE } from "../../protocol/test/fixtures/usage-by-source.js";

const NOW = Date.UTC(2026, 8, 29, 10, 0);
const DAY = 86_400_000;
const used: UsedAnswer = { range: "day", split: "agent", rows: [], series: [], since: NOW, until: NOW + DAY };

describe("wsp usage's accounts table", () => {
  it("says each account's banked resets and when the first lapses, and nothing for an account that banks none", () => {
    const codex: AccountRow = { key: "codex:acct_1", agent: "codex", label: "Codex with ChatGPT Plus", computers: ["spoo"], credits: { count: 2, nextExpiresAt: NOW + 21 * DAY, readAt: NOW } };
    const claude: AccountRow = { key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", computers: ["spoo"] };
    const [head, ...rows] = usageTableLines({ accounts: [claude, codex], used }, NOW);
    expect(head).toMatch(/\bRESETS\b/);
    const at = head!.indexOf("RESETS");
    expect(rows[1]!.slice(at)).toMatch(/^2 banked, first expires in 21 d/);
    expect(rows[0]!.slice(at, at + "RESETS".length).trim()).toBe("");
  });
});

describe("wsp usage's used table", () => {
  it("names the agent beside each model, since two agents running one model are two rows", () => {
    const tokens = { input: 1_000, output: 10, cached: 0 };
    const byModel: UsedAnswer = {
      ...used,
      split: "model",
      rows: [
        { key: "claude:claude-sonnet-4-5", label: "Sonnet 4.5", agent: "claude", tokens, priced: false },
        { key: "hermes:claude-sonnet-4-5", label: "Sonnet 4.5", agent: "hermes", tokens, priced: false },
      ],
    };
    const lines = usageTableLines({ accounts: [], used: byModel }, NOW);
    const [head, claude, hermes] = lines.slice(lines.indexOf("") + 1);
    expect(head).toMatch(/^AGENT +MODEL +FRESH IN/);
    expect(claude).toMatch(/^Claude Code +Sonnet 4\.5 /);
    expect(hermes).toMatch(/^Hermes Agent +Sonnet 4\.5 /);
  });
});

describe("wsp usage --by source", () => {
  it("sets wsp's threads beside the use outside wsp, each with its fresh, written, cached and out tokens and its price", () => {
    const lines = usageTableLines({ accounts: [], used: USED_BY_SOURCE }, NOW);
    const [head, outside, threads] = lines.slice(lines.indexOf("") + 1).map(line => line.split(/ {2,}/));
    expect(head).toEqual(["SOURCE", "FRESH IN", "WRITTEN", "CACHED", "OUT", "PRICE"]);
    expect(outside).toEqual(["Outside wsp", "21.5M", "3.22B", "62.4B", "125M", "$44,925.05 list price"]);
    expect(threads).toEqual(["wsp threads", "160k", "640k", "12.9M", "100k", "$8.63 list price"]);
  });
});

describe("wsp usage by any other split", () => {
  it("asks for what was used as the Usage page does, the work logged outside wsp counted on every split", async () => {
    const asked: unknown[] = [];
    const client = { request: async (op: string, body?: unknown) => (asked.push([op, body]), op === "usage.accounts" ? { accounts: [] } : { used: USED_BY_ACCOUNT }) };
    await readUsage(client as never, "month", "account");
    expect(asked).toContainEqual(["usage.used", { range: "month", split: "account", outside: true }]);
    expect(usedAsk("month", "account")).toEqual({ range: "month", split: "account", outside: true });
  });

  it("prints each account with the use outside wsp counted in, as the page draws it", () => {
    const lines = usageTableLines({ accounts: [], used: USED_BY_ACCOUNT }, NOW);
    const rows = lines.slice(lines.indexOf("") + 1).map(line => line.split(/ {2,}/));
    expect(rows).toEqual([
      ["ACCOUNT", "FRESH IN", "WRITTEN", "CACHED", "OUT", "PRICE"],
      ["Claude Code with an API key", "21.6M", "3.22B", "62.4B", "125M", "$44,928.61 list price"],
      ["Codex with ChatGPT Plus", "350k", "0", "7.8M", "50k", "$7.15 list price"],
      ["Claude Code signed in on hetzner", "0", "0", "0", "0", "$0.00"],
    ]);
  });
});
