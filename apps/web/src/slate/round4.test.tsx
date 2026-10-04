// SPDX-License-Identifier: AGPL-3.0-only
// Round 4 in the renderer: a refreshing run keeps what it drew and says so quietly, and the layout defaults that
// make a good slate without the agent asking.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseSlate, slateStartValues, type SlateDoc, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
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
  let revision = 3;
  const push = (values: Record<string, SlateJson>) => act(() => {
    revision += 1;
    engine.applyValues(values, revision);
    engine.flush();
  });
  return { engine, view, push, frame: () => act(() => scheduler.run()) };
}

const piece = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-slate-piece="${id}"]`)!;

describe("a refreshing run", () => {
  const BOARD = `<slate>
<run name="procs" cmd="ps -eo pid,comm" every={10} />
<run name="disk" cmd="df -h" />
<column>
  <section id="top" title="Processes">
    <text id="count" value={$procs.out} />
  </section>
  <section id="other" title="Disk">
    <text id="free" value={$disk.out} />
  </section>
  <output id="log" run={$procs} />
  <text id="loose" value={$procs.exit} />
</column>
</slate>`;
  const DONE = { state: "done", exit: 0, out: "412 processes", lines: ["412 processes"], runs: 1 };
  const REFRESHING = { ...DONE, state: "running", refreshing: true, runs: 2 };

  it("keeps the last values drawn and marks only the nearest section and the run's own output", () => {
    const { view, push } = draw(compiled(BOARD), { procs: DONE, disk: { state: "done", out: "40G free", runs: 1 } });
    const c = view.container;
    expect(c.querySelector("[data-slate-refreshing]")).toBeNull();
    push({ $procs: REFRESHING });
    expect(piece(c, "count").textContent).toBe("412 processes");
    expect(piece(c, "top").querySelector("[data-slate-refreshing]")).not.toBeNull();
    expect(piece(c, "other").querySelector("[data-slate-refreshing]")).toBeNull();
    const log = piece(c, "log");
    expect(log.querySelector("[data-slate-refreshing]")).not.toBeNull();
    expect(log.querySelector("[role=log]")!.textContent).toBe("412 processes");
    expect(log.querySelector("[data-slate-cancel]")).toBeNull();
    expect(log.textContent).not.toContain("Running");
    push({ $procs: { state: "done", exit: 0, out: "415 processes", lines: ["415 processes"], runs: 2 } });
    expect(piece(c, "count").textContent).toBe("415 processes");
    expect(c.querySelector("[data-slate-refreshing]")).toBeNull();
    expect(log.querySelector("[role=log]")!.textContent).toBe("415 processes");
  });

  it("says itself in the slate's header for a piece under no section", () => {
    const { engine, push } = draw(compiled(BOARD), { procs: DONE });
    const root = engine.document!.root;
    expect(engine.refreshingUnder(root)).toBe(false);
    push({ $procs: REFRESHING });
    expect(engine.refreshingUnder(root)).toBe(true);
    const nothingLoose = compiled(BOARD.replace(`<text id="loose" value={$procs.exit} />`, ""));
    const second = draw(nothingLoose, { procs: DONE });
    second.push({ $procs: REFRESHING });
    expect(second.engine.refreshingUnder(second.engine.document!.root)).toBe(false);
  });

  it("keeps the streamed lines until the refresh streams its own first line", () => {
    const { engine, view, push } = draw(compiled(BOARD), { procs: { state: "running", runs: 1 } });
    act(() => engine.appendLines("procs", ["one", "two"]));
    push({ $procs: { state: "done", exit: 0, runs: 1 } });
    push({ $procs: { state: "running", refreshing: true, exit: 0, runs: 2 } });
    const log = () => piece(view.container, "log").querySelector("[role=log]")!.textContent;
    expect(log()).toBe("onetwo");
    act(() => {
      engine.appendLines("procs", ["three"]);
      engine.flush();
    });
    expect(log()).toBe("three");
  });

  it("starts a first run's lines afresh as before", () => {
    const { engine, push } = draw(compiled(BOARD), { procs: { state: "done", exit: 0, runs: 1 } });
    act(() => engine.appendLines("procs", ["old"]));
    push({ $procs: { state: "running", runs: 2 } });
    expect(engine.lines("procs")).toBeUndefined();
  });
});
