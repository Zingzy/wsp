// SPDX-License-Identifier: AGPL-3.0-only
// The richer kit in the renderer: every new piece and prop draws, the example slate with a history draws its chart,
// the quiz's choices write the pick, and every icon a slate may name has its component.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseSlate, slateStartValues, SLATE_EXAMPLES, SLATE_ICONS, SLATE_PIECES, type SlateDoc, type SlateJson } from "@wsp/protocol";
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

  it("draws the example: heading, three numbers with icons, an inset section, a status, a chip, a ring and a chart from a history", () => {
    const doc = example("a live figure with an hour of history");
    const { view } = draw(doc, { hist: HIST, spot: { state: "done", exit: 0, json: { price: 2399 }, runs: 3 } });
    const c = view.container;
    expect(c.querySelector("[data-slate-failed]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Gold" }).getAttribute("aria-level")).toBe("2");
    const grid = c.querySelector<HTMLElement>("[data-columns]")!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("@min-[360px]:grid-cols-3");
    expect(grid.querySelectorAll("[data-slate-type=number]")).toHaveLength(3);
    expect(within(grid).getByText("Per ounce")).toBeTruthy();
    expect(grid.textContent).toContain("$2,399.00");
    expect(grid.querySelector("[data-slate-sparkline] polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
    for (const name of ["gauge", "zap", "arrow-down", "arrow-up", "activity", "clock"]) expect(c.querySelector(`[data-slate-icon="${name}"] , svg[data-slate-icon="${name}"]`), name).not.toBeNull();
    const section = c.querySelector<HTMLElement>("[data-slate-section]")!;
    expect(section.querySelector(".bg-card\\/40")).not.toBeNull();
    expect(section.querySelector(".px-4")).not.toBeNull();
    expect(c.querySelector("[data-slate-status=good]")!.textContent).toBe("Live");
    expect(c.querySelector("[data-chip]")!.textContent).toBe("every minute");
    expect(screen.getByRole("meter", { name: "Last hour" }).getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByRole("meter", { name: "Last hour" }).textContent).toContain("3/60");
    const chart = c.querySelector<HTMLElement>("[data-slate-chart]")!;
    expect(chart.querySelector("figcaption")!.textContent).toBe("Per ounce, last hour");
    expect(chart.querySelector("svg[role=img] polyline")!.getAttribute("points")!.split(" ")).toHaveLength(3);
    expect(chart.querySelector("[data-k=y-axis]")!.textContent).toContain("$");
  });

  it("says not read yet before the history has two points", () => {
    const { view } = draw(example("a live figure with an hour of history"));
    expect(view.container.querySelector("[data-slate-chart]")!.textContent).toContain("not read yet");
    expect(view.container.querySelector("[data-slate-status=muted]")!.textContent).toBe("Waiting");
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
    const doc = compiled(`<slate><column><section id="s" title="A" align="center" pad="loose"><text>x</text></section><section id="plain" title="B"><text>y</text></section><column id="inset" surface="inset"><text>z</text></column><grid id="g" columns={2} align="end"><text>1</text><text>2</text></grid></column></slate>`);
    const c = draw(doc).view.container;
    const inner = (id: string) => piece(c, id).querySelector<HTMLElement>("[data-slate-section] > div:last-child, [data-slate-grid] > div")!;
    expect(inner("s").className).toContain("items-center");
    expect(inner("s").className).toContain("px-5");
    expect(inner("plain").className).not.toMatch(/items-|px-|bg-card/);
    expect(piece(c, "inset").firstElementChild!.className).toContain("bg-card/40");
    expect(piece(c, "inset").firstElementChild!.className).toContain("px-4");
    expect(inner("g").className).toContain("justify-items-end");
    expect(c.querySelector("[data-slate-piece=s]")!.textContent).toContain("A");
  });

  it("draws bars, a status, a chip with its icon, and an icon on a button, text, a fact and a section title", () => {
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
    expect(c.querySelector("[data-chip] [data-slate-icon=git-branch]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Go" }).querySelector("[data-slate-icon=play]")).not.toBeNull();
    expect(c.querySelector("[data-slate-type=text] [data-slate-icon=clock]")).not.toBeNull();
    expect(c.querySelector("[data-slate-type=facts] [data-slate-icon=git-branch]")).not.toBeNull();
    expect(c.querySelector("[data-slate-section] [data-slate-icon=activity]")).not.toBeNull();
  });
});
