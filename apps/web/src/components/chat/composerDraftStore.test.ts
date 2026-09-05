// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "./composerDraftStore";

const WS = "ws_1";
const store = useComposerDraftStore;
const queue = () => store.getState().queues[WS] ?? [];
const prompts = () => queue().map(r => r.prompt);

beforeEach(() => {
  window.localStorage.clear();
  store.setState({ drafts: {}, queues: {} });
});

describe("composer queue", () => {
  it("enqueues in order, edits in place, removes by id and drops the empty queue", () => {
    store.getState().enqueue(WS, "first");
    store.getState().enqueue(WS, "second");
    expect(prompts()).toEqual(["first", "second"]);
    const [a, b] = queue();
    expect(a!.id).not.toBe(b!.id);
    store.getState().editQueued(WS, b!.id, "second, edited");
    expect(prompts()).toEqual(["first", "second, edited"]);
    store.getState().removeQueued(WS, a!.id);
    expect(prompts()).toEqual(["second, edited"]);
    store.getState().removeQueued(WS, b!.id);
    expect(store.getState().queues[WS]).toBeUndefined();
  });

  it("promotes a row to the head and keeps the rest in order", () => {
    for (const p of ["a", "b", "c"]) store.getState().enqueue(WS, p);
    const c = queue()[2]!;
    store.getState().promoteQueued(WS, c.id);
    expect(prompts()).toEqual(["c", "a", "b"]);
    const before = queue();
    store.getState().promoteQueued(WS, c.id);
    expect(queue()).toBe(before);
  });

  it("rekeys a queue behind the rows already at the new key and is a no-op without rows or onto itself", () => {
    store.getState().enqueue(WS, "typed while sending");
    store.getState().enqueue("thr_new", "already here");
    const before = store.getState();
    store.getState().rekeyQueue("nothing", "thr_new");
    store.getState().rekeyQueue(WS, WS);
    expect(store.getState()).toBe(before);
    store.getState().rekeyQueue(WS, "thr_new");
    expect(store.getState().queues[WS]).toBeUndefined();
    expect(store.getState().queues["thr_new"]?.map(r => r.prompt)).toEqual(["already here", "typed while sending"]);
  });

  it("keeps other workspaces' queues untouched and returns the same state for a no-op", () => {
    store.getState().enqueue("ws_2", "elsewhere");
    const before = store.getState();
    store.getState().removeQueued(WS, "missing");
    store.getState().editQueued("ws_2", "missing", "x");
    expect(store.getState()).toBe(before);
    expect(store.getState().queues["ws_2"]?.map(r => r.prompt)).toEqual(["elsewhere"]);
  });

  it("persists the draft and the queue and rebuilds them on rehydrate, dropping rows a bad write left malformed", async () => {
    store.getState().setDraft(WS, { prompt: "half a", cursor: 6 });
    store.getState().enqueue(WS, "what model are you?");
    const stored = JSON.parse(window.localStorage.getItem("wsp:composer-drafts:v1") ?? "{}");
    expect(stored.state.queues[WS]).toHaveLength(1);
    expect(stored.state.drafts[WS]).toEqual({ prompt: "half a", cursor: 6 });
    stored.state.queues[WS].push({ id: 7 }, "junk");
    stored.state.queues["ws_empty"] = [];
    stored.state.drafts["ws_blank"] = { prompt: "", cursor: 0 };
    // Clearing the store writes through to storage, so the doctored copy goes in after it.
    store.setState({ drafts: {}, queues: {} });
    window.localStorage.setItem("wsp:composer-drafts:v1", JSON.stringify(stored));
    await store.persist.rehydrate();
    expect(prompts()).toEqual(["what model are you?"]);
    expect(Object.keys(store.getState().queues)).toEqual([WS]);
    expect(store.getState().drafts).toEqual({ [WS]: { prompt: "half a", cursor: 6 } });
  });
});
