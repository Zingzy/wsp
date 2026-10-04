// SPDX-License-Identifier: AGPL-3.0-only
// Built by Vite into a folder and opened in a real browser: the slate renderer drawing the spoo live traffic fixture
// at the panel's width (?w=, 400 unless named), inside the panel's 16 px column, with no host behind it.
import { createRoot } from "react-dom/client";
import { ActionRunner, StateSender, type SlateLink } from "../../src/slate/actions";
import { SlateEngine } from "../../src/slate/engine";
import { SPOO_TEXT, SPOO_VALUES, todaySlate } from "../../src/slate/fixtures/today";
import { SLATE_VIEWS } from "../../src/slate/pieces";
import { SlateView } from "../../src/slate/SlateView";
import "./harness.css";

const width = Number(new URLSearchParams(location.search).get("w") ?? 400);
const { doc, values } = todaySlate(SPOO_TEXT, SPOO_VALUES);
const engine = new SlateEngine("t1");
engine.setRecord(doc, values, 3, 3);
(window as unknown as { slateEngine: SlateEngine }).slateEngine = engine;
const link: SlateLink = {
  event: async () => ({ outcome: "started" }),
  writeState: async () => ({ version: 4 }),
  approve: async () => ({ ok: true }),
  cancel: async () => ({ ok: true }),
  consent: () => {},
  fill: () => {},
} as unknown as SlateLink;
createRoot(document.getElementById("root")!).render(
  <div data-panel style={{ width }} className="mx-auto w-full max-w-[760px] px-4 py-4">
    <SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />
  </div>,
);
