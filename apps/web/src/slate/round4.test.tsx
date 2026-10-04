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

describe("layout defaults", () => {
  it("puts a row's buttons at its end after its text, unless the row says where", () => {
    const doc = compiled(`<slate><column>
<row id="r"><text value="Spot gold" /><button label="Refresh" onPress={send("refresh")} /></row>
<row id="placed" align="center"><text value="Spot gold" /><button label="Refresh" onPress={send("refresh")} /></row>
</column></slate>`);
    const { view } = draw(doc);
    const row = piece(view.container, "r").firstElementChild!;
    expect(row.className).toContain("[&>:not([data-slate-type=button])+[data-slate-type=button]]:ml-auto");
    expect(row.children[1]!.getAttribute("data-slate-type")).toBe("button");
    expect(piece(view.container, "placed").firstElementChild!.className).not.toContain("ml-auto");
  });

  it("draws a text beside a heading and a button small and muted, unless it set its own look", () => {
    const doc = compiled(`<slate><column>
<row><heading id="h" value="Gold" /><text id="when" value="checked 2 min ago" /><button label="Refresh" onPress={send("refresh")} /></row>
<row><heading value="Silver" /><text id="loud" value="Market closed" tone="warning" /><button label="Refresh" onPress={send("refresh")} /></row>
<row><text id="plain" value="Kill node" /><button label="Kill" onPress={send("kill")} /></row>
</column></slate>`);
    const { view } = draw(doc);
    const p = (id: string) => piece(view.container, id).querySelector("p")!.className;
    expect(p("when")).toContain("text-xs");
    expect(p("when")).toContain("text-muted-foreground");
    expect(p("loud")).toContain("text-warning");
    expect(p("loud")).toContain("text-sm");
    expect(p("plain")).toContain("text-sm");
    expect(p("plain")).toContain("text-foreground");
  });

  it("draws mono on a sentence in the normal face, and keeps it on figures, ids, times and paths", () => {
    const doc = compiled(`<slate><column>
<text id="sentence" value="The deploy failed because the token expired" mono />
<text id="path" value="apps/web/src/slate/engine.ts" mono />
<text id="time" value="Sat Oct 4 17:22:03 UTC 2026" mono />
<facts><fact label="Why" value="the build ran out of memory" mono /><fact label="PID" value="19271" mono /></facts>
</column></slate>`);
    const { view } = draw(doc);
    const p = (id: string) => piece(view.container, id).querySelector("p")!.className;
    expect(p("sentence")).not.toContain("font-mono");
    expect(p("path")).toContain("font-mono");
    expect(p("time")).toContain("font-mono");
    const facts = [...view.container.querySelectorAll("[data-slate-type=facts] span > span:last-child")].map(e => e.className);
    expect(facts[0]).not.toContain("font-mono");
    expect(facts[1]).toContain("font-mono");
  });

  it("lines up tables in the same section: each tight column takes the widest any of them needs", () => {
    const doc = compiled(`<slate>
<value name="a" start={[{ name: "nginx", cpu: "1.2%", up: "2026-10-04 17:22:03" }]} />
<value name="b" start={[{ name: "postgres", cpu: "12.75%", up: "2026-10-01 09:00:00 UTC" }]} />
<value name="c" start={[{ name: "redis", cpu: "123.5%" }]} />
<column>
  <section title="Containers">
    <table id="ta" items={$a}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.up} mono /></table>
    <table id="tb" items={$b}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.up} mono /></table>
  </section>
  <section title="Other">
    <table id="tc" items={$c}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.name} mono /></table>
  </section>
</column></slate>`);
    const { view, push } = draw(doc);
    const ch = (id: string) => [...piece(view.container, id).querySelectorAll("col")].map(col => col.getAttribute("data-ch"));
    expect(ch("ta")).toEqual([null, "6", "23"]);
    expect(ch("tb")).toEqual([null, "6", "23"]);
    expect(ch("tc")).toEqual([null, "6", "5"]);
    const up = piece(view.container, "ta").querySelector("tbody td:nth-child(3)")!;
    expect(up.className).toContain("whitespace-nowrap");
    expect(up.className).toContain("font-mono");
    push({ $b: [{ name: "postgres", cpu: "1,234.5%", up: "x" }] });
    expect(ch("ta")).toEqual([null, "8", "19"]);
  });

  it("lets a mono column of sentences wrap in the normal face", () => {
    const doc = compiled(`<slate><value name="l" start={[{ msg: "the build ran out of memory on the box" }]} />
<column><table id="t" items={$l}><col title="Message" value={item.msg} mono /></table></column></slate>`);
    const { view } = draw(doc);
    const cell = piece(view.container, "t").querySelector("tbody td")!;
    expect(cell.className).not.toContain("font-mono");
    expect(cell.className).not.toContain("whitespace-nowrap");
  });
});
