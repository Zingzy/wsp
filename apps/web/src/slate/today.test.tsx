// SPDX-License-Identifier: AGPL-3.0-only
// The owner's three slates of 2026-10-03 drawn from fixture documents in the locked settings grammar: heads with their
// meta and refresh glyph, soft cards with hairlined rows, the stat cell, the chart under its head, lists with their
// header over the card, and state as a word.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { GOLD_TEXT, GOLD_VALUES, INBOX_TEXT, INBOX_VALUES, QUIZ_TEXT, SPOO_TEXT, SPOO_VALUES, todaySlate } from "./fixtures/today";
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
    // His V3: the karat rates and the zones are lookups, bare on hairlines with no card.
    const lookups = [...c.querySelectorAll<HTMLElement>("[role=table]")];
    expect(lookups).toHaveLength(2);
    expect(lookups.every(t => t.hasAttribute("data-slate-bare-table") && t.querySelector(".bg-card\\/40") === null)).toBe(true);
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

  it("sizes a chart's axis gutter to its widest figure, beside the plot and never over it", () => {
    const c = draw(`<slate><value name="h" start={[{ t: "21:48", v: 4141.8 }, { t: "22:47", v: 4200 }]} /><column>
<chart label="Spot, last hour" items={$h} x={item.t} value={item.v} format="usd" /></column></slate>`);
    const chart = c.querySelector<HTMLElement>("[data-usage-chart]")!;
    expect(chart.className).toContain("grid-cols-[auto_minmax(0,1fr)]");
    const axis = chart.querySelector<HTMLElement>("[data-k=y-axis]")!;
    expect(axis.parentElement).toBe(chart);
    expect(axis.querySelector("svg[role=img]")).toBeNull();
    expect(axis.className).toContain("text-[11px]");
    const labels = [...axis.querySelectorAll("[data-k=y-tick]")].map(tick => tick.textContent);
    expect(labels).toEqual(["$4,140.00", "$4,160.00", "$4,180.00", "$4,200.00", "$4,220.00"]);
  });
});

describe("the spoo live traffic slate", () => {
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-slate-strip]")!;

  it("splits six numbers into equal cells, three across at 400 and as many as their figures fit once widened", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    // Six figures of up to five 26 px characters: three across at 400, and still three at 640, since six need 612 px.
    expect(strip(c).getAttribute("data-across")).toBe("3 3");
    const cells = strip(c).querySelector<HTMLElement>(":scope > div")!;
    expect(cells.children).toHaveLength(6);
    expect(cells.className).toContain("@max-[34rem]:grid-cols-3");
    expect(cells.className).toContain("@max-[34rem]:[&>*:not(:nth-child(3n+1))]:border-l");
    expect(cells.className).toContain("@max-[34rem]:[&>*:nth-child(n+4)]:border-t");
    expect(cells.className).toContain("@min-[34rem]:grid-cols-3");
    // The agent's columns={3} decides nothing; small figures stand six across once widened.
    const small = draw(SPOO_TEXT.replace(/value=\{\d+(\.\d+)?\}/g, "value={7}"), SPOO_VALUES);
    expect(strip(small).getAttribute("data-across")).toBe("3 6");
  });

  it("sets a unit at 12 px muted on the figure's baseline", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    const unit = [...c.querySelectorAll<HTMLElement>("[data-slate-unit]")].find(u => u.textContent === "ms")!;
    expect(unit.className).toContain("text-xs");
    expect(unit.className).toContain("text-muted-foreground");
    expect(unit.parentElement!.className).toContain("items-baseline");
  });

  it("puts the request log's header cells on the rows' own tracks and sizes each machine column to its widest value", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    const t = c.querySelector<HTMLElement>("[role=table]")!;
    const edge = "calc(var(--settings-inset,20px) + 1px - 12px)";
    // time, method and cc fit their widest value; path, the widest machine text, takes the room left and wraps.
    expect(t.style.gridTemplateColumns).toBe(`${edge} minmax(8ch,max-content) minmax(6ch,max-content) minmax(0,1fr) minmax(6ch,max-content) minmax(2ch,max-content) minmax(2ch,max-content) ${edge}`);
    const head = t.querySelector("[data-slate-head]")!;
    const rows = [...t.querySelectorAll("[data-slate-head] + div [role=row]")];
    expect(rows).toHaveLength(4);
    // Every row lays its children on the same tracks as the header, padding none of its own.
    for (const row of rows) {
      expect(row.children).toHaveLength(head.children.length);
      expect(row.className).not.toMatch(/\bpx-/);
    }
    expect(head.className).not.toMatch(/\bp[lrx]-/);
    expect([...head.querySelectorAll("[role=columnheader]")].map(h => h.textContent)).toEqual(["Time", "Method", "Path", "Status", "ms", "cc"]);
    const first = [...rows[0]!.querySelectorAll<HTMLElement>("[role=cell]")];
    expect(first.map(cell => cell.textContent)).toEqual(["18:52:24", "POST", "/api/v1/shorten", "200", "84", "IN"]);
    expect(first[0]!.className).toContain("whitespace-nowrap");
    expect(first[2]!.className).toContain("break-all");
    // Option A's 12 px between a log's columns.
    expect(t.className).toContain("gap-x-3");
  });
});

describe("the strip follows the content, and whole numbers label whole ticks", () => {
  const six = (open: string, close: string) => `<slate title="spoo live traffic"><column>
    <section title="Last five minutes" note="checked 4s">
      ${open}
        <number id="req" label="Requests" value={6118} format="integer" />
        <number label="Per minute" value={1224} format="integer" />
        <number id="err" label="Errors" value={0.4} unit="%" /><status id="err-state" tone="good">ok</status><text id="err-note">under the 1% line</text>
        <number label="p50" value={82} unit="ms" />
        <number label="p95" value={310} unit="ms" />
        <number label="Cache hit" value={91} unit="%" />
      ${close}
    </section>
  </column></slate>`;

  for (const [name, open, close] of [
    ["a row", `<row gap="normal" wrap>`, `</row>`],
    ["a column", `<column>`, `</column>`],
  ]) {
    it(`draws six numbers in ${name} as the stat strip, three across at 400, a status riding its number's note`, () => {
      const c = draw(six(open!, close!));
      const strip = c.querySelector<HTMLElement>("[data-slate-strip]")!;
      expect(strip.getAttribute("data-across")).toBe("3 3");
      const cells = strip.querySelector<HTMLElement>(":scope > div")!;
      expect([...cells.children].map(cell => cell.getAttribute("data-slate-piece"))).toHaveLength(6);
      expect(cells.className).toContain("@max-[34rem]:grid-cols-3");
      expect(cells.className).toContain("@max-[34rem]:[&>*:not(:nth-child(3n+1))]:border-l");
      expect(cells.className).toContain("@max-[34rem]:[&>*:nth-child(n+4)]:border-t");
      // The holder fills its card row, so the strip's own cells carry the padding.
      expect(strip.closest("[data-slate-rows]")).not.toBeNull();
      const note = c.querySelector('[data-slate-piece="err"] [data-slate-status]')!.parentElement!;
      expect([...note.children].map(part => part.textContent)).toEqual(["Ok", "under the 1% line"]);
      expect(c.querySelector('[data-slate-piece="err-state"]')).toBeNull();
      const unit = [...c.querySelectorAll<HTMLElement>("[data-slate-unit]")].find(u => u.textContent === "ms")!;
      expect(unit.className).toContain("text-xs");
      expect(unit.parentElement!.className).toContain("items-baseline");
    });
  }

  const ticks = (values: number[], format: string) => {
    const items = JSON.stringify(values.map((v, i) => ({ t: `18:${String(50 + i).padStart(2, "0")}`, v })));
    const c = draw(`<slate><value name="h" start={${items}} /><column><chart label="Errors" items={$h} x={item.t} value={item.v} format="${format}" /></column></slate>`);
    return [...c.querySelectorAll("[data-k=y-tick]")].map(tick => tick.textContent);
  };

  it("labels an integer chart over 0 to 1 with 0 and 1 alone", () => {
    expect(ticks([0, 1, 1, 0, 1], "integer")).toEqual(["0", "1"]);
  });

  it("labels an integer chart over 0 to 3 with distinct whole numbers", () => {
    const labels = ticks([0, 3, 1, 2, 3], "integer");
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every(label => /^\d+$/.test(label!))).toBe(true);
    expect(labels[0]).toBe("0");
    expect(Number(labels.at(-1))).toBeGreaterThanOrEqual(3);
  });

  it("keeps four parts for figures that are not whole numbers", () => {
    expect(ticks([0, 1, 1, 0, 1], "plain")).toHaveLength(5);
  });
});

describe("a series that holds one value", () => {
  const fivexx = (values: number[]) => {
    const items = JSON.stringify(values.map((v, i) => ({ t: `18:${String(10 + i).padStart(2, "0")}`, v })));
    return draw(`<slate><value name="h" start={${items}} /><column><section title="Errors"><chart label="5xx, per minute, last hour" items={$h} x={item.t} value={item.v} format="integer" /></section></column></slate>`);
  };

  it("draws a 5xx count flat at 0 as one quiet line in the legend's place, and the plot once it moves", () => {
    const flat = fivexx(Array.from({ length: 60 }, () => 0));
    const chart = flat.querySelector("[data-slate-chart]")!;
    expect(chart.querySelector("[data-usage-chart]")).toBeNull();
    expect(chart.querySelector("figcaption")!.textContent).toBe("5xxper minute, last hoursteady at 0");
    cleanup();
    const moved = fivexx([...Array.from({ length: 59 }, () => 0), 2]);
    expect(moved.querySelector("[data-slate-chart] [data-usage-chart]")).not.toBeNull();
    expect(moved.querySelector("[data-slate-chart-flat]")).toBeNull();
  });
});

describe("the owner's picks of 2026-10-05", () => {
  function engineOf(text: string, values: Record<string, SlateJson> = {}) {
    const { doc, values: start } = todaySlate(text, values);
    const engine = new SlateEngine("t1", () => undefined, manualScheduler());
    engine.setRecord(doc, start, 3, 3);
    const link = fakeLink();
    const ui = <SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />;
    return { engine, ui };
  }

  it("cards the stat strip, the request log and the bar lists, and stands every other group bare on hairlines (V3)", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    expect(c.querySelector("[data-slate-strip]")!.closest("[data-slate-card]")).not.toBeNull();
    // The request log has six columns: a log of records takes the card.
    expect(c.querySelector("[data-slate-head] + div")!.className).toContain("bg-card/40");
    expect(c.querySelector("[data-slate-bar-switch] > div:last-child")!.className).toContain("bg-card/40");
    const quiz = draw(QUIZ_TEXT);
    // The question is acted on and keeps its card; the context's meter and facts are words on hairlines.
    expect(quiz.querySelector("[role=radiogroup]")!.closest("[data-slate-card]")).not.toBeNull();
    const meter = quiz.querySelector('[role=meter][aria-label="Window used"]')!;
    expect(meter.closest("[data-slate-card]")).toBeNull();
    expect(meter.closest("[data-slate-bare]")!.className).toContain("border-y");
  });

  it("switches the bar lists in one card, every list kept in its one cell, the pick held across a push and a redraw", () => {
    const { engine, ui } = engineOf(SPOO_TEXT, SPOO_VALUES);
    const view = render(ui);
    const lists = () => [...view.container.querySelectorAll<HTMLElement>("[data-slate-bar-list]")];
    expect(view.container.querySelectorAll("[data-slate-bar-switch]")).toHaveLength(1);
    // Five lists in two grids, as the agent wrote them, make one switch; the window every name shares is said once.
    expect([...view.container.querySelectorAll("[data-slate-bar-switch] [data-segment]")].map(s => s.textContent)).toEqual(["Countries", "Status codes", "Route class", "Top short links", "Events"]);
    expect(view.container.querySelector("[data-slate-bar-switch-note]")!.textContent).toBe("15m");
    // Every list stays mounted in the card's one grid cell; the others are invisible, never removed, so the card is the
    // tallest list's height.
    expect(lists().every(list => list.className.includes("col-start-1") && list.className.includes("row-start-1"))).toBe(true);
    expect(lists().map(list => list.className.includes("invisible"))).toEqual([false, true, true, true, true]);
    act(() => fireEvent.click(view.container.querySelector('[data-segment="codes"]')!));
    expect(lists().map(list => list.className.includes("invisible"))).toEqual([true, false, true, true, true]);
    act(() => engine.applyValues({ $codes: [{ n: "302", v: 3100 }] }, 9));
    expect(lists().map(list => list.className.includes("invisible"))).toEqual([true, false, true, true, true]);
    view.unmount();
    const again = render(ui);
    expect([...again.container.querySelectorAll<HTMLElement>("[data-slate-bar-list]")].map(list => list.className.includes("invisible"))).toEqual([true, false, true, true, true]);
  });

  it("stands the request log's header words 8 px over the card on the rows' own tracks", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    const head = c.querySelector<HTMLElement>("[data-slate-head]")!;
    expect(head.className).toContain("items-end");
    expect(head.className).toContain("pb-1.5");
    expect(head.querySelector("[role=columnheader]")!.className).toContain("min-h-0");
  });

  it("pads three stat cells a row at 12 px, 10 below, and spaces a section's pieces 16 px under a 12 px head", () => {
    const c = draw(SPOO_TEXT, SPOO_VALUES);
    const cells = c.querySelector<HTMLElement>("[data-slate-strip] > div")!;
    expect(cells.className).toContain("@max-[34rem]:[&>*]:pt-3");
    expect(cells.className).toContain("@max-[34rem]:[&>*]:pb-2.5");
    const section = c.querySelector<HTMLElement>("[data-slate-section]")!;
    expect(section.className).toContain("gap-3");
    expect(section.children[1]!.className).toContain("gap-4");
    expect(c.querySelector<HTMLElement>("[data-slate-group]")!.className).toContain("[&>[data-slate-type=section]:not(:first-child)]:mt-4");
  });
});

describe("the live spoo slate as its agent wrote it", () => {
  // The shape of reach check's document of 2026-10-05: bar lists held in grids, labels with their window, and a
  // request log of six columns whose only word column is the two-letter country.
  const bar = (id: string, label: string) => `<bars id="${id}" label="${label}" items={$l} name={item.n} value={item.v} />`;
  const doc = (lists: string) => `<slate title="spoo live traffic"><value name="l" start={[{ n: "CA", v: 909 }, { n: "US", v: 668 }]} />
<value name="recent" start={[{ t: "20:32:49", m: "POST", p: "/api/v1/shorten", s: 429, ms: 12, cc: "CA" }]} />
<column gap="normal">${lists}
<section title="Non-redirect and error requests (5m)"><table id="log" items={$recent} rows={15}>
  <col title="time" value={item.t} mono /><col title="method" value={item.m} mono /><col title="path" value={item.p} mono />
  <col title="status" value={item.s} /><col title="ms" value={item.ms} align="end" /><col title="cc" value={item.cc} />
</table></section></column></slate>`;

  it("switches bar lists held in grids, holders one after another sharing one switch, each named by its label", () => {
    const c = draw(doc(`<grid columns={3}>${bar("b1", "Countries (15m)")}${bar("b2", "Status codes (15m)")}${bar("b3", "Route class (15m)")}</grid>
<grid columns={2}>${bar("b4", "Top short links (15m)")}${bar("b5", "Events (15m)")}</grid>`));
    expect(c.querySelectorAll("[data-slate-bar-switch]")).toHaveLength(1);
    expect([...c.querySelectorAll("[data-segment]")].map(s => s.textContent)).toEqual(["Countries", "Status codes", "Route class", "Top short links", "Events"]);
    expect(c.querySelector("[data-slate-bar-switch-note]")!.textContent).toBe("15m");
    // No list stands in a bare column of its own any more.
    expect(c.querySelectorAll("[data-slate-grid]")).toHaveLength(0);
    expect(c.querySelectorAll("[data-slate-bar-list]")).toHaveLength(5);
  });

  // The kit takes a list's name only as label, so a list with no name is an empty label.
  it("gives a holder apart from others its own switch, and a list with no name a numbered one", () => {
    const c = draw(doc(`<grid columns={2}>${bar("b1", "Countries")}${bar("b2", "")}</grid>
<text>between</text>
<row>${bar("b3", "Events")}</row>`));
    const switches = [...c.querySelectorAll("[data-slate-bar-switch]")];
    expect(switches).toHaveLength(2);
    expect([...switches[0]!.querySelectorAll("[data-segment]")].map(s => s.textContent)).toEqual(["Countries", "List 2"]);
    expect([...switches[1]!.querySelectorAll("[data-segment]")].map(s => s.textContent)).toEqual(["Events"]);
    expect(c.querySelector("[data-slate-bar-switch-note]")).toBeNull();
  });

  it("gives the request log's slack to the path, so status, ms and cc end on the card's right inset", () => {
    const c = draw(doc(""));
    const t = c.querySelector<HTMLElement>('[data-slate-piece="log"] [role=table]')!;
    const tracks = t.style.gridTemplateColumns.split(/ (?![^(]*\))/);
    // Edge, time, method, path, status, ms, cc, edge: the path's is the one track that grows.
    expect(tracks).toHaveLength(8);
    expect(tracks[3]).toBe("minmax(0,1fr)");
    expect(tracks.filter(track => track.includes("1fr"))).toHaveLength(1);
    expect(tracks[6]).toBe("fit-content(40%)");
  });
});
