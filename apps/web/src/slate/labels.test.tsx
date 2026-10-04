// SPDX-License-Identifier: AGPL-3.0-only
// A label or text built from data that has not come draws its placeholder or nothing, never the words around it.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { parseSlate, slateStartValues, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";
import { fakeLink, manualScheduler } from "./testing";

afterEach(cleanup);

const TEXT = `<slate title="Traffic">
<value name="t" start={[]} />
<column>
<number id="rpm" label={concat($t[0].zone, ', requests per minute')} value={1240} />
<text id="line" value={\`\${$t[0].zone} is up\`} placeholder="Waiting for the first read" />
</column>
</slate>`;

function draw(t: SlateJson) {
  const r = parseSlate(TEXT);
  expect(r.errors).toEqual([]);
  const doc = r.document!;
  const engine = new SlateEngine("t1", () => undefined, manualScheduler());
  engine.setRecord(doc, { ...slateStartValues(doc), t }, 3, 3);
  const link = fakeLink();
  return render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />).container;
}

const piece = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-slate-piece="${id}"]`)!;

it("draws no half sentence while the zone has not come, and the whole one once it has", () => {
  const before = draw([]);
  expect(piece(before, "rpm").textContent).not.toContain("requests per minute");
  expect(piece(before, "line").textContent).toBe("Waiting for the first read");
  cleanup();
  const after = draw([{ zone: "spoo.me" }]);
  expect(piece(after, "rpm").textContent).toContain("spoo.me, requests per minute");
  expect(piece(after, "line").textContent).toBe("spoo.me is up");
});
