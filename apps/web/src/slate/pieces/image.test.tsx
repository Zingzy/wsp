// A picture the agent shoots again at the same path shows again: every write of the slate asks the host once more for
// each image on screen, naming the version this window holds, and a refusal is never kept. A thread opened again
// asks again, and every picture a piece let go of is released.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlatesImageAnswer } from "@wsp/protocol";
import { slateStartValues, type SlateDoc } from "@wsp/protocol/slate";
import { ActionRunner, StateSender, type SlateLink } from "../actions";
import { SlateEngine } from "../engine";
import { SlateView } from "../SlateView";
import { fakeLink, manualScheduler, slate } from "../testing";
import { SLATE_VIEWS } from ".";

const DOC: SlateDoc = slate({ root: "root", pieces: { root: { type: "column", children: ["shot"] }, shot: { type: "image", props: { src: "/tmp/shot.png" } } } });
const picture = (version: string): SlatesImageAnswer => ({ mediaType: "image/png", bytes: btoa(`png ${version}`), version });

let made = 0;
const revoked: string[] = [];
beforeEach(() => {
  made = 0;
  revoked.length = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:shot-${++made}`, revokeObjectURL: (url: string) => void revoked.push(url) }));
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 160 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 100 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(engine: SlateEngine, link: SlateLink) {
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  return { view, settle: () => act(async () => void (await new Promise(r => setTimeout(r, 0)))) };
}

function thread(answers: SlatesImageAnswer[]) {
  const engine = new SlateEngine("t1", () => undefined, manualScheduler());
  engine.setRecord(DOC, slateStartValues(DOC), 3, 3);
  const asked: { src: string; have: string | undefined }[] = [];
  const link = fakeLink({ image: async (src, have) => (asked.push({ src, have }), answers.shift() ?? picture("last")) });
  const rewrite = (version: number) => act(() => engine.setRecord(DOC, slateStartValues(DOC), version, version));
  return { engine, link, asked, rewrite };
}

const shown = (): string | null => document.querySelector("[data-slate-image] img")?.getAttribute("src") ?? null;
const said = (): string | null => document.querySelector("[data-slate-image-refused]")?.textContent ?? null;

describe("an image the agent changes", () => {
  it("shows the new picture once the slate is written again after its file was overwritten, and lets the old one go", async () => {
    const t = thread([picture("1"), picture("2")]);
    const { settle } = open(t.engine, t.link);
    await settle();
    expect(shown()).toBe("blob:shot-1");
    await t.rewrite(4);
    await settle();
    expect(t.asked).toEqual([{ src: "/tmp/shot.png", have: undefined }, { src: "/tmp/shot.png", have: "1" }]);
    expect(shown()).toBe("blob:shot-2");
    expect(revoked).toEqual(["blob:shot-1"]);
  });

  it("keeps the picture it has when the host says the file did not change", async () => {
    const t = thread([picture("1"), { unchanged: true, version: "1" }]);
    const { settle } = open(t.engine, t.link);
    await settle();
    await t.rewrite(4);
    await settle();
    expect(shown()).toBe("blob:shot-1");
    expect(made).toBe(1);
    expect(revoked).toEqual([]);
  });

  it("shows the picture once the slate is written again after the file was saved, never keeping the refusal", async () => {
    const t = thread([{ problem: { code: "R900", name: "data-missing", message: "no file at /tmp/shot.png" } }, picture("1")]);
    const { settle } = open(t.engine, t.link);
    await settle();
    expect(said()).toBe("No file at /tmp/shot.png");
    await t.rewrite(4);
    await settle();
    expect(said()).toBeNull();
    expect(shown()).toBe("blob:shot-1");
  });

  it("asks again when the thread is opened again, and releases every picture when the piece goes", async () => {
    const t = thread([picture("1"), picture("2")]);
    const first = open(t.engine, t.link);
    await first.settle();
    first.view.unmount();
    expect(revoked).toEqual(["blob:shot-1"]);
    const again = open(t.engine, t.link);
    await again.settle();
    expect(shown()).toBe("blob:shot-2");
    again.view.unmount();
    expect(revoked).toEqual(["blob:shot-1", "blob:shot-2"]);
  });
});

describe("single images and runs", () => {
  it("asks for a single image only once it comes near view, so 100 out of view ask nothing", async () => {
    const watching: { cb: (entries: { isIntersecting: boolean; target: Element }[]) => void; els: Element[] }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        els: Element[] = [];
        constructor(cb: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
          watching.push({ cb, els: this.els });
        }
        observe(el: Element) {
          this.els.push(el);
        }
        disconnect() {}
      },
    );
    const ids = Array.from({ length: 100 }, (_, i) => `shot${i}`);
    const doc = slate({ root: "root", pieces: { root: { type: "column", children: ids }, ...Object.fromEntries(ids.map((id, i) => [id, { type: "image", props: { src: `/tmp/${i}.png` } }])) } });
    const engine = new SlateEngine("t1", () => undefined, manualScheduler());
    engine.setRecord(doc, slateStartValues(doc), 3, 3);
    const asked: string[] = [];
    const link = fakeLink({ image: async src => (asked.push(src), picture(src)) });
    const { settle } = open(engine, link);
    await settle();
    expect(asked).toEqual([]);
    await act(async () => {
      for (const w of watching.slice(0, 3)) w.cb(w.els.map(target => ({ isIntersecting: true, target })));
    });
    await settle();
    expect(asked).toEqual(["/tmp/0.png", "/tmp/1.png", "/tmp/2.png"]);
  });

  it("asks again when a run on the slate finishes, so a screenshot a timed run takes again shows", async () => {
    const doc = slate({ root: "root", runs: { shoot: { kind: "cmd", cmd: "screencapture -x /tmp/live.png", every: 60 } }, pieces: { root: { type: "column", children: ["shot"] }, shot: { type: "image", props: { src: "/tmp/live.png" } } } } as never);
    const engine = new SlateEngine("t1", () => undefined, manualScheduler());
    engine.setRecord(doc, { ...slateStartValues(doc), shoot: { state: "done", runs: 1 } }, 3, 3);
    const answers = [picture("1"), picture("2")];
    const asked: (string | undefined)[] = [];
    const link = fakeLink({ image: async (_src, have) => (asked.push(have), answers.shift() ?? picture("last")) });
    const { settle } = open(engine, link);
    await settle();
    expect(shown()).toBe("blob:shot-1");
    await act(() => engine.applyValues({ $shoot: { state: "running", runs: 2 } }, 4));
    await act(() => engine.applyValues({ $shoot: { state: "done", runs: 2 } }, 5));
    await settle();
    expect(asked).toEqual([undefined, "1"]);
    expect(shown()).toBe("blob:shot-2");
  });
});

