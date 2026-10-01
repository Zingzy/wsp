// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage in the owner's shape: Claude Code with an API key on the Mac
// and Boat, Codex with ChatGPT Plus on the Mac pooled as Codex's card, agents
// that report no limit as one line; then what was used over a range as totals,
// a chart of one line per split value with no fill, the split as a table, the
// token mix, the top threads and where it was read. No computer's load stands
// on the page.
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMark } from "@wsp/catalog";
import type { AccountRow, PlaceView, UsageRange, UsageSplit, UsedAnswer, UsedRow } from "@wsp/protocol";
import { logsLine, USAGE_WORDS } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ABOUT_WORDS, PRIVACY_WORDS, USAGE_PAGE_WORDS } from "../src/settings/format.js";
import { mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";

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
  rows: rows
    ? [
        { key: "claude", label: "Claude Code", tokens: { input: 7_323_700_000, output: 7_300_000, cached: 6_874_800_000 }, costList: 4_301.74, priced: true },
        { key: "codex", label: "Codex", tokens: { input: 22_000_000, output: 42_000, cached: 20_700_000 }, priced: false },
      ]
    : [],
  series: Array.from({ length: 7 }, (_, i) => ({ t: Date.parse("2026-09-24T00:00:00Z") + i * 24 * HOUR, tokens: rows ? (i + 1) * 100_000_000 : 0 })),
  since: Date.parse("2026-09-24T00:00:00Z"),
  until: Date.parse("2026-10-01T00:00:00Z"),
  ...(rows ? { logs: { agents: ["Claude Code", "Codex"], computer: "zingzy's MacBook Pro" } } : {}),
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
const mountUsed = (answer: Partial<UsedAnswer>): Promise<unknown> => mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => ({ ...used(range, split), ...answer }) } as Partial<Api>);

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
  resetSettings();
  useStore.setState({ places: [here, boat] });
});

afterEach(() => {
  // Unmounted before the body is cleared, so a tooltip still open takes its portal out of a body that still holds it.
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Usage: limits", () => {
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
    expect(text(session.querySelector("[data-k=percent]"))).toBe("62%");
    expect(session.querySelectorAll("[data-k=segment]").length).toBe(1);
    expect(session.querySelector<HTMLElement>("[data-k=meter-fill]")!.style.width).toBe("62%");
    const week = pool.querySelector<HTMLElement>("[data-window=week]")!;
    expect(text(week.querySelector("[data-k=window]"))).toBe("Week");
    expect(text(week.querySelector("[data-k=percent]"))).toBe("18%");
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
    expect(text(session.querySelector("[data-k=percent]"))).toBe("49%");
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

  it("carries the warning ink on a reached limit, with no pace mark where no reset is known", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [{ key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", computers: ["Boat"], windows: [{ kind: "session", usedPercent: 100 }], status: "reached", readAt: Date.now() }] }) } as Partial<Api>);
    const session = $("[data-usage-pool=claude] [data-window=session]")!;
    const verdict = session.querySelector<HTMLElement>("[data-k=verdict]")!;
    expect(text(verdict)).toBe("Limit reached");
    expect(verdict.className).toContain("text-warning-foreground");
    expect(text(session.querySelector("[data-k=percent]"))).toBe("100%");
    expect(session.querySelector("[data-k=pace]")).toBeNull();
  });

  it("stands a row's room from the first paint, so nothing moves when the accounts arrive", async () => {
    await mountLimits({ usageAccounts: () => new Promise<never>(() => {}) } as Partial<Api>);
    const card = $("[data-settings-card=usage-limits]")!;
    expect(card.querySelector("[data-k=limits-loading]")).not.toBeNull();
    expect($("[data-usage-account]")).toBeNull();
    expect($("[data-usage-pool]")).toBeNull();
  });

  it("says no agent is signed in where the host knows no account", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [] }) } as Partial<Api>);
    expect(text($("[data-k=no-accounts]"))).toBe(USAGE_PAGE_WORDS.noAccounts);
  });
});

describe("Usage: used", () => {
  it("totals the range: the tokens with the cached share, the API estimate at list price and the cache hit, and no threads or turns it was not sent", async () => {
    await mount();
    expect(stat("stat-tokens")).toEqual([USAGE_PAGE_WORDS.tokens, "7.35B", USAGE_PAGE_WORDS.fromCache("93.9%")]);
    expect(stat("stat-estimate")).toEqual([USAGE_PAGE_WORDS.estimate, "$4,301.74", USAGE_PAGE_WORDS.atListPrice]);
    expect(stat("stat-cache")).toEqual([USAGE_PAGE_WORDS.cacheHit, "93.9%"]);
    expect($("[data-k=stat-threads]")).toBeNull();
    expect($("[data-k=stat-turns]")).toBeNull();
  });

  it("prefers a row's own estimate over what it reported plus its list price, and counts the threads and turns where sent", async () => {
    const rows: UsedRow[] = [
      { key: "codex", label: "Codex", tokens: { input: 1_000_000, output: 200_000, cached: 600_000, cacheWrite: 100_000 }, costReported: 3, costList: 4, estimate: 10, turns: 12, priced: true },
      { key: "claude", label: "Claude Code", tokens: { input: 5_000_000, output: 50_000, cached: 4_000_000 }, costReported: 2, costList: 1, turns: 30, priced: true },
    ];
    await mountUsed({ rows, counts: { threads: 7, computers: 2 } });
    expect(stat("stat-estimate")[1]).toBe("$13.00");
    expect(stat("stat-threads")).toEqual([USAGE_PAGE_WORDS.threads, "7", USAGE_PAGE_WORDS.onComputers(2)]);
    expect(stat("stat-turns")).toEqual([USAGE_PAGE_WORDS.turns, "42", USAGE_PAGE_WORDS.turnsNote]);
    expect($$("[data-used-row]").map(row => row.dataset["usedRow"])).toEqual(["claude", "codex"]);
    expect([...$$("[data-k=used-head] span")].map(text)).toEqual(["Agent", "Tokens", "Cache hit", "Turns", "API estimate"]);
    expect(text($("[data-used-row=codex] [data-k=price]"))).toBe("$10.00");
    expect(text($("[data-used-row=claude] [data-k=price]"))).toBe("$3.00");
    expect(text($("[data-used-row=codex] [data-k=turns]"))).toBe("12");
    // Fresh is what was read neither from cache nor into it.
    expect(text($("[data-k=usage-mix] [data-k=mix-fresh]"))).toBe(`${USAGE_PAGE_WORDS.fresh}1.3M`);
    expect(text($("[data-k=usage-mix] [data-k=mix-cache-write]"))).toBe(`${USAGE_PAGE_WORDS.cacheWrite}100k`);
  });

  it("reads a week by agent first, and the range and split ask again for theirs", async () => {
    const { asks } = await mount();
    expect(asks).toEqual([["week", "agent"]]);
    expect(text($("[data-settings-card=usage-chart] [data-settings-head]"))).toBe("Tokens a day");
    fireEvent.click($("[data-k=usage-range] [data-segment=day]")!);
    await settle();
    fireEvent.click($("[data-k=usage-split] [data-segment=project]")!);
    await settle();
    expect(asks.slice(1)).toEqual([
      ["day", "agent"],
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
    expect([...$$("[data-k=used-head] span")].map(text)).toEqual(["Agent", "Tokens", "Cache hit", "API estimate"]);
    expect($("[data-k=turns]")).toBeNull();
    expect($$("[data-used-row]").map(row => row.dataset["usedRow"])).toEqual(["claude", "codex"]);
    const claude = $("[data-used-row=claude]")!;
    expect(text(claude.querySelector("[data-k=label]"))).toBe("Claude Code");
    expect([...claude.querySelectorAll("[data-k=tokens], [data-k=cache-hit], [data-k=price]")].map(text)).toEqual(["7.33B", "93.9%", "$4,301.74"]);
    const codex = $("[data-used-row=codex]")!;
    expect(text(codex.querySelector("[data-k=tokens]"))).toBe("22M");
    expect(text(codex.querySelector("[data-k=price]"))).toBe(USAGE_WORDS.notPriced);
    const mix = $("[data-k=usage-mix]")!;
    expect([...mix.querySelectorAll("[data-k^=mix-]")].map(text)).toEqual([`${USAGE_PAGE_WORDS.fresh}450M`, `${USAGE_PAGE_WORDS.cached}6.9B`, `${USAGE_PAGE_WORDS.out}7.34M`]);
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
    expect(text($("[data-k=logs]"))).toBe(logsLine({ agents: ["Claude Code", "Codex"], computer: "zingzy's MacBook Pro" }));
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

  it("lists the threads that used the most, and a click opens that thread and shuts Settings", async () => {
    await mountUsed({
      threads: [
        { threadId: "t-relay", workspaceId: "w-relay", title: "Fix the relay", agent: "claude", workspace: "relay-fix", computer: "Boat", tokens: 2_000_000, estimate: 4.5 },
        { threadId: "t-chart", workspaceId: "w-chart", title: "Draw the chart", agent: "codex", tokens: 900_000 },
      ],
    });
    expect(text($("[data-settings-card=usage-threads] [data-settings-head]"))).toBe(USAGE_PAGE_WORDS.topThreads);
    expect($$("[data-usage-thread]").map(row => row.dataset["usageThread"])).toEqual(["t-relay", "t-chart"]);
    const relay = $("[data-usage-thread=t-relay]")!;
    expect(relay.textContent).toContain("Fix the relay");
    expect(relay.textContent).toContain("2M");
    expect(relay.textContent).toContain("$4.50");
    fireEvent.click(relay);
    await settle();
    const state = useStore.getState();
    expect([state.selectedId, state.selectedThreadId, state.settingsOpen]).toEqual(["w-relay", "t-relay", false]);
  });

  it("splits the range by where it was read, wsp's threads and the agents' own logs", async () => {
    await mountUsed({
      sources: [
        { source: "wsp", tokens: 5_000_000, estimate: 12 },
        { source: "log", tokens: 2_000_000 },
      ],
    });
    expect(text($("[data-settings-card=usage-sources] [data-settings-head]"))).toBe(USAGE_PAGE_WORDS.sources);
    expect($$("[data-usage-source]").map(row => row.dataset["usageSource"])).toEqual(["wsp", "log"]);
    expect([...$("[data-usage-source=wsp]")!.children].map(text)).toEqual([USAGE_PAGE_WORDS.fromWsp, "5M", "$12.00"]);
    expect([...$("[data-usage-source=log]")!.children].map(text)).toEqual([USAGE_PAGE_WORDS.fromLogs, "2M", ""]);
  });

  it("draws no threads or sources card where the answer carries none", async () => {
    await mount();
    expect($("[data-settings-card=usage-threads]")).toBeNull();
    expect($("[data-settings-card=usage-sources]")).toBeNull();
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
