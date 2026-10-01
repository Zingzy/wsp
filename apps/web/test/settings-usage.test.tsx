// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage in the owner's shape: Claude Code with an API key on the Mac
// and Boat, Codex with ChatGPT Plus on the Mac, agents that report no limit as
// one line; then what was used over a range in one line, one chart with no
// fill, and a table whose fresh, cached and out add up to the row. No
// computer's load stands on the page.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountRow, PlaceView, UsageRange, UsageSplit, UsedAnswer } from "@wsp/protocol";
import { logsLine, usedHeadline, USAGE_WORDS } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { PRIVACY_WORDS, USAGE_PAGE_WORDS } from "../src/settings/format.js";
import { mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzys-macbook-pro.local", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false, shape: { cpu: 10, memMb: 32_768 } };
const boat: PlaceView = { id: "box", kind: "provider", name: "box", default: false, takesForks: true };

const HOUR = 3_600_000;
// The page reads the minute clock, so a reset is set off the minute it will read.
const minute = (): number => Math.floor(Date.now() / 60_000) * 60_000;
const accounts = (): AccountRow[] => [
  { key: "claude:vault-key", agent: "claude", label: "Claude Code with an API key", computers: ["zingzy's MacBook Pro", "Boat"], note: USAGE_WORDS.keyed },
  {
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
    readAt: Date.now() - 60_000,
  },
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

const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] ${sel}`);
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-settings-page] ${sel}`)];
const text = (el: Element | null | undefined): string => el?.textContent ?? "";

beforeEach(() => {
  resetSettings();
  useStore.setState({ places: [here, boat] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Usage: limits", () => {
  it("lists each real account in plain words with the computers it is used on as one line, and a reading as a thin meter per window with its percent and reset", async () => {
    await mountLimits();
    expect($$("[data-usage-account]").map(r => text(r.querySelector("[data-settings-title]")))).toEqual(["Claude Code with an API key", "Codex with ChatGPT Plus"]);
    const codex = $("[data-usage-account='codex:acct-1']")!;
    expect(codex.querySelector("[data-harness-mark=codex]")).not.toBeNull();
    expect(text(codex.querySelector("[data-settings-description]"))).toBe("zingzy's MacBook Pro");
    const session = codex.querySelector<HTMLElement>("[data-window=session]")!;
    expect(text(session.querySelector("[data-k=window]"))).toBe(USAGE_PAGE_WORDS.session);
    expect(text(session.querySelector("[data-k=percent]"))).toBe("62%");
    expect(text(session.querySelector("[data-k=resets]"))).toBe("resets in 2 h");
    expect(session.querySelector<HTMLElement>("[data-k=meter-fill]")!.style.width).toBe("62%");
    expect(text(codex.querySelector("[data-window=week] [data-k=percent]"))).toBe("18%");
    expect(text(codex.querySelector("[data-window=week] [data-k=resets]"))).toBe("resets in 40 min");
  });

  it("says in one quiet line why a row has no reading, and names the agents that report no limit once under the list", async () => {
    await mountLimits();
    const key = $("[data-usage-account='claude:vault-key']")!;
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

  it("carries the warning ink on a reached limit alone", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [{ key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", computers: ["Boat"], windows: [{ kind: "session", usedPercent: 100 }], status: "reached", readAt: Date.now() }] }) } as Partial<Api>);
    const state = $("[data-usage-account='claude:vault-token'] [data-k=state]")!;
    expect(text(state)).toBe("Limit reached");
    expect(state.className).toContain("text-warning-foreground");
  });

  it("stands a row's room from the first paint, so nothing moves when the accounts arrive", async () => {
    await mountLimits({ usageAccounts: () => new Promise<never>(() => {}) } as Partial<Api>);
    const card = $("[data-settings-card=usage-limits]")!;
    expect(card.querySelector("[data-k=limits-loading]")).not.toBeNull();
    expect($("[data-usage-account]")).toBeNull();
  });

  it("says no agent is signed in where the host knows no account", async () => {
    await mountLimits({ usageAccounts: async () => ({ accounts: [] }) } as Partial<Api>);
    expect(text($("[data-k=no-accounts]"))).toBe(USAGE_PAGE_WORDS.noAccounts);
  });
});

describe("Usage: used", () => {
  it("says the range in one line: the tokens, the price at list price and the cached share", async () => {
    await mount();
    expect(text($("[data-k=used-headline]"))).toBe(usedHeadline(used("week", "agent")));
    expect(text($("[data-k=used-headline]"))).toBe("7.35B tokens in the last 7 days, $4,301.74 at list price, 6.9B of it read from cache. Some of it has no price to read, so the figure leaves it out.");
  });

  it("reads a week by agent first, and the small quiet controls ask again for their range and split", async () => {
    const { asks } = await mount();
    expect(asks).toEqual([["week", "agent"]]);
    fireEvent.click($("[data-k=usage-range] [data-range=month]")!);
    await settle();
    fireEvent.click($("[data-k=usage-split] [data-split=project]")!);
    await settle();
    expect(asks.slice(1)).toEqual([
      ["month", "agent"],
      ["month", "project"],
    ]);
    expect($("[data-k=usage-range] [data-range=month]")!.getAttribute("aria-pressed")).toBe("true");
    expect($("[data-k=usage-range] [data-range=week]")!.getAttribute("aria-pressed")).toBe("false");
    expect(text($("[data-k=used-head] [data-k=split-head]"))).toBe("Project");
  });

  it("draws one row per split value with fresh in, cached and out that add up to it, and the price with its word", async () => {
    await mount();
    expect([...$$("[data-k=used-head] span")].map(text)).toEqual(["Agent", "Fresh in", "Cached", "Out", "Price"]);
    const claude = $("[data-used-row=claude]")!;
    expect([...claude.querySelectorAll("[data-k=fresh], [data-k=cached], [data-k=out]")].map(text)).toEqual(["449M", "6.87B", "7.3M"]);
    expect(text(claude.querySelector("[data-k=price]"))).toBe("$4,301.74");
    expect(text(claude.querySelector("[data-k=price-word]"))).toBe(USAGE_WORDS.listPrice);
    const codex = $("[data-used-row=codex]")!;
    expect(codex.querySelector("[data-k=price]")).toBeNull();
    expect(text(codex.querySelector("[data-k=price-word]"))).toBe(USAGE_WORDS.notPriced);
  });

  it("draws the tokens as one line with no fill, each day's point readable on hover, and says once whose logs it counted", async () => {
    await mount();
    const chart = $("[data-usage-chart=tokens]")!;
    expect(chart.querySelectorAll("[data-chart-line]").length).toBe(1);
    expect(chart.querySelectorAll("[data-chart-area]").length).toBe(0);
    expect(chart.querySelectorAll("[data-k=tick]").length).toBe(7);
    const points = [...chart.querySelectorAll<HTMLElement>("[data-k=point]")];
    expect(points.length).toBe(7);
    // No native title: the figure comes in the app's tooltip, and the point it reads is drawn on the line.
    expect(points.some(point => point.hasAttribute("title"))).toBe(false);
    expect(chart.querySelector("[data-chart-mark]")).toBeNull();
    fireEvent.pointerEnter(points[2]!, { pointerType: "mouse" });
    fireEvent.mouseEnter(points[2]!);
    fireEvent.mouseMove(points[2]!);
    await settle();
    expect(chart.querySelector("[data-chart-mark]")).not.toBeNull();
    expect(text(document.querySelector("[data-k=point-figure]"))).toMatch(/: 300M tokens$/);
    fireEvent.mouseLeave(points[2]!);
    await settle();
    expect(chart.querySelector("[data-chart-mark]")).toBeNull();
    expect(text($("[data-k=logs]"))).toBe(logsLine({ agents: ["Claude Code", "Codex"], computer: "zingzy's MacBook Pro" }));
  });

  it("says nothing was used in the chart's place, with no rows and no logs line", async () => {
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => used(range, split, false) } as Partial<Api>);
    expect($("[data-usage-chart=tokens] svg")).toBeNull();
    expect(text($("[data-k=used-headline]"))).toBe(USAGE_WORDS.noUse);
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
    expect($("[data-settings-card=usage-used]")).toBeNull();
  });
});

describe("Usage: what it is", () => {
  it("is accounts, tokens and money alone: no computer's load, and no reading of one asked for", async () => {
    const { readings } = await mount();
    expect($("[data-usage-section=computers]")).toBeNull();
    expect(readings).toEqual([]);
    expect(document.querySelector("[data-settings-page] header")?.textContent).not.toMatch(/busy/);
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
