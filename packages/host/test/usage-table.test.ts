// SPDX-License-Identifier: AGPL-3.0-only
// wsp usage's accounts table as a person reads it.
import { describe, expect, it } from "vitest";
import type { AccountRow, UsedAnswer } from "@wsp/protocol";
import { usageTableLines } from "../src/verbs.js";

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
