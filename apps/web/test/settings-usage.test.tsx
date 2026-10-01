// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage: each account's limits with the warning ink on a reached
// limit alone, what was used over a range split four ways with its one line
// chart, each computer's readings as three small line charts with a gap where
// no reading was kept, and the Privacy switch over the log reading.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountRow, PlaceView, ReadingsAnswer, SysPoint, UsageRange, UsageSplit, UsedAnswer } from "@wsp/protocol";
import { USAGE_WORDS } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { PRIVACY_WORDS, USAGE_PAGE_WORDS } from "../src/settings/format.js";
import { mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false, shape: { cpu: 10, memMb: 32_768 } };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true, shape: { cpu: 8, memMb: 16_384 } };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };

const HOUR = 3_600_000;
// The page reads the minute clock, so a reset is set off the minute it will read.
const minute = (): number => Math.floor(Date.now() / 60_000) * 60_000;
const accounts = (): AccountRow[] => [
  {
    key: "codex:acct-1",
    agent: "codex",
    label: "zingzy@example.com",
    computers: ["zingzy's MacBook Pro", "spoo"],
    plan: "plus",
    windows: [
      { kind: "session", usedPercent: 62, resetsAt: minute() + 2.5 * HOUR },
      { kind: "week", usedPercent: 18.4, resetsAt: minute() + 40 * 60_000 },
    ],
    status: "ok",
    readAt: Date.now() - 60_000,
  },
  { key: "claude:vault-token", agent: "claude", label: "Claude on the vault", computers: ["spoo"], windows: [{ kind: "session", usedPercent: 100 }], status: "reached", readAt: Date.now() - 60_000 },
  { key: "claude@here", agent: "claude", label: "Claude Code", computers: ["zingzy's MacBook Pro"], note: "no plan limit: signed in with a key" },
];

const used = (range: UsageRange, split: UsageSplit, rows = true): UsedAnswer => ({
  range,
  split,
  rows: rows
    ? [
        { key: "claude", label: "Claude Code", tokens: { input: 1_200_000, output: 48_000, cached: 9_000_000 }, costList: 4.2, priced: true },
        { key: "codex", label: "Codex", tokens: { input: 300_000, output: 12_000, cached: 0 }, priced: false, outside: true },
      ]
    : [],
  series: rows ? Array.from({ length: 7 }, (_, i) => ({ t: Date.parse("2026-09-24T00:00:00Z") + i * 24 * HOUR, tokens: (i + 1) * 100_000 })) : Array.from({ length: 7 }, (_, i) => ({ t: Date.parse("2026-09-24T00:00:00Z") + i * 24 * HOUR, tokens: 0 })),
  since: Date.parse("2026-09-24T00:00:00Z"),
  until: Date.parse("2026-10-01T00:00:00Z"),
});

const point = (at: number, cpu: number): SysPoint => ({ at, cpu, load1: 1, mem: { used: 8, total: 32 }, disk: { used: 50, total: 200 } });
const TO = Date.parse("2026-09-30T12:00:00Z");
const FROM = TO - 7 * 24 * HOUR;
const STEP = 30 * 60_000;
// Two runs of readings with a day between them that has none: the box was paused.
const readingsOf = (placeId: string): ReadingsAnswer =>
  placeId === "here"
    ? { points: [...Array.from({ length: 4 }, (_, i) => point(FROM + i * STEP, 10 + i)), ...Array.from({ length: 3 }, (_, i) => point(FROM + 2 * 24 * HOUR + i * STEP, 40 + i))], stepMs: STEP, from: FROM, to: TO }
    : { points: [], stepMs: STEP, from: FROM, to: TO };

interface Asks {
  used: [UsageRange, UsageSplit][];
  readings: [string, UsageRange][];
}

const mount = async (over: Partial<Api> = {}): Promise<{ asks: Asks; sets: ReturnType<typeof settingsApi>["sets"] }> => {
  const asks: Asks = { used: [], readings: [] };
  const { api, sets } = settingsApi({
    usageAccounts: async () => ({ accounts: accounts() }),
    usageUsed: async (range: UsageRange, split: UsageSplit) => {
      asks.used.push([range, split]);
      return used(range, split);
    },
    placesReadings: async (placeId: string, range: UsageRange) => {
      asks.readings.push([placeId, range]);
      return readingsOf(placeId);
    },
    ...over,
  } as Partial<Api>);
  mountSettings({ api, at: { kind: "group", group: "usage" } });
  await settle();
  return { asks, sets };
};

const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] ${sel}`);
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-settings-page] ${sel}`)];
const text = (el: Element | null | undefined): string => el?.textContent ?? "";

beforeEach(() => {
  resetSettings();
  useStore.setState({ places: [here, box, solari] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Usage: accounts", () => {
  it("lists each account once with its computers as the note, a meter and percent per window with its reset, and the plan", async () => {
    await mount();
    expect($$("[data-usage-account]").map(r => r.dataset["usageAccount"])).toEqual(["codex:acct-1", "claude:vault-token", "claude@here"]);
    const codex = $("[data-usage-account='codex:acct-1']")!;
    expect(codex.querySelector("[data-harness-mark=codex]")).not.toBeNull();
    expect(text(codex.querySelector("[data-k=label]"))).toBe("zingzy@example.com");
    expect(text(codex.querySelector("[data-k=note]"))).toBe("zingzy's MacBook Pro, spoo");
    const session = codex.querySelector<HTMLElement>("[data-window=session]")!;
    expect(text(session.querySelector("[data-k=percent]"))).toBe("62%");
    expect(text(session.querySelector("[data-k=resets]"))).toBe("resets in 2 h");
    expect(session.querySelector<HTMLElement>("[data-k=meter-fill]")!.style.width).toBe("62%");
    expect(text(codex.querySelector("[data-window=week] [data-k=percent]"))).toBe("18%");
    expect(text(codex.querySelector("[data-window=week] [data-k=resets]"))).toBe("resets in 40 min");
    expect(text(codex.querySelector("[data-k=plan]"))).toBe("plus");
    expect(text(codex.querySelector("[data-k=state]"))).toBe("");
  });

  it("carries the warning ink on a reached limit alone, and a row with no reading says why in its state cell", async () => {
    await mount();
    const reached = $("[data-usage-account='claude:vault-token'] [data-k=state]")!;
    expect(text(reached)).toBe("Limit reached");
    expect(reached.className).toContain("text-warning-foreground");
    expect($$(".text-warning-foreground")).toEqual([reached]);
    const keyed = $("[data-usage-account='claude@here']")!;
    expect(keyed.querySelector("[data-window]")).toBeNull();
    expect(text(keyed.querySelector("[data-k=state]"))).toBe("No plan limit: signed in with a key");
  });

  it("says no agent is signed in where the host knows no account", async () => {
    await mount({ usageAccounts: async () => ({ accounts: [] }) } as Partial<Api>);
    expect(text($("[data-k=no-accounts]"))).toBe(USAGE_PAGE_WORDS.noAccounts);
  });
});

describe("Usage: used", () => {
  it("reads a week by agent first, and each segment asks again for its range and split", async () => {
    const { asks } = await mount();
    expect(asks.used).toEqual([["week", "agent"]]);
    fireEvent.click($("[data-k=usage-range] [data-segment=month]")!);
    await settle();
    fireEvent.click($("[data-k=usage-split] [data-segment=project]")!);
    await settle();
    expect(asks.used).toEqual([
      ["week", "agent"],
      ["month", "agent"],
      ["month", "project"],
    ]);
    expect($("[data-k=usage-range] [data-segment=month]")!.getAttribute("aria-checked")).toBe("true");
    expect(text($("[data-k=used-head] [data-k=split-head]"))).toBe("Project");
  });

  it("draws one row per split value with in, out and cached, the price with its word, and outside wsp as the note", async () => {
    await mount();
    const claude = $("[data-used-row=claude]")!;
    expect([...claude.querySelectorAll("[data-k=in], [data-k=out], [data-k=cached]")].map(el => el.textContent)).toEqual(["1.2M", "48k", "9M"]);
    expect(text(claude.querySelector("[data-k=price]"))).toBe("$4.20");
    expect(text(claude.querySelector("[data-k=price-word]"))).toBe(USAGE_WORDS.listPrice);
    expect(claude.querySelector("[data-k=note]")).toBeNull();
    const codex = $("[data-used-row=codex]")!;
    expect(codex.querySelector("[data-k=price]")).toBeNull();
    expect(text(codex.querySelector("[data-k=price-word]"))).toBe(USAGE_WORDS.notPriced);
    expect(text(codex.querySelector("[data-k=note]"))).toBe(USAGE_WORDS.outsideWsp);
  });

  it("draws the tokens as one line with a tick per day, and nothing used as its sentence in the chart's place", async () => {
    await mount();
    const chart = $("[data-usage-chart=tokens]")!;
    expect(chart.querySelectorAll("[data-chart-line]").length).toBe(1);
    expect(chart.querySelectorAll("[data-k=tick]").length).toBe(7);
    document.body.innerHTML = "";
    resetSettings();
    useStore.setState({ places: [here] });
    await mount({ usageUsed: async (range: UsageRange, split: UsageSplit) => used(range, split, false) } as Partial<Api>);
    expect($("[data-usage-chart=tokens] svg")).toBeNull();
    expect(text($("[data-usage-chart=tokens]"))).toBe(USAGE_WORDS.noUse);
    expect($$("[data-used-row]")).toEqual([]);
  });
});

describe("Usage: computers", () => {
  it("reads each computer over the range, not a cloud, and draws CPU, memory and disk with the last value, a gap splitting the line", async () => {
    const { asks } = await mount();
    expect(asks.readings.map(([id]) => id).sort()).toEqual(["here", "p_spoo"]);
    const row = $("[data-usage-computer=here]")!;
    expect(text(row.querySelector("[data-k=label]"))).toBe("zingzy's MacBook Pro");
    expect(text(row.querySelector("[data-k=note]"))).toBe("10 cores32 GB");
    expect([...row.querySelectorAll<HTMLElement>("[data-reading]")].map(c => [c.dataset["reading"], text(c.querySelector("[data-k=last]"))])).toEqual([
      ["cpu", "42%"],
      ["mem", "25%"],
      ["disk", "25%"],
    ]);
    expect(row.querySelectorAll("[data-reading=cpu] [data-chart-line]").length).toBe(2);
    const idle = $("[data-usage-computer=p_spoo]")!;
    expect(idle.querySelector("[data-reading]")).toBeNull();
    expect(text(idle.querySelector("[data-k=no-readings]"))).toBe(USAGE_WORDS.noReadings);
    expect($("[data-usage-computer=solari]")).toBeNull();
  });

  it("a computer whose readings were refused reads as no readings, and the range asks each again", async () => {
    const { asks } = await mount({
      placesReadings: async (placeId: string, range: UsageRange) => {
        asks.readings.push([placeId, range]);
        if (placeId === "p_spoo") throw new Error("spoo is away");
        return readingsOf(placeId);
      },
    } as Partial<Api>);
    expect(text($("[data-usage-computer=p_spoo] [data-k=no-readings]"))).toBe(USAGE_WORDS.noReadings);
    fireEvent.click($("[data-k=usage-range] [data-segment=day]")!);
    await settle();
    expect(asks.readings.filter(([, range]) => range === "day").map(([id]) => id).sort()).toEqual(["here", "p_spoo"]);
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
