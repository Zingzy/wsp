// SPDX-License-Identifier: AGPL-3.0-only
// A table alone in its section, or one of figures only, is as wide as what it holds, each figure column's title over
// its figures; only tables lined up beside others with a text column to take the room fill the width.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

const table = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-slate-piece="${id}"] table`)!;
const heads = (t: HTMLElement) => [...t.querySelectorAll("th")].map(th => th.className.includes("text-right"));
const cells = (t: HTMLElement) => [...t.querySelectorAll("tbody tr:first-child td")].map(td => td.className.includes("text-right"));

describe("a table's width", () => {
  it("draws a two-column table of figures alone in its section as wide as its figures, titles over them", () => {
    const c = draw(`<slate title="Gold">
<value name="karats" start={[{ k: "24K", g: "₹14,918" }, { k: "22K", g: "₹13,675" }, { k: "18K", g: "₹11,189" }]} />
<column><section title="Per gram"><table id="t" items={$karats}><col title="Karat" value={item.k} /><col title="Price per gram" value={item.g} /></table></section></column>
</slate>`);
    const t = table(c, "t");
    expect(t.classList.contains("w-full")).toBe(false);
    expect(t.className).toContain("w-auto");
    expect(heads(t)).toEqual([true, true]);
    expect(cells(t)).toEqual([true, true]);
    expect([...t.querySelectorAll("col")].map(col => col.getAttribute("data-ch"))).toEqual(["5", "14"]);
  });

  it("keeps a lone table with a text column to its content too", () => {
    const c = draw(`<slate>
<value name="z" start={[{ zone: "spoo.me", rpm: 1240 }]} />
<column><table id="t" items={$z}><col title="Zone" value={item.zone} /><col title="Requests" value={item.rpm} /></table></column>
</slate>`);
    const t = table(c, "t");
    expect(t.className).toContain("w-auto");
    expect(heads(t)).toEqual([false, true]);
  });

  it("fills the width only for tables lined up beside others in a section", () => {
    const c = draw(`<slate>
<value name="a" start={[{ name: "nginx", cpu: "1.2%" }]} />
<value name="b" start={[{ name: "postgres", cpu: "12.75%" }]} />
<column>
  <section title="Containers">
    <table id="ta" items={$a}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /></table>
    <table id="tb" items={$b}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /></table>
  </section>
  <section title="Other"><table id="tc" items={$a}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /></table></section>
</column></slate>`);
    expect(table(c, "ta").classList.contains("w-full")).toBe(true);
    expect(table(c, "tb").classList.contains("w-full")).toBe(true);
    expect(table(c, "tc").className).toContain("w-auto");
  });
});
