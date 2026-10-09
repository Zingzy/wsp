// SPDX-License-Identifier: AGPL-3.0-only
// Built by Vite into a folder and opened in a real browser: the slate renderer drawing reach check's spoo live traffic as
// its agent wrote it, with ?doc=diagram a deploy's flow, or a case of cases.ts by its name, at the panel's width (?w=,
// 400 unless named), inside the panel's 16 px column, with no host behind it.
import { createRoot } from "react-dom/client";
import { imageTypeOf, type SlatesImageAnswer } from "@wsp/protocol";
import { slateDomainKey, slateImageMissing, slateImageSource, slateImageTooBig, slateNotAnImage } from "@wsp/protocol/slate";
import { ActionRunner, StateSender, type SlateLink } from "../../src/slate/actions";
import { SlateEngine } from "../../src/slate/engine";
import { DIAGRAM_TEXT, REACH_TEXT, REACH_VALUES, kitSlate } from "../fixtures/slate/kit-slates";
import { RENDER_CASES } from "./cases";
import { SLATE_VIEWS } from "../../src/slate/pieces";
import { SlateView } from "../../src/slate/SlateView";
import "./harness.css";

const query = new URLSearchParams(location.search);
if (query.get("theme") === "paper") {
  document.documentElement.classList.remove("dark");
  document.documentElement.dataset["theme"] = "paper";
}
const width = Number(query.get("w") ?? 400);
const named = RENDER_CASES[query.get("doc") ?? ""];
const { doc, values } = named !== undefined ? kitSlate(named.text, named.values) : query.get("doc") === "diagram" ? kitSlate(DIAGRAM_TEXT) : kitSlate(REACH_TEXT, REACH_VALUES);
/** The host's read of an image, played over the files the harness serves as the thread's folder (a request to the
 * harness's own origin standing in for the host's socket): a path under loading/ never answers, one under too-big/ is
 * refused for its size and one under text/ for its bytes. An address waits on its domain, then is read from the same
 * folder by its path, each one the host fetched kept on window.hostFetched. */
const allowed = new Set<string>();
const hostFetched: string[] = [];
(window as unknown as { hostFetched: string[] }).hostFetched = hostFetched;
async function fromFolder(shown: string, path: string): Promise<SlatesImageAnswer> {
  if (path.startsWith("loading/")) return new Promise(() => {});
  if (path.startsWith("too-big/")) return { problem: slateImageTooBig(shown, 14_900_000) };
  if (path.startsWith("text/")) return { problem: slateNotAnImage(shown) };
  const res = await fetch(`files/${path}`);
  if (!res.ok) return { problem: slateImageMissing(shown) };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mediaType = imageTypeOf(bytes);
  if (mediaType === null) return { problem: slateNotAnImage(shown) };
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType, bytes: btoa(text) };
}
const hostAsked: string[] = [];
(window as unknown as { hostAsked: string[] }).hostAsked = hostAsked;
async function harnessImage(src: string): Promise<SlatesImageAnswer> {
  hostAsked.push(src);
  const said = slateImageSource(src);
  if ("problem" in said) return said;
  if ("path" in said) return fromFolder(said.path, said.path.replace(/^\/+/, ""));
  if (!allowed.has(said.domain)) return { ask: { domain: said.domain } };
  hostFetched.push(said.url);
  return fromFolder(said.url, new URL(said.url).pathname.slice(1));
}

const engine = new SlateEngine("t1");
engine.setRecord(doc, values, 3, 3);
(window as unknown as { slateEngine: SlateEngine }).slateEngine = engine;
const link: SlateLink = {
  event: async () => ({ outcome: "started" }),
  writeState: async () => ({ version: 4 }),
  approve: async (key: string) => {
    if (key.startsWith(slateDomainKey(""))) allowed.add(key.slice(slateDomainKey("").length));
    return { ok: true };
  },
  cancel: async () => ({ ok: true }),
  consent: () => {},
  fill: () => {},
  image: harnessImage,
} as unknown as SlateLink;
createRoot(document.getElementById("root")!).render(
  <div data-panel style={{ width }} className="mx-auto w-full max-w-[760px] px-4 py-4">
    <SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />
  </div>,
);
