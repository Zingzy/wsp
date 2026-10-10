// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage in the owner's shape: Claude Code with an API key on the Mac
// and Boat, Codex with ChatGPT Plus on the Mac pooled as Codex's card, agents
// that report no limit as one line; then what was used over a range as totals,
// a chart of one line per split value with no fill, the split as a table
// and the token mix. No computer's load stands
// on the page.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMark } from "@wsp/catalog";
import type { AccountRow, PlaceView, UsageRange, UsageSplit, UsedAnswer, UsedRow } from "@wsp/protocol";
import { creditsWord, logsLine, resetQuestion, RESET_WORDS, USAGE_WORDS } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { forgetHeld } from "../src/protocol/held.js";
import { useStore } from "../src/protocol/store.js";
import { ABOUT_WORDS, PRIVACY_WORDS, USAGE_PAGE_WORDS } from "../src/settings/format.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";
import { USED_BY_ACCOUNT, USED_BY_SOURCE } from "../../../packages/protocol/test/fixtures/usage-by-source.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzys-macbook-pro.local", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false, shape: { cpu: 10, memMb: 32_768 } };
const boat: PlaceView = { id: "box", kind: "provider", name: "box", default: false, takesForks: true };

const HOUR = 3_600_000;
const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;
// The page reads the minute clock, so a reset is set off the minute it will read.
const minute = (): number => Math.floor(Date.now() / 60_000) * 60_000;
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** When a window runs out at the rate it was used so far, worked from the same numbers the account carries. */
const runsOutAt = (usedPercent: number, resetsAt: number, length: number, now: number): number => {
  const start = resetsAt - length;
  return start + ((now - start) * 100) / usedPercent;
};

const codexPlus = (): AccountRow => ({
  key: "codex:acct-1",
  agent: "codex",
  label: "Codex with ChatGPT Plus",
  computers: ["zingzy's MacBook Pro"],
  plan: "plus",
  windows: [
    { kind: "session", usedPercent: 62, resetsAt: minute() + 2.5 * HOUR },
    { kind: "week", usedPercent: 18.4, resetsAt: minute() + 40 * 60_000 },
  ],
  status: "ok",
  readAt: minute() - 5 * 60_000,
});

const accounts = (): AccountRow[] => [
  { key: "claude:vault-key", agent: "claude", label: "Claude Code with an API key", computers: ["zingzy's MacBook Pro", "Boat"], note: USAGE_WORDS.keyed },
  codexPlus(),
  { key: "hermes@here", agent: "hermes", label: "Hermes Agent", computers: ["zingzy's MacBook Pro"], note: USAGE_WORDS.noLimit },
  { key: "opencode@here", agent: "opencode", label: "OpenCode", computers: ["zingzy's MacBook Pro"], note: USAGE_WORDS.noLimit },
];

const used = (range: UsageRange, split: UsageSplit, rows = true): UsedAnswer => ({
  range,
  split,
  rows: !rows
    ? []
    : split === "model"
      ? [
          { key: "claude:claude-opus-5-5", label: "Opus 5.5", agent: "claude", tokens: { input: 7_000_000_000, output: 7_000_000, cached: 6_600_000_000 }, costList: 4_100, priced: true },
          { key: "claude:claude-haiku-4-5", label: "Haiku 4.5", agent: "claude", tokens: { input: 323_700_000, output: 300_000, cached: 274_800_000 }, costList: 201.74, priced: true },
          { key: "codex:gpt-5.6", label: "GPT-5.6", agent: "codex", tokens: { input: 22_000_000, output: 42_000, cached: 20_700_000 }, priced: false },
        ]
      : [
          { key: "claude", label: "Claude Code", agent: "claude", tokens: { input: 7_323_700_000, output: 7_300_000, cached: 6_874_800_000 }, costList: 4_301.74, priced: true },
          { key: "codex", label: "Codex", agent: "codex", tokens: { input: 22_000_000, output: 42_000, cached: 20_700_000 }, priced: false },
        ],
  series: Array.from({ length: 7 }, (_, i) => ({ t: Date.parse("2026-09-24T00:00:00Z") + i * 24 * HOUR, tokens: rows ? (i + 1) * 100_000_000 : 0 })),
  since: Date.parse("2026-09-24T00:00:00Z"),
  until: Date.parse("2026-10-01T00:00:00Z"),
  ...(rows ? { logs: { agents: ["Claude Code", "Codex"], computers: ["zingzy's MacBook Pro"] } } : {}),
});

const mount = async (over: Partial<Api> = {}): Promise<{ asks: [UsageRange, UsageSplit][]; readings: string[] }> => {
  const asks: [UsageRange, UsageSplit][] = [];
  const readings: string[] = [];
  const { api } = settingsApi({
    usageAccounts: async () => ({ accounts: accounts() }),
    usageUsed: async (range: UsageRange, split: UsageSplit) => {
      asks.push([range, split]);
      return used(range, split);
    },
    placesReadings: async (placeId: string) => {
      readings.push(placeId);
      return { points: [], stepMs: 1, from: 0, to: 1 };
    },
    ...over,
  } as Partial<Api>);
  mountSettings({ api, at: { kind: "group", group: "usage" } });
  await settle();
  return { asks, readings };
};

const mountLimits = async (over: Partial<Api> = {}): Promise<void> => {
  await mount(over);
  fireEvent.click(document.querySelector("[data-k=usage-tabs] [data-segment=limits]")!);
  await settle();
};

/** The page over one range's answer of the case's own, the fixture's where it names none. */
const mountUsed = (answer: Partial<UsedAnswer>): Promise<unknown> => mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => (split === "model" ? used(range, split) : { ...used(range, split), ...answer }) } as Partial<Api>);

const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] ${sel}`);
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-settings-page] ${sel}`)];
const text = (el: Element | null | undefined): string => el?.textContent ?? "";
/** A total's label, figure and note, in the order it stacks them. */
const stat = (k: string): string[] => [...($(`[data-k=${k}]`)?.children ?? [])].map(text);
const hover = async (el: HTMLElement): Promise<void> => {
  fireEvent.pointerEnter(el, { pointerType: "mouse" });
  fireEvent.mouseEnter(el);
  fireEvent.mouseMove(el);
  await settle();
};

beforeEach(() => {
  // The page and these fixtures each read the clock, and a minute turning between two reads moves every "ago".
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-01T09:30:20Z"));
  resetSettings();
  useStore.setState({ places: [here, boat] });
});

afterEach(() => {
  // Unmounted before the body is cleared, so a tooltip still open takes its portal out of a body that still holds it.
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Usage and Settings reads", () => {
  it("asks nothing on a second visit inside a minute, both tabs drawing the one read, and asks again past it", async () => {
    let accountAsks = 0;
    let settingsAsks = 0;
    const { asks } = await mount({
      usageAccounts: async () => (accountAsks++, { accounts: accounts() }),
      editorList: async () => (settingsAsks++, []),
    } as Partial<Api>);
    expect([asks.length, accountAsks, settingsAsks]).toEqual([2, 1, 1]);
    fireEvent.click(document.querySelector("[data-k=usage-tabs] [data-segment=limits]")!);
    await settle();
    cleanup();
    useStore.setState({ settingsOpen: false });
    mountSettings({ api: useStore.getState().api!, at: { kind: "group", group: "usage" } });
    await settle();
    expect([asks.length, accountAsks, settingsAsks]).toEqual([2, 1, 1]);
    cleanup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    mountSettings({ api: useStore.getState().api!, at: { kind: "group", group: "usage" } });
    await settle();
    expect([asks.length, accountAsks, settingsAsks]).toEqual([4, 2, 2]);
  });

  it("reads both answers again at once from the head's refresh, asking the agents for their limits now, and says when they were read", async () => {
    const accountAsks: unknown[] = [];
    const { asks } = await mount({ usageAccounts: async (ask?: { fresh?: boolean }) => (accountAsks.push(ask), { accounts: accounts() }) } as Partial<Api>);
    expect(text(document.querySelector("[data-k=usage-read-at]"))).toBe("checked just now");
    const refresh = document.querySelector<HTMLElement>("[data-k=usage-refresh]")!;
    expect(refresh.getAttribute("aria-label")).toBe(USAGE_PAGE_WORDS.readAgain);
    expect([asks.length, accountAsks.length]).toEqual([2, 1]);
    fireEvent.click(refresh);
    await settle();
    expect([asks.length, accountAsks.length]).toEqual([4, 2]);
    expect(accountAsks).toEqual([{ fresh: true }, { fresh: true }]);
    // The Limits tab stands under the same head.
    fireEvent.click(document.querySelector("[data-k=usage-tabs] [data-segment=limits]")!);
    await settle();
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=usage-refresh]")!);
    await settle();
    expect(accountAsks.length).toBe(3);
  });

  it("reads again by itself each minute the page stands open, and on the window's focus only once a minute has passed", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-01T09:30:20Z"));
    let accountAsks = 0;
    const { asks } = await mount({ usageAccounts: async () => (accountAsks++, { accounts: accounts() }) } as Partial<Api>);
    expect([asks.length, accountAsks]).toEqual([2, 1]);
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(accountAsks).toBe(1);
    act(() => vi.advanceTimersByTime(60_000));
    await settle();
    expect([asks.length, accountAsks]).toEqual([4, 2]);
    act(() => vi.setSystemTime(Date.now() + 30_000));
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(accountAsks).toBe(2);
    act(() => vi.setSystemTime(Date.now() + 31_000));
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(accountAsks).toBe(3);
  });

  it("keeps what an act wrote inside the hold, rather than drawing the older answer again on the next opening", async () => {
    await mount({ sshInclude: async () => false } as Partial<Api>);
    expect(useSettingsStore.getState().reads.sshInclude).toBe(false);
    cleanup();
    act(() => useSettingsStore.getState().setReads({ sshInclude: true }));
    useStore.setState({ settingsOpen: false });
    mountSettings({ api: useStore.getState().api!, at: { kind: "group", group: "usage" } });
    await settle();
    expect(useSettingsStore.getState().reads.sshInclude).toBe(true);
  });
});

describe("Usage: limits", () => {
  it("says a Codex account's banked resets under its pool, and spends one only after the person says yes to the shared question", async () => {
    const day = 24 * HOUR;
    const banked: AccountRow = { ...codexPlus(), credits: { count: 2, nextExpiresAt: minute() + 21 * day, readAt: minute() } };
    const spent: string[] = [];
    await mountLimits({
      usageAccounts: async () => ({ accounts: accounts().map(row => (row.key === banked.key ? banked : row)) }),
      usageReset: async account => {
        spent.push(account);
        return { outcome: "reset", said: RESET_WORDS.reset("Codex with ChatGPT Plus", 1), account: { ...banked, credits: { count: 1, readAt: minute() } } };
      },
    });
    const line = $("[data-usage-resets='codex:acct-1']")!;
    expect(text(line.querySelector("[data-k=banked]"))).toBe(creditsWord(banked.credits!, minute()));
    fireEvent.click(line.querySelector("[data-k=use-reset]")!);
    await settle();
    expect(text(document.querySelector("[data-k=reset-question]"))).toBe(resetQuestion("Codex with ChatGPT Plus", 2));
    expect(spent).toEqual([]);
    fireEvent.click(document.querySelector("[data-k=reset-confirm]")!);
    await settle();
    expect(spent).toEqual(["codex:acct-1"]);
    expect(text($("[data-usage-resets='codex:acct-1'] [data-k=banked]"))).toBe("1 banked");
  });

  it("draws no Use reset where nothing is banked, and no resets line where the host has read none", async () => {
    const none: AccountRow = { ...codexPlus(), credits: { count: 0, readAt: minute() } };
    await mountLimits({ usageAccounts: async () => ({ accounts: [none] }), usageReset: async () => ({ outcome: "noCredit", said: "" }) });
    expect(text($("[data-usage-resets='codex:acct-1'] [data-k=banked]"))).toBe("none banked");
    expect($("[data-usage-resets='codex:acct-1'] [data-k=use-reset]")).toBeNull();
    cleanup();
    forgetHeld();
    await mountLimits();
    expect($("[data-usage-resets]")).toBeNull();
  });

  it("pools an agent's plan accounts as one card: the account, the computers as one line, when it was checked, and a meter per window with its percent and verdict", async () => {
    await mountLimits();
    const card = $("[data-settings-card=usage-pool-codex]")!;
    expect(text(card.querySelector("[data-settings-head]"))).toBe("Codex");
    const pool = card.querySelector<HTMLElement>("[data-usage-pool=codex]")!;
    expect(pool.querySelector("[data-harness-mark=codex]")).not.toBeNull();
    expect(pool.textContent).toContain("Codex with ChatGPT Plus");
    expect(pool.textContent).toContain("zingzy's MacBook Pro");
    expect(text(pool.querySelector("[data-k=read-at]"))).toBe(USAGE_PAGE_WORDS.checked(ABOUT_WORDS.readWhen(5 * 60_000)));
    expect(pool.querySelector("[data-k=burn]")).toBeNull();
    expect($("[data-usage-account='codex:acct-1']")).toBeNull();
    const session = pool.querySelector<HTMLElement>("[data-window=session]")!;
    expect(text(session.querySelector("[data-k=window]"))).toBe("5-hour");
    expect(text(session.querySelector("[data-k=left]"))).toBe("38%");
    expect(session.querySelectorAll("[data-k=segment]").length).toBe(1);
    expect(session.querySelector<HTMLElement>("[data-k=meter-fill]")!.style.width).toBe("62%");
    const week = pool.querySelector<HTMLElement>("[data-window=week]")!;
    expect(text(week.querySelector("[data-k=window]"))).toBe("Week");
    expect(text(week.querySelector("[data-k=left]"))).toBe("82%");
    expect(text(week.querySelector("[data-k=verdict]"))).toBe(USAGE_PAGE_WORDS.underPace("resets in 40 min"));
    expect(week.querySelector("[data-k=verdict]")!.className).toContain("text-muted-foreground");
  });

  it("marks each segment where an even pace would stand, the share of the window gone", async () => {
    await mountLimits();
    const pace = (kind: string): number => parseFloat($(`[data-usage-pool=codex] [data-window=${kind}] [data-k=pace]`)!.style.left);
    expect(pace("session")).toBeCloseTo((1 - 2.5 / 5) * 100, 6);
    expect(pace("week")).toBeCloseTo((1 - (40 * 60_000) / WEEK_MS) * 100, 6);
  });

  it("says when a window ahead of its pace runs out, at the rate it was used so far, in the warning ink", async () => {
    const now = minute();
    const resetsAt = now + 3 * HOUR;
    await mountLimits({ usageAccounts: async () => ({ accounts: [{ key: "claude:max", agent: "claude", label: "Claude Code with Claude Max", computers: ["Boat"], plan: "max", windows: [{ kind: "session", usedPercent: 50, resetsAt }], status: "ok", readAt: now }] }) } as Partial<Api>);
    const session = $("[data-usage-pool=claude] [data-window=session]")!;
    // Half used with two of five hours gone: it runs out at four hours in, an hour before its reset.
    expect(parseFloat(session.querySelector<HTMLElement>("[data-k=pace]")!.style.left)).toBeCloseTo(40, 6);
    const out = runsOutAt(50, resetsAt, SESSION_MS, now);
    expect(out).toBe(now + 2 * HOUR);
    const verdict = session.querySelector<HTMLElement>("[data-k=verdict]")!;
    expect(text(verdict)).toBe(USAGE_PAGE_WORDS.runsOut(clock.format(out)));
    expect(verdict.className).toContain("text-warning-foreground");
  });

  it("reads the owner's Codex session, 62% with half the window gone, as running out before its reset", async () => {
    await mountLimits();
    const now = minute();
    const out = runsOutAt(62, now + 2.5 * HOUR, SESSION_MS, now);
    expect(text($("[data-usage-pool=codex] [data-window=session] [data-k=verdict]"))).toBe(USAGE_PAGE_WORDS.runsOut(clock.format(out)));
  });

  it("pools two accounts of one agent under a count, their computers in one sentence, a segment each soonest reset first, the mean used, and what they draw now", async () => {
    const now = minute();
    const pro: AccountRow = {
      key: "codex:acct-2",
      agent: "codex",
      label: "Codex with ChatGPT Pro",
      computers: ["Boat"],
      plan: "pro",
      windows: [
        { kind: "session", usedPercent: 36, resetsAt: now + 3 * HOUR },
        { kind: "week", usedPercent: 10, resetsAt: now + 72 * HOUR },
      ],
      status: "ok",
      readAt: now - 2 * 60_000,
      burn: { tokensPerMinute: 12_000, threads: 2 },
    };
    await mountLimits({ usageAccounts: async () => ({ accounts: [pro, codexPlus()] }) } as Partial<Api>);
    expect($$("[data-settings-card^=usage-pool-]").length).toBe(1);
    const pool = $("[data-usage-pool=codex]")!;
    expect(pool.textContent).toContain(USAGE_PAGE_WORDS.accounts(2, "Codex"));
    expect(pool.textContent).toContain("Boat and zingzy's MacBook Pro");
    expect(text(pool.querySelector("[data-k=burn]"))).toBe("Using 12k tokens a minute across 2 threads");
    expect(text(pool.querySelector("[data-k=read-at]"))).toBe(USAGE_PAGE_WORDS.checked(ABOUT_WORDS.readWhen(5 * 60_000)));
    const session = pool.querySelector<HTMLElement>("[data-window=session]")!;
    expect([...session.querySelectorAll<HTMLElement>("[data-k=meter-fill]")].map(fill => fill.style.width)).toEqual(["62%", "36%"]);
    expect(text(session.querySelector("[data-k=left]"))).toBe("51%");
    // Plus runs out before its reset but Pro, a little under pace, lasts past both: the pool is ahead, not out.
    expect(runsOutAt(36, now + 3 * HOUR, SESSION_MS, now)).toBeGreaterThan(now + 3 * HOUR);
    expect(text(session.querySelector("[data-k=verdict]"))).toBe(USAGE_PAGE_WORDS.aheadOfPace("resets in 2 h"));
  });

  it("says in one quiet line why a row has no reading, and names the agents that report no limit once under the list", async () => {
    await mountLimits();
    const card = $("[data-settings-card=usage-limits]")!;
    expect(text(card.querySelector("[data-settings-head]"))).toBe(USAGE_PAGE_WORDS.noPlanLimit);
    expect($$("[data-usage-account]").map(r => text(r.querySelector("[data-settings-title]")))).toEqual(["Claude Code with an API key"]);
    const key = $("[data-usage-account='claude:vault-key']")!;
    expect(key.querySelector("[data-harness-mark=claude]")).not.toBeNull();
    expect(text(key.querySelector("[data-settings-description]"))).toBe("zingzy's MacBook Pro and Boat");
    expect(key.querySelector("[data-window]")).toBeNull();
    expect(text(key.querySelector("[data-k=state]"))).toBe("Pays per token, no plan limit");
    expect($("[data-usage-account='opencode@here']")).toBeNull();
    expect(text($("[data-k=no-limit]"))).toBe("Hermes Agent and OpenCode report no plan limit.");
  });

  it("says a computer's own login's computer once, in its title, with no line repeating it", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [{ key: "codex@here", agent: "codex", label: "Codex signed in on zingzy's MacBook Pro", computers: ["zingzy's MacBook Pro"], note: USAGE_WORDS.unread }] }) } as Partial<Api>);
    const row = $("[data-usage-account='codex@here']")!;
    expect(row.querySelector("[data-settings-description]")).toBeNull();
    expect(text(row.querySelector("[data-k=state]"))).toBe("Not read yet: shows after its next turn");
  });

  it("reads a window past its reset, or older than the window runs, as of when it was read, muted, never as a live limit reached", async () => {
    const readAt = Date.now() - 4 * 24 * HOUR;
    await mountLimits({
      usageAccounts: async () => ({
        accounts: [{ ...codexPlus(), windows: [{ kind: "session", usedPercent: 40 }, { kind: "week", usedPercent: 100, resetsAt: Date.now() - HOUR }], status: "reached", readAt }],
      }),
    } as Partial<Api>);
    for (const kind of ["session", "week"]) {
      const window = $(`[data-usage-pool=codex] [data-window=${kind}]`)!;
      const verdict = window.querySelector<HTMLElement>("[data-k=verdict]")!;
      expect(text(verdict)).toMatch(/^As of /);
      expect(verdict.className).toContain("text-muted-foreground");
      expect(window.querySelector<HTMLElement>("[data-k=left]")!.className).toContain("text-muted-foreground");
      expect(window.querySelector<HTMLElement>("[data-k=meter-fill]")!.className).not.toContain("bg-warning");
    }
    expect(document.body.textContent).not.toContain("Limit reached");
  });

  it("carries the warning ink on a reached limit, with no pace mark where no reset is known", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [{ key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", computers: ["Boat"], windows: [{ kind: "session", usedPercent: 100 }], status: "reached", readAt: Date.now() }] }) } as Partial<Api>);
    const session = $("[data-usage-pool=claude] [data-window=session]")!;
    const verdict = session.querySelector<HTMLElement>("[data-k=verdict]")!;
    expect(text(verdict)).toBe("Limit reached");
    expect(verdict.className).toContain("text-warning-foreground");
    expect(text(session.querySelector("[data-k=left]"))).toBe("0%");
    expect(session.querySelector("[data-k=pace]")).toBeNull();
  });

  it("draws a pool's skeleton from the first paint, so nothing moves when the accounts arrive", async () => {
    await mountLimits({ usageAccounts: () => new Promise<never>(() => {}) } as Partial<Api>);
    const loading = $("[data-k=limits-loading]")!;
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
    expect($("[data-usage-account]")).toBeNull();
    expect($("[data-usage-pool]")).toBeNull();
  });

  it("says no agent is signed in where the host knows no account", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [] }) } as Partial<Api>);
    expect(text($("[data-k=no-accounts]"))).toBe(USAGE_PAGE_WORDS.noAccounts);
  });

  it("says a refused read as refused, never as no agent signed in", async () => {
    await mountLimits({ usageAccounts: async () => Promise.reject(new Error("the host is not answering")) } as Partial<Api>);
    expect(text($("[data-k=limits-refused]"))).toBe(USAGE_PAGE_WORDS.limitsRefused("the host is not answering"));
    expect($("[data-k=no-accounts]")).toBeNull();
  });
});

describe("Usage: used", () => {
  it("says a refused read as refused rather than a skeleton that never ends", async () => {
    await mount({ usageUsed: async () => Promise.reject(new Error("the host is not answering")) } as Partial<Api>);
    expect(text($("[data-k=used-refused]"))).toBe(USAGE_PAGE_WORDS.usedRefused("the host is not answering"));
    expect(document.querySelector("[data-usage-section=used] [aria-busy=true]")).toBeNull();
  });

  it("totals the range: the tokens and what they count, the API estimate at list price and the cache hit, and no threads or turns it was not sent", async () => {
    await mount();
    expect(stat("stat-tokens")).toEqual([USAGE_PAGE_WORDS.tokens, "7.35B", USAGE_PAGE_WORDS.counts(true)]);
    expect(stat("stat-estimate")).toEqual([USAGE_PAGE_WORDS.estimate, "$4,301.74", USAGE_PAGE_WORDS.atListPrice]);
    expect(stat("stat-cache")).toEqual([USAGE_PAGE_WORDS.cacheHit, "93.9%"]);
    expect($("[data-k=stat-threads]")).toBeNull();
    expect($("[data-k=stat-turns]")).toBeNull();
  });

  it("prefers a row's own estimate over what it reported plus its list price, counts the turns where sent, and draws no threads total", async () => {
    const rows: UsedRow[] = [
      { key: "codex", label: "Codex", tokens: { input: 1_000_000, output: 200_000, cached: 600_000, cacheWrite: 100_000 }, costReported: 3, costList: 4, estimate: 10, turns: 12, priced: true },
      { key: "claude", label: "Claude Code", tokens: { input: 5_000_000, output: 50_000, cached: 4_000_000 }, costReported: 2, costList: 1, turns: 30, priced: true },
    ];
    await mountUsed({ rows });
    expect(stat("stat-estimate")[1]).toBe("$13.00");
    // No threads total: a ledger cannot tell a session wsp started from one any other tool did.
    expect($("[data-k=stat-threads]")).toBeNull();
    expect(stat("stat-turns")).toEqual([USAGE_PAGE_WORDS.turns, "42", USAGE_PAGE_WORDS.turnsNote]);
    expect($$("[data-used-row]:not([data-sub])").map(row => row.dataset["usedRow"])).toEqual(["claude", "codex"]);
    expect([...$$("[data-k=used-head] span")].map(text)).toEqual(["Agent and model", "Tokens", "Cache hit", "Turns", "API estimate"]);
    expect(text($("[data-used-row=codex] [data-k=price]"))).toBe("$10.00");
    expect(text($("[data-used-row=claude] [data-k=price]"))).toBe("$3.00");
    expect(text($("[data-used-row=codex] [data-k=turns]"))).toBe("12");
    // Fresh is what was read neither from cache nor into it.
    expect(text($("[data-k=usage-mix] [data-k=mix-fresh]"))).toBe(`${USAGE_PAGE_WORDS.fresh}1.3M`);
    expect(text($("[data-k=usage-mix] [data-k=mix-cache-write]"))).toBe(`${USAGE_PAGE_WORDS.cacheWrite}100k`);
  });

  it("says the totals count wsp's threads alone where the range read no logs", async () => {
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => ({ ...used(range, split), logs: undefined }) } as Partial<Api>);
    expect(stat("stat-tokens")[2]).toBe(USAGE_PAGE_WORDS.counts(false));
  });

  it("splits by source with the figures wsp usage --by source prints for the same answer", async () => {
    const asks: UsageSplit[] = [];
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => (asks.push(split), split === "source" ? USED_BY_SOURCE : used(range, split)) } as Partial<Api>);
    fireEvent.click($("[data-k=usage-split] [data-segment=source]")!);
    await settle();
    expect(asks.at(-1)).toBe("source");
    expect(text($("[data-settings-card=usage-used] [data-settings-head]"))).toBe("By source");
    const row = (key: string): string[] => [...$(`[data-used-row=${key}]`)!.querySelectorAll("[data-settings-title], [data-k=tokens], [data-k=turns], [data-k=price]")].map(text);
    expect(row("log")).toEqual(["Outside wsp", "65.8B", "", "$44,925.05"]);
    expect(row("wsp")).toEqual(["wsp threads", "13.8M", "21", "$8.63"]);
    expect(stat("stat-tokens")).toEqual([USAGE_PAGE_WORDS.tokens, "65.8B", USAGE_PAGE_WORDS.counts(true)]);
    expect(stat("stat-estimate")[1]).toBe("$44,933.68");
    expect(stat("stat-turns")[1]).toBe("21");
    expect([...$$("[data-k=usage-legend] > span")].map(text)).toEqual(["Outside wsp", "wsp threads"]);
  });

  it("splits by account with the use outside wsp counted in, the figures wsp usage --by account prints for the same answer", async () => {
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => (split === "account" ? USED_BY_ACCOUNT : used(range, split)) } as Partial<Api>);
    fireEvent.click($("[data-k=usage-split] [data-segment=account]")!);
    await settle();
    const row = (key: string): string[] => [...$(`[data-used-row="${key}"]`)!.querySelectorAll("[data-settings-title], [data-k=tokens], [data-k=price]")].map(text);
    expect(row("claude@here")).toEqual(["Claude Code with an API key", "65.8B", "$44,928.61"]);
    expect(row("codex:acct-1")).toEqual(["Codex with ChatGPT Plus", "8.2M", "$7.15"]);
    expect(row("claude@pl_hetzner")).toEqual(["Claude Code signed in on hetzner", "0", "$0.00"]);
    expect([...$$("[data-k=usage-legend] > span")].map(text)).toEqual(["Claude Code with an API key", "Codex with ChatGPT Plus"]);
    expect(stat("stat-tokens")[2]).toBe(USAGE_PAGE_WORDS.counts(true));
  });

  it("draws two accounts of one agent in two shades of its ink, and a third agent's in its own", async () => {
    const tokens = (n: number) => ({ input: n, output: 0, cached: 0 });
    const points = (n: number) => [0, 0, 0, 0, 0, 0, n];
    await mountUsed({
      split: "account",
      rows: [
        { key: "codex:acct-1", label: "Codex with ChatGPT Plus", agent: "codex", tokens: tokens(8_300_000), priced: false },
        { key: "claude@here", label: "Claude Code with an API key", agent: "claude", tokens: tokens(5_600_000), priced: false },
        { key: "claude@pl_lab", label: "Claude Code signed in on lab", agent: "claude", tokens: tokens(900_000), priced: false },
      ],
      lines: [
        { key: "codex:acct-1", label: "Codex with ChatGPT Plus", points: points(8_300_000) },
        { key: "claude@here", label: "Claude Code with an API key", points: points(5_600_000) },
        { key: "claude@pl_lab", label: "Claude Code signed in on lab", points: points(900_000) },
      ],
    });
    const ink = (key: string): string => document.querySelector(`[data-usage-chart] [data-line="${key}"]`)!.getAttribute("class") ?? "";
    const claudeInk = agentMark("claude")!.inks![0]!;
    expect(new Set([ink("codex:acct-1"), ink("claude@here"), ink("claude@pl_lab")]).size).toBe(3);
    for (const key of ["claude@here", "claude@pl_lab"]) expect((document.querySelector(`[data-usage-chart] [data-line="${key}"]`) as SVGGElement).style.getPropertyValue("--line-dark")).toBe(claudeInk.dark);
    // The legend's swatch and the table's bar wear the line's own shade.
    const swatches = [...$$("[data-k=usage-legend] > span > span:first-child")].map(el => el.getAttribute("class"));
    expect(swatches.map(c => c?.split(" ").find(w => w.startsWith("text-")))).toEqual([ink("codex:acct-1"), ink("claude@here"), ink("claude@pl_lab")].map(c => c.split(" ").find(w => w.startsWith("text-"))));
  });

  it("reads a week by agent first, and the range and split ask again for theirs", async () => {
    const { asks } = await mount();
    expect(asks).toEqual([["week", "agent"], ["week", "model"]]);
    expect(text($("[data-settings-card=usage-chart] [data-settings-head]"))).toBe("Tokens a day");
    fireEvent.click($("[data-k=usage-range] [data-segment=day]")!);
    await settle();
    fireEvent.click($("[data-k=usage-split] [data-segment=project]")!);
    await settle();
    // By agent the models are asked for too; by project they are not.
    expect(asks.slice(2)).toEqual([
      ["day", "agent"],
      ["day", "model"],
      ["day", "project"],
    ]);
    expect($("[data-k=usage-range] [data-segment=day]")!.getAttribute("aria-checked")).toBe("true");
    expect($("[data-k=usage-range] [data-segment=week]")!.getAttribute("aria-checked")).toBe("false");
    expect(text($("[data-settings-card=usage-chart] [data-settings-head]"))).toBe("Tokens an hour");
    expect(text($("[data-settings-card=usage-used] [data-settings-head]"))).toBe("By project");
    expect(text($("[data-k=used-head] [data-k=split-head]"))).toBe("Project");
  });

  it("draws one row per split value, most first, with its tokens, cache hit and price and no turns column where no row has turns, and a mix whose fresh, cached and out add up to the range", async () => {
    await mount();
    expect([...$$("[data-k=used-head] span")].map(text)).toEqual(["Agent and model", "Tokens", "Cache hit", "API estimate"]);
    expect($("[data-k=turns]")).toBeNull();
    expect($$("[data-used-row]:not([data-sub])").map(row => row.dataset["usedRow"])).toEqual(["claude", "codex"]);
    // Each agent's models stand under it, most first, read off the model split of the same range.
    expect($$("[data-used-group=claude] [data-sub]").map(row => row.dataset["usedRow"])).toEqual(["claude:claude-opus-5-5", "claude:claude-haiku-4-5"]);
    expect($$("[data-used-group=codex] [data-sub]").map(row => row.dataset["usedRow"])).toEqual(["codex:gpt-5.6"]);
    const claude = $("[data-used-row=claude]")!;
    expect(text(claude.querySelector("[data-settings-title]"))).toBe("Claude Code");
    expect([...claude.querySelectorAll("[data-k=tokens], [data-k=cache-hit], [data-k=price]")].map(text)).toEqual(["7.33B", "93.9%", "$4,301.74"]);
    const codex = $("[data-used-row=codex]")!;
    expect(text(codex.querySelector("[data-k=tokens]"))).toBe("22M");
    expect(text(codex.querySelector("[data-k=price]"))).toBe(USAGE_WORDS.notPriced);
    const mix = $("[data-k=usage-mix]")!;
    expect([...mix.querySelectorAll("[data-k^=mix-]")].map(text)).toEqual([`${USAGE_PAGE_WORDS.fresh}450M`, `${USAGE_PAGE_WORDS.cached}6.9B`, `${USAGE_PAGE_WORDS.out}7.34M`]);
  });

  it("stands each model under the agent the host says ran it, so another agent's run on a Claude model never nests under Claude Code", async () => {
    const hermes: UsedRow = { key: "hermes", label: "Hermes Agent", agent: "hermes", tokens: { input: 2_000_000, output: 10_000, cached: 0 }, priced: false };
    const sonnet: UsedRow = { key: "hermes:claude-sonnet-4-5", label: "Sonnet 4.5", agent: "hermes", tokens: { input: 2_000_000, output: 10_000, cached: 0 }, priced: false };
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => (split === "model" ? { ...used(range, split), rows: [...used(range, split).rows, sonnet] } : { ...used(range, split), rows: [...used(range, split).rows, hermes] }) } as Partial<Api>);
    expect($$("[data-used-group=hermes] [data-sub]").map(row => row.dataset["usedRow"])).toEqual(["hermes:claude-sonnet-4-5"]);
    expect($$("[data-used-group=claude] [data-sub]").map(row => row.dataset["usedRow"])).toEqual(["claude:claude-opus-5-5", "claude:claude-haiku-4-5"]);
  });

  it("leads an account's row with the mark of the agent the host names on it, whatever its key", async () => {
    await mountUsed({ split: "account", rows: [{ key: "work-login", label: "Codex with ChatGPT Pro", agent: "codex", tokens: { input: 1_000, output: 10, cached: 0 }, priced: false }] });
    expect($("[data-used-row=work-login] [data-harness-mark=codex]")).not.toBeNull();
  });

  it("leads a computer's row with that computer's glyph by its id, never by a place whose name the key happens to read as", async () => {
    const tokens = { input: 1_000, output: 10, cached: 0 };
    await mountUsed({ split: "computer", rows: [{ key: "here", label: "zingzy's MacBook Pro", tokens, priced: false }, { key: "zingzys-macbook-pro.local", label: "zingzys-macbook-pro.local", tokens, priced: false }] });
    expect($("[data-used-row=here] [data-computer-glyph]")).not.toBeNull();
    expect($("[data-used-row='zingzys-macbook-pro.local'] [data-computer-glyph]")).toBeNull();
  });

  it("lays the totals out off classes alone, so under 640 px they fold to two columns as the skeleton does", async () => {
    await mount();
    const totals = $("[data-k=usage-totals]")!;
    expect(totals.style.gridTemplateColumns).toBe("");
    expect(totals.className.split(" ")).toEqual(expect.arrayContaining(["grid-cols-3", "max-sm:grid-cols-2"]));
  });

  it("draws the tokens as one line, its legend all agents together, each day's figure readable on hover, and says once whose logs it counted", async () => {
    const paint = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await mount();
    const chart = $("[data-usage-chart=tokens]")!;
    // jsdom has no 2D context: the dither asks for one and leaves the canvas blank, the lines still drawn.
    expect(paint).toHaveBeenCalled();
    expect(chart.querySelector("canvas")).not.toBeNull();
    expect([...chart.querySelectorAll<HTMLElement>("[data-line]")].map(line => line.dataset["line"])).toEqual(["tokens"]);
    expect(chart.querySelector("[data-line=tokens] polyline")!.getAttribute("points")!.split(" ").length).toBe(7);
    expect(chart.querySelector("[fill]:not([fill=none])")).toBeNull();
    expect([...$$("[data-k=usage-legend] > span")].map(text)).toEqual([USAGE_PAGE_WORDS.allOf.agent]);
    expect(chart.querySelectorAll("[data-k=tick]").length).toBe(7);
    const points = [...chart.querySelectorAll<HTMLElement>("[data-k=point]")];
    expect(points.length).toBe(7);
    // No native title: the figure comes in the app's tooltip.
    expect(points.some(point => point.hasAttribute("title"))).toBe(false);
    await hover(points[2]!);
    expect([...document.querySelectorAll("[data-k=point-figure]")].map(text)).toEqual([`${USAGE_PAGE_WORDS.tokens}300M`]);
    expect(text($("[data-k=logs]"))).toBe(logsLine({ agents: ["Claude Code", "Codex"], computers: ["zingzy's MacBook Pro"] }));
  });

  it("draws one line per split value with a legend, Claude in its mark's ink and Codex down the neutral ramp, and each line's figure on hover", async () => {
    await mountUsed({
      lines: [
        { key: "claude", label: "Claude Code", points: [10, 20, 30_000_000, 40, 50, 60, 70] },
        { key: "codex", label: "Codex", points: [1, 2, 4_000_000, 4, 5, 6, 7] },
      ],
    });
    const chart = $("[data-usage-chart=tokens]")!;
    expect([...$$("[data-k=usage-legend] > span")].map(text)).toEqual(["Claude Code", "Codex"]);
    const lines = [...chart.querySelectorAll<SVGGElement>("[data-line]")];
    expect(lines.map(line => line.dataset["line"]).sort()).toEqual(["claude", "codex"]);
    expect(lines.every(line => line.querySelectorAll("polyline").length === 1)).toBe(true);
    const claude = chart.querySelector<SVGGElement>("[data-line=claude]")!;
    expect(claude.style.getPropertyValue("--line-light")).toBe(agentMark("claude")!.inks![0]!.light);
    expect(claude.style.getPropertyValue("--line-dark")).toBe(agentMark("claude")!.inks![0]!.dark);
    expect(chart.querySelector("[data-line=codex]")!.getAttribute("class")).toBe("text-muted-foreground");
    await hover(chart.querySelectorAll<HTMLElement>("[data-k=point]")[2]!);
    expect([...document.querySelectorAll("[data-k=point-figure]")].map(text)).toEqual(["Claude Code30M", "Codex4M"]);
  });

  it("says nothing was used in the chart's place, with no totals, no rows and no logs line", async () => {
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => used(range, split, false) } as Partial<Api>);
    expect(text($("[data-k=no-use]"))).toBe(USAGE_WORDS.noUse);
    expect($("[data-usage-chart=tokens]")).toBeNull();
    expect($("[data-k=usage-totals]")).toBeNull();
    expect($$("[data-used-row]")).toEqual([]);
    expect($("[data-k=logs]")).toBeNull();
  });
});

describe("Usage: loading", () => {
  it("draws the totals, the chart and the table as skeletons while the answer is on the way, the controls already there", async () => {
    await mount({ usageUsed: () => new Promise<never>(() => {}) } as Partial<Api>);
    const loading = $("[data-k=used-loading]")!;
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(10);
    expect($("[data-k=usage-range]")).not.toBeNull();
    expect($("[data-k=usage-totals]")).toBeNull();
  });
});

describe("Usage: the tabs", () => {
  it("opens on what was used, and Limits in the top bar's tabs shows the accounts in its place", async () => {
    await mount();
    const tabs = document.querySelector("[data-thread-breadcrumb] ~ * [data-k=usage-tabs]")!;
    expect([...tabs.querySelectorAll("[data-segment]")].map(text)).toEqual([USAGE_PAGE_WORDS.tabs.used, USAGE_PAGE_WORDS.tabs.limits]);
    expect($("[data-settings-card=usage-used]")).not.toBeNull();
    expect($("[data-settings-card=usage-limits]")).toBeNull();
    fireEvent.click(tabs.querySelector("[data-segment=limits]")!);
    await settle();
    expect($("[data-settings-card=usage-limits]")).not.toBeNull();
    expect($("[data-settings-card=usage-pool-codex]")).not.toBeNull();
    expect($("[data-settings-card=usage-used]")).toBeNull();
  });
});

describe("Usage: what it is", () => {
  it("is accounts, tokens and money alone: no computer's load, and no reading of one asked for", async () => {
    const { readings } = await mount();
    expect($("[data-usage-section=computers]")).toBeNull();
    expect(readings).toEqual([]);
    expect(document.querySelector("[data-settings-page]")?.textContent).not.toMatch(/busy/);
  });
});

describe("Privacy: the agent logs", () => {
  it("a switch turns the reading of this computer's agent logs off", async () => {
    const { api, sets } = settingsApi();
    mountSettings({ api, at: { kind: "group", group: "privacy" } });
    await settle();
    expect(text(rowOf("usage-logs")?.querySelector("[data-settings-title]"))).toBe(PRIVACY_WORDS.usageLogs);
    fireEvent.click(document.querySelector("[data-k=usage-logs]")!);
    await settle();
    expect(sets).toEqual([{ usageLogs: false }]);
  });
});
