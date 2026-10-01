// SPDX-License-Identifier: AGPL-3.0-only
// The two usage ledgers' shared vocabulary: the rate table off LiteLLM's price
// file, a turn priced off it, the day a row is filed under, and the words a
// limit and a reset are read in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountWords, dayKeyOf, freshIn, LIMIT_KINDS, limitKindOfMinutes, logsLine, parseRateTable, priceOf, resetsWord, usedHeadline, usedPrice, USAGE_WORDS } from "../src/usage.js";

const PRICES: unknown = JSON.parse(readFileSync(new URL("./fixtures/litellm-prices.json", import.meta.url), "utf8"));

describe("the rate table", () => {
  it("takes each model's four per-token prices off LiteLLM's own entries and nothing else", () => {
    const table = parseRateTable(PRICES);
    expect(table["claude-opus-5"]).toEqual({ input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheWrite: 6.25e-6, provider: "anthropic" });
    // The long-context, batch, flex and priority twins beside the base price are not the price a turn pays.
    expect(table["gpt-5.5"]).toEqual({ input: 5e-6, output: 3e-5, cacheRead: 5e-7, provider: "openai" });
    expect(table["gpt-5-codex"]).toEqual({ input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, provider: "openai" });
    // The file's own description of its fields is no model.
    expect(table["sample_spec"]).toBeUndefined();
    expect(Object.keys(table).sort()).toEqual(["claude-opus-5", "gpt-5-codex", "gpt-5.5"]);
  });

  it("reads nothing out of a document that is not the table", () => {
    expect(parseRateTable(null)).toEqual({});
    expect(parseRateTable([1, 2])).toEqual({});
    expect(parseRateTable({ "gpt-x": { input_cost_per_token: "cheap" } })).toEqual({});
  });
});

describe("a turn's list price", () => {
  const table = parseRateTable(PRICES);

  it("prices fresh input, cached input, cache writes and output each at its own rate", () => {
    // input counts every token the model read, the cached and the written part included.
    const usd = priceOf("claude-opus-5", { input: 1_000_000, output: 100_000, cached: 600_000, cacheWrite: 100_000 }, table);
    expect(usd).toBeCloseTo(300_000 * 5e-6 + 600_000 * 5e-7 + 100_000 * 6.25e-6 + 100_000 * 2.5e-5, 10);
  });

  it("prices a cache write at the input rate where the model lists none", () => {
    expect(priceOf("gpt-5.5", { input: 1_000, output: 0, cacheWrite: 1_000 }, table)).toBeCloseTo(1_000 * 5e-6, 12);
  });

  it("finds a model named with its provider or a date after it", () => {
    expect(priceOf("openai/gpt-5.5", { input: 1_000, output: 0 }, table)).toBeCloseTo(5e-3, 12);
    expect(priceOf("claude-opus-5-20260901", { input: 0, output: 1_000 }, table)).toBeCloseTo(2.5e-2, 12);
  });

  it("answers nothing for a model the table does not have, and never a guess", () => {
    expect(priceOf("some-new-model", { input: 1_000, output: 1_000 }, table)).toBeUndefined();
  });
});

describe("the day a row is filed under", () => {
  it("is the calendar day in the zone asked for, so a turn a minute past midnight is the new day's", () => {
    // 2026-09-29T18:29:00Z is 23:59 in Kolkata and 18:31Z is 00:01 the next day there.
    expect(dayKeyOf(Date.UTC(2026, 8, 29, 18, 29), "Asia/Kolkata")).toBe("2026-09-29");
    expect(dayKeyOf(Date.UTC(2026, 8, 29, 18, 31), "Asia/Kolkata")).toBe("2026-09-30");
    expect(dayKeyOf(Date.UTC(2026, 8, 29, 18, 31), "UTC")).toBe("2026-09-29");
  });
});

describe("a limit's windows and words", () => {
  it("reads a window's length as the plan's session, week, or longer", () => {
    expect(limitKindOfMinutes(300)).toBe("session");
    expect(limitKindOfMinutes(10_080)).toBe("week");
    expect(limitKindOfMinutes(43_200)).toBe("month");
    expect(LIMIT_KINDS).toEqual(["session", "week", "week_opus", "week_sonnet", "month", "overage"]);
  });

  it("says a reset in minutes, then hours, then by the day of the week", () => {
    const now = Date.UTC(2026, 8, 29, 10, 0);
    expect(resetsWord(now + 45 * 60_000, now, "UTC")).toBe("resets in 45 min");
    expect(resetsWord(now + 2 * 3_600_000 + 10 * 60_000, now, "UTC")).toBe("resets in 2 h");
    expect(resetsWord(now + 3 * 86_400_000, now, "UTC")).toBe("resets on Fri");
    expect(resetsWord(now - 60_000, now, "UTC")).toBe("reset");
  });

  it("keeps every sentence a row may carry in one table", () => {
    expect(USAGE_WORDS).toMatchObject({
      notPriced: "not priced",
      listPrice: "list price",
      noLimit: "reports no plan limit",
      keyed: "pays per token, no plan limit",
      unread: "not read yet: shows after its next turn",
      reached: "limit reached",
    });
  });
});

describe("an account in plain words", () => {
  it("says how it pays: a key, its plan under the plan's own name, the address it signed in as, your sign-in, a computer's own login", () => {
    expect([
      accountWords({ agentName: "Claude Code", keyed: true, plan: "max" }),
      accountWords({ agentName: "Codex", plan: "plus", planBrand: "ChatGPT", named: "dev@example.com" }),
      accountWords({ agentName: "Codex", named: "dev@example.com" }),
      accountWords({ agentName: "Claude Code", vaulted: true }),
      accountWords({ agentName: "OpenCode", ownOn: "zingzy's MacBook Pro" }),
    ]).toEqual(["Claude Code with an API key", "Codex with ChatGPT Plus", "Codex as dev@example.com", "Claude Code with your sign-in", "OpenCode signed in on zingzy's MacBook Pro"]);
  });
});

describe("what a range used, said once", () => {
  // The owner's week, near enough: almost all of it read from cache, priced off the table.
  const rows = [
    { key: "claude", label: "Claude Code", tokens: { input: 7_323_700_000, output: 7_300_000, cached: 6_874_800_000 }, costList: 4_301.74, priced: true },
    { key: "codex", label: "Codex", tokens: { input: 22_000_000, output: 42_000, cached: 20_700_000 }, costList: 15.45, priced: true },
  ];
  it("reads the tokens, the price and the cached share in one line, the cached ones taken out of fresh", () => {
    expect(usedHeadline({ range: "week", rows })).toBe("7.35B tokens in the last 7 days, $4,317.19 at list price, 6.9B of it read from cache.");
    expect(rows.map(r => freshIn(r.tokens))).toEqual([448_900_000, 1_300_000]);
    expect(usedHeadline({ range: "day", rows: [] })).toBe(USAGE_WORDS.noUse);
  });

  it("names whose logs it counted and on which computer, wsp's own threads among them", () => {
    expect(logsLine({ agents: ["Claude Code", "Codex", "OpenCode"], computer: "zingzy's MacBook Pro" })).toBe("Counts what Claude Code, Codex and OpenCode logged on zingzy's MacBook Pro, wsp's threads there included.");
    expect(logsLine({ agents: ["Codex"], computer: "Boat" })).toBe("Counts what Codex logged on Boat, wsp's threads there included.");
  });
});

describe("a used row's price", () => {
  it("says not priced wherever some of its tokens had no price, beside whatever figure the rest came to", () => {
    expect(usedPrice({ costList: 1.5, priced: false })).toEqual({ figure: "$1.50", word: USAGE_WORDS.notPriced });
    expect(usedPrice({ costReported: 0.4, priced: false })).toEqual({ figure: "$0.40", word: USAGE_WORDS.notPriced });
    expect(usedPrice({ priced: false })).toEqual({ word: USAGE_WORDS.notPriced });
    expect(usedPrice({ costList: 1.5, priced: true })).toEqual({ figure: "$1.50", word: USAGE_WORDS.listPrice });
    expect(usedPrice({ costReported: 0.4, priced: true })).toEqual({ figure: "$0.40" });
  });
});
