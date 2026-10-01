// SPDX-License-Identifier: AGPL-3.0-only
// The ledger of what was used and the record of what each account may still
// use: rows filed by day, folded over a range and split four ways, priced off
// the rate table where no harness put a cost on them, and never added together.
import { describe, expect, it } from "vitest";
import { parseRateTable, type AgentSignInState, type HarnessLimit, type PlaceView, type RateTable, type UsageSplit } from "@wsp/protocol";
import { accountOf, accountRows, createPriceTable, createUsageLedger, usageComputerName, type UsageEntry } from "../src/usage.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";

const TZ = "UTC";
const NOON = Date.UTC(2026, 8, 29, 12, 0);
const DAY = 86_400_000;
const TABLE: RateTable = parseRateTable({ "gpt-5.5": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, cache_read_input_token_cost: 5e-7, litellm_provider: "openai" } });

const labelOf = (split: UsageSplit, value: string): string => `${split}:${value}`;

function ledger(start = NOON, table: RateTable = TABLE) {
  const { clock, advance } = fakeClock(start);
  const store = memoryStore();
  const usage = createUsageLedger({ store, clock, timeZone: TZ, prices: async () => table });
  return { usage, store, clock, advance };
}

const turn = (o: Partial<UsageEntry> & { at: number }): UsageEntry => ({
  agent: "codex",
  account: "codex:acct_1",
  accountLabel: "dev@example.com",
  computer: "here",
  project: "p_spoo",
  model: "gpt-5.5",
  tokens: { input: 1_000, output: 100, cached: 400 },
  source: "wsp",
  ...o,
});

describe("the ledger of what was used", () => {
  it("reads the rate table only for a row no harness put a cost on", async () => {
    const { clock } = fakeClock(NOON);
    let asked = 0;
    const usage = createUsageLedger({ store: memoryStore(), clock, timeZone: TZ, prices: async () => (asked++, TABLE) });
    await usage.used({ range: "week", split: "agent", label: labelOf });
    await usage.add(turn({ at: NOON, costUsd: 0.5 }));
    await usage.used({ range: "week", split: "agent", label: labelOf });
    expect(asked).toBe(0);
    await usage.add(turn({ at: NOON, project: "p_other" }));
    await usage.used({ range: "week", split: "agent", label: labelOf });
    expect(asked).toBe(1);
  });

  it("files a turn under its day and hour and its four splits, and two turns of one key on one day are one row", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON - 3_600_000 }));
    await usage.add(turn({ at: NOON - 3_600_000 + 60_000, tokens: { input: 500, output: 50 } }));
    const day = await usage.day("2026-09-29");
    expect(day?.rows).toEqual([
      { day: "2026-09-29", hour: 11, agent: "codex", account: "codex:acct_1", computer: "here", project: "p_spoo", model: "gpt-5.5", turns: 2, tokens: { input: 1_500, output: 150, cached: 400, cacheWrite: 0, reasoning: 0 }, source: "wsp" },
    ]);
  });

  it("folds a day, a week and a month, each reaching back over its own days and no further", async () => {
    const { usage } = ledger();
    for (const back of [0, 3, 6, 7, 29, 30]) await usage.add(turn({ at: NOON - back * DAY, tokens: { input: 100, output: 10 } }));
    const total = async (range: "day" | "week" | "month") => (await usage.used({ range, split: "agent", label: labelOf })).rows.reduce((n, r) => n + r.tokens.input, 0);
    expect(await total("day")).toBe(100);
    expect(await total("week")).toBe(300);
    expect(await total("month")).toBe(500);
  });

  it("draws the range as a series: hours for a day, days for a week, a step with nothing at 0", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON - 2 * 3_600_000, tokens: { input: 100, output: 20 } }));
    await usage.add(turn({ at: NOON - 2 * DAY, tokens: { input: 30, output: 0 } }));
    const day = await usage.used({ range: "day", split: "agent", label: labelOf });
    expect(day.series).toHaveLength(24);
    expect(day.series[10]).toEqual({ t: Date.UTC(2026, 8, 29, 10), tokens: 120 });
    expect(day.series.filter(p => p.tokens > 0)).toHaveLength(1);
    const week = await usage.used({ range: "week", split: "agent", label: labelOf });
    expect(week.series.map(p => p.tokens)).toEqual([0, 0, 0, 0, 30, 0, 120]);
    expect(week.since).toBe(Date.UTC(2026, 8, 23));
    // The range ends where today does, not at the moment it was read, so two reads a moment apart agree.
    expect(week.until).toBe(Date.UTC(2026, 8, 30));
  });

  it("splits by account: one sign-in across two computers is one row, a computer's own login another", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON, agent: "claude", account: "claude:vault-token", computer: "here", model: "claude-opus-5", costUsd: 0.2 }));
    await usage.add(turn({ at: NOON, agent: "claude", account: "claude:vault-token", computer: "pl_boat", model: "claude-opus-5", costUsd: 0.3 }));
    await usage.add(turn({ at: NOON, agent: "claude", account: "claude@pl_spoo", computer: "pl_spoo", model: "claude-opus-5", costUsd: 0.1 }));
    const rows = (await usage.used({ range: "day", split: "account", label: labelOf })).rows;
    expect(rows.map(r => [r.key, r.label, r.tokens.input, r.costReported])).toEqual([
      ["claude:vault-token", "account:claude:vault-token", 2_000, 0.5],
      ["claude@pl_spoo", "account:claude@pl_spoo", 1_000, 0.1],
    ]);
  });

  it("keeps the harness's own cost, prices what it left bare off the table as a list price, and says what it could not price", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON, agent: "claude", model: "claude-opus-5", costUsd: 0.42 }));
    await usage.add(turn({ at: NOON, agent: "codex", model: "gpt-5.5", tokens: { input: 1_000, output: 100, cached: 400 } }));
    await usage.add(turn({ at: NOON, agent: "opencode", model: "some-new-model", tokens: { input: 10, output: 1 } }));
    const rows = new Map((await usage.used({ range: "day", split: "agent", label: labelOf })).rows.map(r => [r.key, r]));
    // The harness's figure wins over the table's, even where the table has the model.
    expect(rows.get("claude")).toMatchObject({ costReported: 0.42, priced: true });
    expect(rows.get("claude")?.costList).toBeUndefined();
    expect(rows.get("codex")?.costList).toBeCloseTo(600 * 5e-6 + 400 * 5e-7 + 100 * 3e-5, 12);
    expect(rows.get("codex")).toMatchObject({ priced: true });
    expect(rows.get("opencode")).toMatchObject({ priced: false });
    expect(rows.get("opencode")?.costList).toBeUndefined();
  });

  it("counts work read from the logs in the same row as wsp's own turns, and says once whose logs it counted and where", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON, agent: "claude", model: "claude-opus-5", source: "wsp" }));
    await usage.add(turn({ at: NOON, agent: "claude", model: "claude-opus-5", source: "log" }));
    const used = await usage.used({ range: "day", split: "agent", label: labelOf, logsOn: "zingzy's MacBook Pro" });
    expect(used.rows.map(r => [r.key, r.tokens.input])).toEqual([["claude", 2_000]]);
    expect(used.logs).toEqual({ agents: ["agent:claude"], computer: "zingzy's MacBook Pro" });
    const without = await usage.used({ range: "day", split: "agent", label: labelOf, outside: false, logsOn: "zingzy's MacBook Pro" });
    expect([without.rows.map(r => [r.key, r.tokens.input]), without.logs]).toEqual([[["claude", 1_000]], undefined]);
  });

  it("keeps ninety days of documents, the oldest dropped as a new day is filed", async () => {
    const { usage, advance } = ledger(NOON - 95 * DAY);
    await usage.add(turn({ at: NOON - 95 * DAY }));
    await usage.add(turn({ at: NOON - 94 * DAY }));
    advance(95 * DAY);
    await usage.add(turn({ at: NOON }));
    expect(await usage.day("2026-06-26")).toBeUndefined();
    expect(await usage.day("2026-06-27")).toBeUndefined();
    expect(await usage.day("2026-09-29")).toBeDefined();
    expect(await usage.days()).toEqual(["2026-09-29"]);
  });
});

describe("work read from the logs", () => {
  it("skips a session a wsp turn was filed under, and a second read of the logs replaces the first rather than adding to it", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON, agent: "claude", model: "claude-opus-5", session: "s-wsp", tokens: { input: 100, output: 10 } }));
    const logs = [
      turn({ at: NOON, agent: "claude", model: "claude-opus-5", session: "s-wsp", source: "log", tokens: { input: 100, output: 10 } }),
      turn({ at: NOON, agent: "claude", model: "claude-opus-5", session: "s-outside", source: "log", tokens: { input: 7, output: 3 } }),
    ];
    await usage.fileLogs(logs);
    await usage.fileLogs(logs);
    const rows = (await usage.used({ range: "day", split: "agent", label: labelOf })).rows;
    // The wsp turn once and the outside session once, in one row.
    expect(rows.map(r => [r.key, r.tokens.input, r.tokens.output])).toEqual([["claude", 107, 13]]);
  });
});

describe("what each account may still use", () => {
  const reading: HarnessLimit = { windows: [{ kind: "session", usedPercent: 40, resetsAt: NOON + 3_600_000 }], plan: "plus", status: "ok" };

  it("keeps an account's last reading and every computer a reading came from, and never touches the ledger", async () => {
    const { usage, advance } = ledger();
    await usage.limit({ key: "codex:acct_1", agent: "codex", label: "dev@example.com", road: "named", computer: "here", limit: reading });
    advance(60_000);
    await usage.limit({ key: "codex:acct_1", agent: "codex", label: "dev@example.com", road: "named", computer: "pl_boat", limit: { ...reading, windows: [{ kind: "session", usedPercent: 55 }] } });
    expect(await usage.limits()).toEqual([
      { key: "codex:acct_1", agent: "codex", label: "dev@example.com", road: "named", plan: "plus", windows: [{ kind: "session", usedPercent: 55 }], status: "ok", readAt: NOON + 60_000, computers: ["here", "pl_boat"] },
    ]);
    expect(await usage.days()).toEqual([]);
  });

  it("keeps what a reading leaves out: the plan a later reading does not name stays", async () => {
    const { usage } = ledger();
    await usage.limit({ key: "codex:acct_1", agent: "codex", label: "dev@example.com", road: "named", computer: "here", limit: reading });
    await usage.limit({ key: "codex:acct_1", agent: "codex", label: "dev@example.com", road: "named", computer: "here", limit: { windows: [{ kind: "week", usedPercent: 3 }] } });
    expect((await usage.limits())[0]).toMatchObject({ plan: "plus", windows: [{ kind: "week", usedPercent: 3 }] });
  });
});

describe("the rate table", () => {
  it("is read once a day and kept for when the network is gone", async () => {
    const { clock, advance } = fakeClock(NOON);
    const store = memoryStore();
    let fetched = 0;
    let offline = false;
    const table = createPriceTable({
      store,
      clock,
      fetch: async () => {
        fetched++;
        if (offline) throw new Error("offline");
        return { "gpt-5.5": { input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, litellm_provider: "openai" } };
      },
    });
    expect(Object.keys(await table.get())).toEqual(["gpt-5.5"]);
    await table.get();
    expect(fetched).toBe(1);
    advance(25 * 3_600_000);
    offline = true;
    expect(Object.keys(await table.get())).toEqual(["gpt-5.5"]);
    expect(fetched).toBe(2);
    // A host started later over the same store reads the kept copy before it asks.
    const again = createPriceTable({ store, clock, fetch: async () => { throw new Error("offline"); } });
    expect(Object.keys(await again.get())).toEqual(["gpt-5.5"]);
  });
});

describe("a computer in the usage records", () => {
  const mac = { id: "here", kind: "computer", name: "zingzys-macbook-pro.local", label: "zingzy's MacBook Pro" } as PlaceView;
  const boat = { id: "box", kind: "provider", name: "box" } as PlaceView;
  it("reads as its name: this computer's own, a provider's by its word, never a hostname or a provider's id", () => {
    expect([usageComputerName([mac, boat], "here"), usageComputerName([mac, boat], "box"), usageComputerName([mac], "box")]).toEqual(["zingzy's MacBook Pro", "Boat", "Boat"]);
  });
});

describe("an account's key and label", () => {
  const computer = { id: "here", name: "zingzy's MacBook Pro" };
  it("names the account a harness named, else the vault's token or key, else the computer's own login", () => {
    expect(accountOf({ agent: "codex", agentName: "Codex", named: { id: "maya@example.com" }, vaulted: "token", computer })).toEqual({ key: "codex:maya@example.com", label: "maya@example.com", road: "named" });
    expect(accountOf({ agent: "claude", agentName: "Claude Code", vaulted: "token", computer })).toEqual({ key: "claude:vault-token", label: "Claude Code with your sign-in", road: "vault" });
    expect(accountOf({ agent: "claude", agentName: "Claude Code", vaulted: "key", computer })).toEqual({ key: "claude:vault-key", label: "Claude Code with an API key", road: "vault" });
    expect(accountOf({ agent: "opencode", agentName: "OpenCode", vaulted: undefined, computer })).toEqual({ key: "opencode@here", label: "OpenCode signed in on zingzy's MacBook Pro", road: "own" });
  });

  it("keeps the label each account was filed under, so an account split reads it and never takes the key apart", async () => {
    const { usage } = ledger();
    await usage.add(turn({ at: NOON, account: "codex:maya@example.com", accountLabel: "maya@example.com" }));
    await usage.fileLogs([turn({ at: NOON, account: "claude@here", accountLabel: "Claude Code on zingzy's MacBook Pro", agent: "claude", source: "log" })]);
    expect(Object.fromEntries(await usage.accountLabels())).toEqual({ "codex:maya@example.com": "maya@example.com", "claude@here": "Claude Code on zingzy's MacBook Pro" });
  });
});

describe("the account rows", () => {
  const places: { id: string; name: string; signIns: Record<string, AgentSignInState> }[] = [
    { id: "here", name: "zingzy's MacBook Pro", signIns: { claude: "vault-key", codex: "signed-in", opencode: "signed-in" } },
    { id: "pl_boat", name: "Boat", signIns: { claude: "vault-key", codex: "signed-in" } },
    { id: "pl_spoo", name: "spoo", signIns: { claude: "signed-in", cursor: "none" } },
  ];
  const nameOf = (id: string): string => places.find(p => p.id === id)?.name ?? id;
  const printsLimits = (agent: string): boolean => agent === "claude" || agent === "codex";
  const agentName = (agent: string): string => ({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode" })[agent] ?? agent;
  const planBrand = (agent: string): string | undefined => ({ codex: "ChatGPT", claude: "Claude" })[agent];

  it("lists the vault's token once across every computer it was handed to, a computer's own login apart, and the account a turn named across its computers", () => {
    const codex = { key: "codex:acct_7f3a", agent: "codex", label: "dev@example.com", plan: "plus", windows: [{ kind: "session" as const, usedPercent: 34 }], status: "ok" as const, readAt: NOON, computers: ["here", "pl_boat"] };
    const rows = accountRows({ limits: [codex], places, nameOf, agentName, planBrand, printsLimits, vaulted: agent => (agent === "claude" ? "token" : undefined) });
    expect(rows.map(r => [r.key, r.label, r.computers, r.note])).toEqual([
      ["claude@pl_spoo", "Claude Code signed in on spoo", ["spoo"], "not read yet: shows after its next turn"],
      ["claude:vault-token", "Claude Code with your sign-in", ["zingzy's MacBook Pro", "Boat"], "not read yet: shows after its next turn"],
      ["codex:acct_7f3a", "Codex with ChatGPT Plus", ["zingzy's MacBook Pro", "Boat"], undefined],
      ["opencode@here", "OpenCode signed in on zingzy's MacBook Pro", ["zingzy's MacBook Pro"], "reports no plan limit"],
    ]);
    expect(rows.find(r => r.key === "codex:acct_7f3a")).toMatchObject({ plan: "plus", windows: codex.windows, status: "ok", readAt: NOON });
  });

  it("reads a vault key or a key a turn named as a sign-in with no plan window", () => {
    const keyed = { key: "claude@pl_spoo", agent: "claude", label: "spoo", windows: [], keyed: true, readAt: NOON, computers: ["pl_spoo"] };
    const rows = accountRows({ limits: [keyed], places, nameOf, agentName, printsLimits, vaulted: agent => (agent === "claude" ? "key" : undefined) });
    expect(rows.filter(r => r.agent === "claude").map(r => [r.key, r.label, r.note])).toEqual([
      ["claude@pl_spoo", "Claude Code with an API key", "pays per token, no plan limit"],
      ["claude:vault-key", "Claude Code with an API key", "pays per token, no plan limit"],
    ]);
  });

  it("keeps the address beside the plan where two accounts of one agent would otherwise read the same", () => {
    const plus = (id: string, email: string, computer: string) => ({ key: `codex:${id}`, agent: "codex", label: email, road: "named" as const, plan: "plus", windows: [{ kind: "session" as const, usedPercent: 10 }], readAt: NOON, computers: [computer] });
    const pro = { key: "codex:acct_c", agent: "codex", label: "c@example.com", road: "named" as const, plan: "pro", windows: [{ kind: "session" as const, usedPercent: 10 }], readAt: NOON, computers: ["here"] };
    const rows = accountRows({ limits: [plus("acct_a", "a@example.com", "here"), plus("acct_b", "b@example.com", "pl_boat"), pro], places: [], nameOf, agentName, planBrand, printsLimits, vaulted: () => undefined });
    expect(rows.map(r => r.label)).toEqual(["Codex with ChatGPT Plus as a@example.com", "Codex with ChatGPT Plus as b@example.com", "Codex with ChatGPT Pro"]);
  });

  it("folds a computer's own login into the vault's key where that computer's turns ran on the key, so one key is one row", () => {
    // The owner's shape: an API key in the vault, the Mac's agent signed in on its own but its turns run on the key,
    // Boat handed the key, Codex on ChatGPT Plus on the Mac, OpenCode reporting no limit.
    const key = { key: "claude:vault-key", agent: "claude", label: "Claude Code with an API key", road: "vault" as const, windows: [], keyed: true, readAt: NOON, computers: ["pl_boat", "here"] };
    const codex = { key: "codex:acct_7f3a", agent: "codex", label: "dev@example.com", road: "named" as const, plan: "plus", windows: [{ kind: "session" as const, usedPercent: 12 }, { kind: "week" as const, usedPercent: 40 }], readAt: NOON, computers: ["here"] };
    const mine = [
      { id: "here", name: "zingzy's MacBook Pro", signIns: { claude: "signed-in", codex: "signed-in", opencode: "signed-in" } as Record<string, AgentSignInState> },
      { id: "pl_boat", name: "Boat", signIns: { claude: "vault-key" } as Record<string, AgentSignInState> },
    ];
    const rows = accountRows({ limits: [key, codex], places: mine, nameOf: id => mine.find(p => p.id === id)?.name ?? id, agentName, planBrand, printsLimits, vaulted: agent => (agent === "claude" ? "key" : undefined) });
    expect(rows.map(r => [r.label, r.computers, r.note])).toEqual([
      ["Claude Code with an API key", ["Boat", "zingzy's MacBook Pro"], "pays per token, no plan limit"],
      ["Codex with ChatGPT Plus", ["zingzy's MacBook Pro"], undefined],
      ["OpenCode signed in on zingzy's MacBook Pro", ["zingzy's MacBook Pro"], "reports no plan limit"],
    ]);
  });
});
