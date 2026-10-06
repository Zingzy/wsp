// SPDX-License-Identifier: AGPL-3.0-only
// A table is a list in the settings grammar: it fills the card it stands in, the first column the row's name at the
// left taking the room, figure columns right-aligned at the end; stacked tables share one column template.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlate, slateStartValues, type SlateDoc } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";
import { fakeLink, manualScheduler } from "./testing";

afterEach(cleanup);

function draw(text: string) {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  const doc: SlateDoc = r.document!;
  const engine = new SlateEngine("t1", () => undefined, manualScheduler());
  engine.setRecord(doc, slateStartValues(doc), 3, 3);
  const link = fakeLink();
  return render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />).container;
}

const table = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-slate-piece="${id}"] [role=table]`)!;
const heads = (t: HTMLElement) => [...t.querySelectorAll("[role=columnheader]")].map(th => th.className.includes("text-right"));
const cells = (t: HTMLElement) => [...t.querySelectorAll("[role=row]:not([data-slate-head])")][0]!.querySelectorAll("[role=cell]");
const ends = (t: HTMLElement) => [...cells(t)].map(td => td.className.includes("text-right"));
const tracks = (t: HTMLElement) => t.style.gridTemplateColumns;

describe("a table in its card", () => {
  it("gives every row its own key when two rows give the same one or a key is an object", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = draw(`<slate><column>
<table id="t" items={[{ n: 'a', v: 1 }, { n: 'a', v: 2 }]} key={item.n}><col title="Name" value={item.n} /><col title="V" value={item.v} /></table>
<checklist id="c" items={[{ id: { x: 1 }, t: 'one' }, { id: { x: 2 }, t: 'two' }]} key={item.id} title={item.t} done={false} />
</column></slate>`);
    const keyed = said.mock.calls.filter(call => call.some(arg => typeof arg === "string" && arg.includes("same key")));
    said.mockRestore();
    expect(keyed).toEqual([]);
    expect(table(c, "t").querySelectorAll("[role=row]:not([data-slate-head])")).toHaveLength(2);
    expect(c.querySelector('[data-slate-checklist="c"]')!.querySelectorAll("li")).toHaveLength(2);
  });

  it("draws at most 200 rows and says how many more there are", () => {
    const doc = parseSlate(`<slate><value name="rows" start={[]} /><table id="t" items={$rows}><col title="Name" value={item.n} /></table></slate>`).document!;
    const engine = new SlateEngine("t1", () => undefined, manualScheduler());
    engine.setRecord(doc, { rows: Array.from({ length: 1000 }, (_, at) => ({ n: `row ${at}` })) }, 3, 3);
    const link = fakeLink();
    const c = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />).container;
    expect(table(c, "t").querySelectorAll("[role=row]:not([data-slate-head])")).toHaveLength(200);
    expect(c.textContent).toContain("and 800 more");
  });

  it("puts its header over its own card: the name's column takes the room, the figures end-aligned after it", () => {
    const c = draw(`<slate title="Gold">
<value name="karats" start={[{ k: "24K", g: "₹14,918" }, { k: "22K", g: "₹13,675" }, { k: "18K", g: "₹11,189" }]} />
<column><section title="Per gram"><table id="t" items={$karats}><col title="Karat" value={item.k} /><col title="Price per gram" value={item.g} /></table></section></column>
</slate>`);
    const t = table(c, "t");
    expect(heads(t)).toEqual([false, true]);
    expect(ends(t)).toEqual([false, true]);
    // The card's border and the rows' inset are edge tracks the header shares, so no row pads its own tracks.
    expect(tracks(t)).toBe("calc(var(--settings-inset,20px) - 15px) minmax(0,1fr) minmax(14ch,max-content) calc(var(--settings-inset,20px) - 15px)");
    const card = t.querySelector("[data-slate-head] + div")!;
    expect(card.className).toContain("bg-card/40");
    expect(card.querySelectorAll("[role=row]")).toHaveLength(3);
  });

  it("draws no header row when no column names itself, and the name 14 px, words 13 px muted, figures 12 px mono", () => {
    const c = draw(`<slate>
<value name="z" start={[{ zone: "example.com", plan: "Pro", rpm: 1240 }]} />
<column>
  <table id="t" items={$z}><col title="Zone" value={item.zone} /><col title="Plan" value={item.plan} /><col title="Requests" value={item.rpm} /></table>
  <table id="bare" items={$z}><col title="" value={item.zone} /><col title="" value={item.rpm} /></table>
</column>
</slate>`);
    const t = table(c, "t");
    expect(heads(t)).toEqual([false, false, true]);
    const row = [...cells(t)];
    expect(row[0]!.className).toContain("text-sm");
    expect(row[0]!.className).toContain("text-foreground");
    expect(row[1]!.className).toContain("text-[13px]");
    expect(row[1]!.className).toContain("text-muted-foreground");
    expect(row[2]!.className).toContain("font-mono");
    expect(row[2]!.className).toContain("text-xs");
    expect(table(c, "bare").querySelector("[data-slate-head]")).toBeNull();
  });

  it("gives tables in one section one column template", () => {
    const c = draw(`<slate>
<value name="a" start={[{ name: "nginx", cpu: "1.2%" }]} />
<value name="b" start={[{ name: "postgres", cpu: "12.75%" }]} />
<column>
  <section title="Containers">
    <table id="ta" items={$a}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /></table>
    <table id="tb" items={$b}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /></table>
  </section>
</column></slate>`);
    expect(tracks(table(c, "ta"))).toBe(tracks(table(c, "tb")));
  });

  it("folds a row with more than two text columns to its name over a note, and opens a row whose one action every row takes", () => {
    const c = draw(`<slate>
<value name="mail" start={[{ when: "2026-10-03 22:21", from: "Acme Store", subject: "Your order has shipped", unread: "unread" }]} />
<column><section title="Inbox"><table id="t" items={$mail}>
  <col title="When" value={item.when} mono /><col title="From" value={item.from} /><col title="Subject" value={item.subject} /><col title="Unread" value={item.unread} />
  <action label="Open" onPress={send("Open this message", item.when)} />
</table></section></column></slate>`);
    const t = c.querySelector<HTMLElement>('[data-slate-piece="t"] [data-slate-folded]')!;
    expect(t.querySelector("[role=columnheader]")).toBeNull();
    const open = t.querySelector<HTMLButtonElement>("[data-slate-row-open]")!;
    expect(open.getAttribute("aria-label")).toBe("Open, Your order has shipped");
    expect(open.textContent).toBe("Your order has shippedAcme Storeunread2026-10-03 22:21");
    expect(c.querySelector("[data-slate-row-action]")).toBeNull();
  });

  it("draws a cell's tone over the muted words ink, in a grid and in a folded row", () => {
    const c = draw(`<slate>
<value name="r" start={[{ q: "Which layer routes?", pick: "Link", right: false }]} />
<column><table id="t" items={$r}><col title="Question" value={item.q} /><col title="Result" value={item.right ? 'Right' : 'Wrong'} tone={item.right ? 'good' : 'bad'} /></table>
<table id="f" items={$r}><col title="Question" value={item.q} /><col title="Picked" value={item.pick} /><col title="Result" value={item.right ? 'Right' : 'Wrong'} tone={item.right ? 'good' : 'bad'} /></table></column></slate>`);
    const word = [...cells(table(c, "t"))][1]!;
    expect(word.className).toContain("text-error-foreground");
    expect(word.className).not.toContain("text-muted-foreground");
    const folded = [...c.querySelectorAll('[data-slate-piece="f"] [role=cell] span span')].find(span => span.textContent === "Wrong")!;
    expect(folded.className).toContain("text-error-foreground");
    expect(folded.className).not.toContain("text-muted-foreground");
  });
});
