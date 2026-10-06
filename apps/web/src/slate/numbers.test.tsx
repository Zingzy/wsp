// SPDX-License-Identifier: AGPL-3.0-only
// A number reads as its figure once it settles: on its first draw, when a refreshing run pushes the same value again,
// when a new value lands, and when a run goes running then done with its value kept. A roll is a passing look on a
// real change, never what the figure rests as.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlate, slateStartValues, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";
import { fakeLink, manualScheduler } from "./testing";

const TEXT = `<slate title="Gold">
<run name="spot" cmd="curl -s https://example.test/gold" every={60} />
<column>
<number id="gram" label="Per gram" value={$spot.json.gram} format="integer" unit="/g" />
<number id="ounce" label="Per ounce" value={$spot.json.ounce} format="usd" size="large" />
</column>
</slate>`;

const done = (gram: number, ounce: number, runs: number): SlateJson => ({ state: "done", exit: 0, json: { gram, ounce }, runs });
const refreshing = (gram: number, ounce: number, runs: number): SlateJson => ({ state: "running", refreshing: true, exit: 0, json: { gram, ounce }, runs });

/** The text a person sees: every text node not hidden from the eye, and a digit column wherever one is drawn. */
function seen(el: Element): string {
  if (el.classList.contains("digit-strip")) return "[column]";
  if (el.classList.contains("invisible") || el.classList.contains("text-transparent") || el.classList.contains("sr-only")) return "";
  return [...el.childNodes].map(node => (node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "") : node instanceof Element ? seen(node) : "")).join("");
}

function setup() {
  const scheduler = manualScheduler();
  const engine = new SlateEngine("t1", () => undefined, scheduler);
  const r = parseSlate(TEXT);
  expect(r.errors).toEqual([]);
  const doc = r.document!;
  engine.setRecord(doc, { ...slateStartValues(doc), spot: done(14918, 4141.8, 1) }, 3, 3);
  const link = fakeLink();
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  let revision = 3;
  const settle = () =>
    act(() => {
      for (let i = 0; i < 4; i++) {
        scheduler.run();
        vi.advanceTimersByTime(1_000);
      }
    });
  const push = (value: SlateJson) => {
    act(() => engine.applyValues({ $spot: value }, ++revision));
    act(() => scheduler.run());
  };
  const figure = (id: string) => view.container.querySelector(`[data-slate-piece="${id}"] .font-mono`)!;
  return { settle, push, figure };
}

describe("a number at rest reads its figure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("on its first draw, with no column drawn and no roll up from zeros", () => {
    const { settle, figure } = setup();
    expect(seen(figure("gram"))).toBe("14,918/g");
    expect(seen(figure("ounce"))).toBe("$4,141.80");
    settle();
    expect(seen(figure("gram"))).toBe("14,918/g");
    expect(seen(figure("ounce"))).toBe("$4,141.80");
    expect(figure("ounce").textContent).toBe("$4,141.80");
  });

  it("through a refresh that keeps its value, the same value again, and a run going running then done", () => {
    const { settle, push, figure } = setup();
    settle();
    push(refreshing(14918, 4141.8, 2));
    expect(seen(figure("ounce"))).toBe("$4,141.80");
    push(done(14918, 4141.8, 2));
    expect(seen(figure("ounce"))).toBe("$4,141.80");
    settle();
    expect(seen(figure("gram"))).toBe("14,918/g");
    expect(seen(figure("ounce"))).toBe("$4,141.80");
  });

  it("rolls on a real change and rests on the new figure", () => {
    const { settle, push, figure } = setup();
    settle();
    push(refreshing(14918, 4141.8, 2));
    push(done(15020, 4205.25, 2));
    expect(figure("ounce").querySelector(".digit-strip")).not.toBeNull();
    expect(figure("ounce").textContent).toBe("$4,205.25");
    settle();
    expect(seen(figure("gram"))).toBe("15,020/g");
    expect(seen(figure("ounce"))).toBe("$4,205.25");
  });

  it("rests on the last figure when a new one lands mid-roll", () => {
    const { settle, push, figure } = setup();
    settle();
    push(done(15020, 4205.25, 2));
    act(() => vi.advanceTimersByTime(120));
    push(done(14990, 4199.99, 3));
    act(() => vi.advanceTimersByTime(120));
    push(done(15001, 4210, 4));
    settle();
    expect(seen(figure("gram"))).toBe("15,001/g");
    expect(seen(figure("ounce"))).toBe("$4,210.00");
  });
});
