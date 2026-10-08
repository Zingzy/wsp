// SPDX-License-Identifier: AGPL-3.0-only
// The chart kinds in jsdom where their rules do not need a layout: a running span follows the slate's clock, a stack
// turned off wipes its bands, and a treemap draws a zero part and two parts of one name without a broken tile.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slateStartValues, type SlateDoc, type SlateJson } from "@wsp/protocol/slate";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { fakeLink, manualScheduler, slate } from "./testing";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function draw(doc: SlateDoc, values: Record<string, SlateJson>) {
  const scheduler = manualScheduler();
  const engine = new SlateEngine("t1", path => values[path], scheduler);
  engine.setRecord(doc, slateStartValues(doc), 3, 3);
  const link = fakeLink();
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  return { engine, view, frame: () => act(() => scheduler.run()) };
}

const START = Date.parse("2026-10-07T14:00:00Z");

describe("the timeline's clock", () => {
  it("moves a running span's length and its bar's end with time.now when the agent sets no now", () => {
    const values: Record<string, SlateJson> = {
      "time.now": START + 5_000,
      "data.steps": [{ name: "Build", start: new Date(START - 60_000).toISOString(), end: new Date(START).toISOString() }, { name: "Test", start: new Date(START).toISOString() }],
    };
    const doc = slate({ root: "run", pieces: { run: { type: "timeline", props: { label: "CI", items: { bind: "data.steps" }, name: { bind: "item.name" }, start: { bind: "item.start" }, end: { bind: "item.end" } } } } });
    const { engine, view, frame } = draw(doc, values);
    const running = () => view.container.querySelector<HTMLElement>('[data-slate-span="running"]')!;
    const bar = () => running().querySelector<HTMLElement>("[class*=rounded]")!.style.width;
    expect(running().textContent).toContain("Running 5s");
    const before = bar();
    expect(engine.boundPaths()).toContain("time.now");
    values["time.now"] = START + 7_000;
    engine.invalidate(["time.now"]);
    frame();
    expect(running().textContent).toContain("Running 7s");
    expect(bar()).not.toBe(before);
  });

  it("holds no clock when the agent sets now", () => {
    const doc = slate({ root: "run", pieces: { run: { type: "timeline", props: { label: "CI", items: [], name: { bind: "item.name" }, now: 0 } } } });
    expect(draw(doc, {}).engine.boundPaths()).not.toContain("time.now");
  });
});

describe("a stacked chart patched to plain lines", () => {
  it("wipes the bands its canvas painted", () => {
    const clearRect = vi.fn();
    const ctx = new Proxy({ clearRect } as Record<string, unknown>, { get: (target, key) => target[key as string] ?? vi.fn(), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    const chart = (stack: boolean): SlateDoc =>
      slate({ root: "lat", pieces: { lat: { type: "chart", props: { label: "Latency", items: { bind: "data.lat" }, x: { bind: "item.at" }, ...(stack ? { stack: true } : {}), series: [{ label: "p50", value: { bind: "item.p50" } }, { label: "p99", value: { bind: "item.p99" } }] } } } });
    const values = { "data.lat": [{ at: START, p50: 19, p99: 210 }, { at: START + 60_000, p50: 22, p99: 340 }] };
    const { engine, frame } = draw(chart(true), values);
    clearRect.mockClear();
    act(() => engine.setRecord(chart(false), slateStartValues(chart(false)), 4, 4));
    frame();
    expect(clearRect).toHaveBeenCalled();
  });
});

describe("the treemap", () => {
  it("draws a zero part as nothing and two parts of one name in one group as two tiles, with no broken style or key", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly seen: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.seen([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const values = { "data.mods": [{ pkg: "app", name: "index", bytes: 40_000 }, { pkg: "app", name: "index", bytes: 30_000 }, { pkg: "app", name: "empty", bytes: 0 }, { pkg: "lib", name: "core", bytes: 50_000 }] };
    const doc = slate({ root: "b", pieces: { b: { type: "treemap", props: { label: "Bundle", items: { bind: "data.mods" }, name: { bind: "item.name" }, value: { bind: "item.bytes" }, group: { bind: "item.pkg" } } } } });
    const { view } = draw(doc, values);
    const tiles = [...view.container.querySelectorAll<HTMLElement>("[data-slate-tile]")];
    expect(tiles.map(t => t.textContent).filter(t => t?.startsWith("index"))).toHaveLength(2);
    expect(tiles.some(t => t.title.includes("empty"))).toBe(false);
    expect(tiles.every(t => !/NaN/.test(t.getAttribute("style") ?? ""))).toBe(true);
    expect(said.mock.calls.map(c => String(c[0]))).toEqual([]);
  });
});
