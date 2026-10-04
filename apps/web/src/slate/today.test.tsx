// SPDX-License-Identifier: AGPL-3.0-only
// The owner's three slates of 2026-10-03 drawn from fixture documents in the locked settings grammar: heads with their
// meta and refresh glyph, soft cards with hairlined rows, the stat cell, the chart under its head, lists with their
// header over the card, and state as a word.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { GOLD_TEXT, GOLD_VALUES, INBOX_TEXT, INBOX_VALUES, QUIZ_TEXT, todaySlate } from "./fixtures/today";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";
import { fakeLink, manualScheduler } from "./testing";

afterEach(cleanup);

function draw(text: string, values: Record<string, SlateJson> = {}) {
  const { doc, values: start } = todaySlate(text, values);
  const engine = new SlateEngine("t1", () => undefined, manualScheduler());
  engine.setRecord(doc, start, 3, 3);
  const link = fakeLink();
  const { container } = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  expect(container.querySelector("[data-slate-failed]")).toBeNull();
  return container;
}

const heads = (c: HTMLElement) => [...c.querySelectorAll("[data-slate-section] > :first-child")].map(head => head.textContent);
const cards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-slate-card], [role=table] > div:not([data-slate-head])")];

describe("the gold and traffic slate", () => {
  it("draws three sections, each head with its meta and a refresh glyph that says the cadence", () => {
    const c = draw(GOLD_TEXT, GOLD_VALUES);
    expect(heads(c)).toEqual(["Goldchecked 23s", "Bengaluru retail, per gramchecked 24s", "Cloudflare requestschecked 22s"]);
    expect([...c.querySelectorAll("[data-slate-refresh]")].map(glyph => glyph.getAttribute("title"))).toEqual([
      "Runs every 60 s, only while this slate is on screen",
      "Runs every 30 min, only while this slate is on screen",
      "Runs every 60 s, only while this slate is on screen",
    ]);
    expect(c.querySelector("[data-slate-icon], [data-slate-status] .rounded-full")).toBeNull();
  });

  it("draws the spot price as a stat cell whose note carries the market's state word", () => {
    const c = draw(GOLD_TEXT, GOLD_VALUES);
    const card = cards(c)[0]!;
    expect(card.className).toContain("rounded-xl");
    expect(card.textContent).toBe("Spot, per troy ounce$4,141.80Closedopens Mon 3:30 AM IST");
    expect(card.querySelector(".text-\\[26px\\]")!.textContent).toBe("$4,141.80");
    expect(card.querySelector("[data-slate-status]")!.className).toContain("text-foreground");
  });

  it("draws the karat rates as a list with no header, figures at the right in mono", () => {
    const c = draw(GOLD_TEXT, GOLD_VALUES);
    const rows = [...cards(c)[1]!.querySelectorAll("[role=row]")];
    expect(rows.map(row => row.textContent)).toEqual(["24K₹14,918", "22K₹13,675", "18K₹11,189"]);
    expect(rows[0]!.querySelectorAll("[role=cell]")[1]!.className).toMatch(/font-mono.*text-right|text-right.*font-mono/);
    expect(c.querySelectorAll("[data-slate-head]")).toHaveLength(1);
  });

  it("draws the chart bare under its head with its legend and its foot, then the zones under their header", () => {
    const c = draw(GOLD_TEXT, GOLD_VALUES);
    const chart = c.querySelector("[data-slate-chart]")!;
    expect(chart.closest("[data-slate-card]")).toBeNull();
    expect(chart.querySelector("figcaption")!.textContent).toBe("spoo.merequests a minute, last hour");
    expect(chart.querySelector("[data-line] polyline")!.getAttribute("points")!.split(" ")).toHaveLength(51);
    const foot = c.querySelector('[data-slate-type="chart"] + [data-slate-type="text"] p')!;
    expect(foot.className).toContain("text-xs");
    expect(foot.className).toContain("text-muted-foreground");
    expect(c.querySelector("[data-slate-head]")!.textContent).toBe("ZoneLast hourLatest minute");
    expect([...c.querySelectorAll("[data-slate-head] + div [role=row]")].map(row => row.textContent)).toEqual(["spoo.me59,9611,224", "wakeupba.be832", "pickuptheph.one70", "singhi.me00"]);
  });
});

describe("the networking quiz and the Zoho inbox", () => {
  it("draws the question as the card's first row and the right answer's state word", () => {
    const c = draw(QUIZ_TEXT);
    expect(heads(c)).toEqual(["Question 15 of 156 of 15 right", "Contextthis thread, as of the latest turn", "Gold in BengaluruINR per gram"]);
    const card = cards(c)[0]!;
    expect(card.querySelector("[role=radiogroup] > span")!.textContent).toContain("How many broadcast domains");
    expect(card.querySelector("[data-slate-choice=right]")!.textContent).toBe("2Right");
    expect(c.querySelector('[role=meter][aria-label="Window used"]')!.textContent).toBe("Window used815k free of 1M185k");
  });

  it("draws the mailbox picker and the unread filter in the toolbar and each mail as a row that opens", () => {
    const c = draw(INBOX_TEXT, INBOX_VALUES);
    expect(c.querySelector("[data-slot=segmented-control]")!.textContent).toBe("AllUnread");
    const open = [...c.querySelectorAll("[data-slate-row-open]")];
    expect(open).toHaveLength(8);
    expect(open[0]!.textContent).toBe("Here's a 'dangerously-skip-permissions' macro padPostHogunread2026-10-03 22:21");
  });
});

describe("what the live gold slate wrote", () => {
  const spot = (beside: string) => `<slate title="Gold and traffic">
  <column>
    <section title="Gold" note="checked 23s">
      <row><number id="spot" label="Spot, per troy ounce" value={4141.8} format="usd" />${beside}</row>
    </section>
  </column>
</slate>`;

  for (const [name, beside] of [
    ["a column of a status and a text beside the number", `<column id="market"><status id="state">Closed</status><text id="when" tone="muted">opens Mon 3:30 AM IST</text></column>`],
    ["a status and a text beside the number in its row", `<status id="state">Closed</status><text id="when" tone="muted">opens Mon 3:30 AM IST</text>`],
  ]) {
    it(`draws ${name} as the stat cell's note`, () => {
      const c = draw(spot(beside!));
      const card = cards(c)[0]!;
      expect(card.textContent).toBe("Spot, per troy ounce$4,141.80Closedopens Mon 3:30 AM IST");
      const note = c.querySelector('[data-slate-piece="spot"] [data-slate-status]')!.parentElement!;
      expect([...note.children].map(part => part.textContent)).toEqual(["Closed", "opens Mon 3:30 AM IST"]);
      for (const rider of ["market", "state", "when"]) expect(c.querySelector(`[data-slate-piece="${rider}"]`)?.textContent ?? "").toBe("");
      // The row is the stat cell: it takes no row inset of its own and the cell keeps the strip's padding.
      expect(card.firstElementChild!.hasAttribute("data-slate-rows")).toBe(true);
      expect(c.querySelector('[data-slate-piece="spot"] > div')!.className).toContain("pt-4");
    });
  }

  it("keeps a row whose number stands beside something else as it was written", () => {
    const c = draw(spot(`<button label="Refresh" onPress={send("refresh")} /><status id="state">Closed</status>`));
    expect(c.querySelector('[data-slate-piece="state"]')!.textContent).toBe("Closed");
    expect(c.querySelector('[data-slate-piece="spot"] [data-slate-status]')).toBeNull();
  });

  it("sizes a chart's axis gutter to its widest figure, so a dollar figure keeps its sign", () => {
    const c = draw(`<slate><value name="h" start={[{ t: "21:48", v: 4141.8 }, { t: "22:47", v: 4200 }]} /><column>
<chart label="Spot, last hour" items={$h} x={item.t} value={item.v} format="usd" /></column></slate>`);
    const chart = c.querySelector<HTMLElement>("[data-usage-chart]")!;
    expect(chart.className).toContain("grid-cols-[minmax(40px,max-content)_minmax(0,1fr)]");
    const labels = [...chart.querySelectorAll("[data-k=y-tick]")].map(tick => tick.textContent);
    expect(labels.every(label => label!.startsWith("$"))).toBe(true);
    expect(chart.querySelector("[data-k=y-axis]")!.className).toContain("whitespace-nowrap");
  });
});
