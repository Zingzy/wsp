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
