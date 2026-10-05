// SPDX-License-Identifier: AGPL-3.0-only
// The richer kit in the renderer: every new piece and prop draws, the example slate with a history draws its chart,
// the quiz's choices write the pick, and every icon a slate may name has its component.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseSlate, slateChartAxis, slateStartValues, SLATE_EXAMPLES, SLATE_ICONS, SLATE_PIECES, type SlateDoc, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SLATE_ICON_VIEWS } from "./pieces/icon";
import { SlateView } from "./SlateView";
import { fakeLink, manualScheduler } from "./testing";

afterEach(cleanup);

function compiled(text: string): SlateDoc {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
}

function draw(doc: SlateDoc, state: Record<string, SlateJson> = {}) {
  const scheduler = manualScheduler();
  const engine = new SlateEngine("t1", () => undefined, scheduler);
  engine.setRecord(doc, { ...slateStartValues(doc), ...state }, 3, 3);
  const link = fakeLink();
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  return { engine, link, view, frame: () => act(() => scheduler.run()) };
}

const example = (title: string): SlateDoc => compiled(SLATE_EXAMPLES.find(e => e.title === title)!.text);
const piece = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-slate-piece="${id}"]`)!;
const HIST = [{ at: 1_759_000_000_000, v: 2400.5 }, { at: 1_759_000_060_000, v: 2401.25 }, { at: 1_759_000_120_000, v: 2399 }];

describe("the richer kit in the renderer", () => {
  it("has a component for every icon a slate may name", () => {
    expect(Object.keys(SLATE_ICON_VIEWS).sort()).toEqual([...SLATE_ICONS].sort());
  });

  it("draws the example: heading, a stat strip of three numbers, a section card, a status, a chip, a ring and a chart from a history", () => {
    const doc = example("a live figure with an hour of history");
    const { view } = draw(doc, { hist: HIST, spot: { state: "done", exit: 0, json: { price: 2399 }, runs: 3 } });
    const c = view.container;
    expect(c.querySelector("[data-slate-failed]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Gold" }).getAttribute("aria-level")).toBe("2");
    const grid = c.querySelector<HTMLElement>("[data-slate-strip] > div")!;
    // A strip of numbers stacks its cells until two 26 px figures fit side by side.
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("@min-[34rem]:grid-cols-3");
    expect(grid.querySelectorAll("[data-slate-type=number]")).toHaveLength(3);
    expect(within(grid).getByText("Per ounce")).toBeTruthy();
    expect(grid.textContent).toContain("$2,399.00");
    // A number's trend is a sparkline's job; the stat cell draws its figure alone.
    expect(grid.querySelector("[data-slate-sparkline]")).toBeNull();
    // A head, a figure's label and a tag draw no icon: wsp draws icons in buttons and glyph frames only.
    for (const name of ["gauge", "zap", "arrow-down", "arrow-up", "activity", "clock"]) expect(c.querySelector(`[data-slate-icon="${name}"]`), name).toBeNull();
    expect(c.querySelector("[data-slate-strip]")).not.toBeNull();
    const section = c.querySelector<HTMLElement>("[data-slate-section]")!;
    expect(section.querySelector("[data-slate-card]")!.className).toContain("bg-card/40");
    expect(c.querySelector("[data-slate-status=good]")!.textContent).toBe("Live");
    expect(c.querySelector("[data-slate-chip]")!.textContent).toBe("every minute");
    expect(screen.getByRole("meter", { name: "Last hour" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByRole("meter", { name: "Last hour" }).textContent).toContain("3/60");
    const chart = c.querySelector<HTMLElement>("[data-slate-chart]")!;
    expect(chart.querySelector("figcaption")!.textContent).toBe("Per ouncelast hour");
    expect(chart.querySelector("svg[role=img] polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
    expect(chart.querySelector("[data-k=y-axis]")!.textContent).toContain("$");
  });

  it("says not read yet before the history has two points", () => {
    const { view } = draw(example("a live figure with an hour of history"));
    expect(view.container.querySelector("[data-slate-chart]")!.textContent).toContain("Not read yet");
    expect(view.container.querySelector("[data-slate-status=muted]")!.textContent).toBe("Waiting");
  });

  describe("the chart's axis", () => {
    const GOLD = `<slate><value name="hist" start={[]} /><column><chart label="Spot gold" items={$hist} x={item.at} value={item.v} format="usd" /></column></slate>`;
    const ticks = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>("[data-k=y-axis] > span.absolute")].map(t => t.textContent ?? "");
    const at = (v: number, i: number) => ({ at: 1_759_000_000_000 + i * 60_000, v });

    // A series that holds one value draws no plot: the legend's line says the value, and the plot returns once it moves.
    for (const [name, hist] of [
      ["flat data", [4141.8, 4141.8, 4141.8].map(at)],
      ["two equal points", [4141.8, 4141.8].map(at)],
    ] as const) {
      it(`collapses ${name} to the legend's line, steady at the value`, () => {
        const { view } = draw(compiled(GOLD), { hist: [...hist] });
        const chart = view.container.querySelector("[data-slate-chart]")!;
        expect(chart.querySelector("[data-usage-chart]")).toBeNull();
        expect(chart.querySelector("[data-slate-chart-flat]")!.textContent).toBe("steady at $4,141.80");
      });
    }

    it("draws the plot for one sample, from the first read on, with its axis and its time", () => {
      const { view } = draw(compiled(GOLD), { hist: [at(4141.8, 0)] });
      const chart = view.container.querySelector("[data-slate-chart]")!;
      expect(chart.querySelector("[data-slate-chart-flat]")).toBeNull();
      expect(chart.querySelector("[data-usage-chart] svg[role=img] polyline")).not.toBeNull();
      expect(ticks(view.container).length).toBeGreaterThan(1);
      expect(chart.querySelectorAll("[data-k=tick]")).toHaveLength(1);
    });

    it("draws the plot with its round axis once the value moves", () => {
      const { view } = draw(compiled(GOLD), { hist: [4141.8, 4160, 4141.8].map(at) });
      expect(ticks(view.container)).toEqual(["$4,140.00", "$4,145.00", "$4,150.00", "$4,155.00", "$4,160.00"]);
      expect(view.container.querySelector("[data-slate-chart-flat]")).toBeNull();
      expect(view.container.querySelector("[data-k=y-axis] [role=img], [data-k=y-axis] .digit-strip")).toBeNull();
    });

    it("says its unit once, in the legend and the hover, never on every figure of the axis", () => {
      const RATE = `<slate><value name="hist" start={[]} /><column><chart label="Requests" items={$hist} x={item.at} value={item.v} unit="req/min" format="integer" /></column></slate>`;
      const { view } = draw(compiled(RATE), { hist: [120, 400, 250].map(at) });
      const chart = view.container.querySelector<HTMLElement>("[data-slate-chart]")!;
      expect(chart.querySelector("figcaption")!.textContent).toBe("Requestsreq/min");
      expect(ticks(view.container)).toEqual(["0", "100", "200", "300", "400"]);
      expect(chart.querySelector("[data-k=y-axis]")!.textContent).not.toContain("req/min");
    });

    it("holds every value in four or five round steps", () => {
      for (const values of [[2400.5, 2401.25, 2399], [4141.8, 4141.8], [0, 0], [-5, -5], [3, 1000], [0.001, 0.0012], [-40, 25], [99.9, 100.1]]) {
        const { from, to, parts } = slateChartAxis(values);
        expect(from, String(values)).toBeLessThanOrEqual(Math.min(...values));
        expect(to, String(values)).toBeGreaterThanOrEqual(Math.max(...values));
        expect(to, String(values)).toBeGreaterThan(from);
        expect([4, 5]).toContain(parts);
        const step = (to - from) / parts;
        const lead = step / 10 ** Math.floor(Math.log10(step));
        expect([1, 2, 2.5, 5].some(m => Math.abs(lead - m) < 1e-9), `${values}: step ${step}`).toBe(true);
        expect(Math.abs(from / step - Math.round(from / step)), `${values}: from ${from}`).toBeLessThan(1e-9);
      }
    });

    it("takes five steps when four would leave the top half empty", () => {
      expect(slateChartAxis([210, 435, 260])).toEqual({ from: 0, to: 500, parts: 5 });
      expect(slateChartAxis([0, 790])).toEqual({ from: 0, to: 800, parts: 4 });
    });
  });

  it("never wraps a figure: 524 MB stays on one line, and a long command wraps rather than being cut", () => {
    const doc = compiled(`<slate><value name="procs" start={[{ name: "node server", pid: 4120, mem: 524, cmd: "node /usr/local/lib/node_modules/some/long/path/server.js --port 3000" }]} /><column>
      <table items={$procs}>
        <col title="Name" value={item.name} />
        <col title="PID" value={item.pid} />
        <col title="Memory" value={\`\${item.mem} MB\`} />
        <col title="Command" value={item.cmd} mono />
      </table>
    </column></slate>`);
    const { view } = draw(doc);
    const cells = [...view.container.querySelectorAll<HTMLElement>("[role=cell]")];
    const heads = [...view.container.querySelectorAll<HTMLElement>("[role=columnheader]")];
    expect(cells.map(c => c.textContent)).toEqual(["node server", "4120", "524 MB", "node /usr/local/lib/node_modules/some/long/path/server.js --port 3000"]);
    expect(cells.map(c => c.classList.contains("whitespace-nowrap"))).toEqual([false, true, true, false]);
    expect(heads.map(c => c.classList.contains("whitespace-nowrap"))).toEqual([false, true, true, false]);
    expect(cells[2]!.className).toContain("font-mono");
    expect(cells[2]!.className).toContain("text-right");
    expect(cells[3]!.className).toContain("font-mono");
    expect(cells[3]!.className).toContain("break-all");
    expect(view.container.querySelector("[data-k=clip]")).toBeNull();
  });

  it("writes a pick from choices and marks the answer once picked", async () => {
    const doc = example("a quiz that logs each answer");
    const { view, link, engine } = draw(doc);
    const options = within(piece(view.container, "answer")).getAllByRole("radio");
    expect(options.map(o => o.textContent)).toEqual(["Link", "Network", "Transport"]);
    await act(async () => fireEvent.click(options[0]!));
    expect(link.writeState).toHaveBeenCalled();
    expect(JSON.stringify((link.writeState as unknown as { mock: { calls: unknown[][] } }).mock.calls[0])).toContain("Link");
    cleanup();
    const after = draw(doc, { pick: "Link", log: [{ q: "x", pick: "Link", right: false }] });
    const marked = within(piece(after.view.container, "answer")).getAllByRole("radio");
    expect(marked.map(o => o.getAttribute("data-slate-choice"))).toEqual(["wrong", "right", "open"]);
    expect(marked.every(o => (o as HTMLButtonElement).disabled)).toBe(true);
    expect(after.view.container.textContent).toContain("Question 1 of 2");
    void engine;
  });

  it("draws every new piece's catalog example without a failure", () => {
    const declared = `<value name="hist" start={[1, 2, 3]} /><value name="pick" start={null} /><value name="up" start={true} /><value name="done" start={1} /><value name="steps" start={[1, 2]} /><value name="q" start={{ options: ["a", "b"], answer: "a" }} />`;
    for (const type of ["heading", "grid", "status", "chip", "ring", "chart", "sparkline", "bars", "choices"]) {
      const { view } = draw(compiled(`<slate>${declared}<column>${SLATE_PIECES[type]!.example}</column></slate>`));
      expect(view.container.querySelector(`[data-slate-type="${type}"]`), type).not.toBeNull();
      expect(view.container.querySelector("[data-slate-failed]"), type).toBeNull();
      cleanup();
    }
  });

  it("lines a group up only when align says so, and pads and insets on request", () => {
    const doc = compiled(`<slate><column><section id="s" title="A" align="center" pad="loose"><status>x</status></section><section id="plain" title="B"><status>y</status></section><column id="inset" surface="inset"><status>z</status></column><grid id="g" columns={2} align="end"><text>1</text><text>2</text></grid></column></slate>`);
    const c = draw(doc).view.container;
    const inner = (id: string) => piece(c, id).querySelector<HTMLElement>("[data-slate-card], [data-slate-grid] > div")!;
    // A section's rows are a settings card whatever align, pad or surface it names: its rows take the card's inset.
    expect(inner("s").className).toContain("[&>:not([data-slate-rows])]:px-(--settings-inset,20px)");
    expect(inner("s").className).not.toMatch(/items-center|px-5/);
    expect(inner("plain").className).toContain("bg-card/40");
    // A column standing among the cards takes no surface of its own: its status is a row of a card like any other.
    expect(piece(c, "inset").querySelector("[data-slate-card]")).not.toBeNull();
    expect(inner("g").className).toContain("justify-items-end");
    expect(c.querySelector("[data-slate-piece=s]")!.textContent).toContain("A");
  });

  it("stands prose bare under its section head, plain, toned or mono, while a meta line still joins the card above it", () => {
    const doc = compiled(`<slate><column>
      <section id="prose" title="Feed"><text id="plain">Prices refresh every 60 seconds</text><text id="warn" tone="warning">Awaiting approval</text><text id="mono" mono>true</text></section>
      <section id="rows" title="Now"><status id="up" tone="good">Up</status><text id="meta" tone="muted">checked 21s ago</text></section>
    </column></slate>`);
    const c = draw(doc).view.container;
    for (const id of ["plain", "warn", "mono"]) expect(piece(c, id).closest("[data-slate-card]"), id).toBeNull();
    expect(piece(c, "up").closest("[data-slate-card]")).not.toBeNull();
    expect(piece(c, "meta").closest("[data-slate-card]")).toBe(piece(c, "up").closest("[data-slate-card]"));
  });

  it("sets a facts list's values in one face: mono only when every value is a figure, else sans, unless one asks for mono", () => {
    const doc = compiled(`<slate><column>
      <facts id="mixed"><fact label="Domain" value="spoo.me" /><fact label="Expires" value="2026-12-29" /><fact label="Days left" value="85" /><fact label="Checked" value="Tue 29 Dec" /></facts>
      <facts id="figures"><fact label="CPU" value="12%" /><fact label="Memory" value="524 MB" /><fact label="Uptime" value="13s" /></facts>
      <facts id="asked"><fact label="Path" value="/usr/local/bin" mono /><fact label="Days left" value="85" /></facts>
    </column></slate>`);
    const c = draw(doc).view.container;
    const faces = (id: string) => [...piece(c, id).querySelectorAll("[data-settings-word]")].map(w => w.className.includes("font-mono"));
    expect(faces("mixed")).toEqual([false, false, false, false]);
    expect(faces("figures")).toEqual([true, true, true]);
    expect(faces("asked")).toEqual([true, false]);
  });

  it("draws bars, a status word with no dot, a chip as plain words, and no icon on a button, a text, a fact or a section head", () => {
    const doc = compiled(`<slate><value name="n" start={0} /><column>
      <bars label="Busiest" items={[{ n: 'web', v: 4 }, { n: 'host', v: 2 }]} name={item.n} value={item.v} />
      <status tone="bad">Down</status>
      <chip icon="git-branch">main</chip>
      <button label="Go" icon="play" onPress={set($n, 1)} />
      <text icon="clock">Every minute</text>
      <facts><fact label="Branch" value="main" icon="git-branch" /></facts>
      <section title="Feed" icon="activity"><text>x</text></section>
    </column></slate>`);
    const c = draw(doc).view.container;
    expect([...c.querySelectorAll("[data-slate-bar]")].map(b => b.textContent)).toEqual(["web4", "host2"]);
    expect(c.querySelector("[data-slate-status=bad]")!.textContent).toBe("Down");
    expect(c.querySelector("[data-slate-status=bad]")!.querySelector(".rounded-full")).toBeNull();
    expect(c.querySelector("[data-slate-chip]")!.textContent).toBe("main");
    expect(c.querySelector("[data-slate-chip] [data-slate-icon]")).toBeNull();
    expect(screen.getByRole("button", { name: "Go" }).querySelector("[data-slate-icon]")).toBeNull();
    expect(c.querySelector("[data-slate-type=text] [data-slate-icon]")).toBeNull();
    expect(c.querySelector("[data-slate-type=facts] [data-slate-icon]")).toBeNull();
    expect(c.querySelector("[data-slate-section] [data-slate-icon=activity]")).toBeNull();
  });
});
