// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { useComposerOptionsStore } from "./composerOptionsStore";

const KEY = useComposerOptionsStore.persist.getOptions().name!;

/** What another tab, an older build or a hand-edited profile can leave under this key. */
async function stored(state: unknown, version = useComposerOptionsStore.persist.getOptions().version): Promise<ReturnType<typeof useComposerOptionsStore.getState>> {
  window.localStorage.setItem(KEY, JSON.stringify({ state, version }));
  await useComposerOptionsStore.persist.rehydrate();
  return useComposerOptionsStore.getState();
}

describe("the composer's picks as they come back off local storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  });

  it("reads back the picks and the thread each of them was made in", async () => {
    const state = await stored({
      byWorkspaceId: { ws_a: { model: "claude-opus-5", contextWindow: "1m", effort: "low" } },
      pickedOn: { ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } },
    });
    expect(state.byWorkspaceId).toEqual({ ws_a: { model: "claude-opus-5", contextWindow: "1m", effort: "low" } });
    // The access has no value here, only the thread it was picked on: its mode lives on the host's record.
    expect(state.pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
  });

  it("drops the picks a build kept for every next thread of a workspace, which would stand over the defaults", async () => {
    const state = await stored({ byWorkspaceId: { "project:pr_1": { harness: "claude" }, ws_a: { model: "claude-opus-5" } }, pickedOn: { ws_a: { model: "t1" } } }, 1);
    expect([state.byWorkspaceId, state.pickedOn]).toEqual([{}, {}]);
  });

  it("hands a draft's picks and its stamps to the workspace its send made, and drops what a send carried and nothing of another thread's", () => {
    const { pick, move, drop } = useComposerOptionsStore.getState();
    pick("project:pr_1", "harness", "codex");
    pick("project:pr_1", "effort", "low", "project:pr_1");
    move("project:pr_1", "ws_a");
    expect(useComposerOptionsStore.getState()).toMatchObject({ byWorkspaceId: { ws_a: { harness: "codex", effort: "low" } }, pickedOn: { ws_a: { effort: "ws_a" } } });
    pick("ws_a", "model", "claude-opus-5", "t1");
    drop("ws_a", "ws_a");
    expect(useComposerOptionsStore.getState()).toMatchObject({ byWorkspaceId: { ws_a: { model: "claude-opus-5" } }, pickedOn: { ws_a: { model: "t1" } } });
  });

  it("drops a thread record of the wrong shape rather than handing the pickers a value that is not a thread", async () => {
    // Read on every hydrate, not only on a version change: one of these would otherwise reach pickedFor as a thread
    // key and decide which thread a pick belongs to.
    const odd = { ws_a: { model: 7 }, ws_b: { model: null }, ws_c: { model: "" }, ws_d: { model: { id: "t1" } }, ws_e: { model: "t2", effort: "t3", harness: "t4" } };
    // The harness is not a thread's to keep, so a thread stored under it is dropped with the malformed ones.
    expect((await stored({ byWorkspaceId: {}, pickedOn: odd })).pickedOn).toEqual({ ws_e: { model: "t2", effort: "t3" } });
    expect((await stored({ byWorkspaceId: {}, pickedOn: { ws_a: "t1" } })).pickedOn).toEqual({});
    expect((await stored({ byWorkspaceId: {}, pickedOn: "t1" })).pickedOn).toEqual({});
    expect((await stored({ byWorkspaceId: {} })).pickedOn).toEqual({});
    expect((await stored(null)).pickedOn).toEqual({});
  });

  it("a pick names the thread it was made in, each pick on its own, and nothing else is named", () => {
    const { pick } = useComposerOptionsStore.getState();
    pick("ws_a", "model", "claude-opus-5", "t1");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1" } });
    // The window is a pick of its own: it names the thread it was picked on and leaves the model's thread alone,
    // or a window picked here would carry a model picked somewhere else onto this thread.
    pick("ws_a", "contextWindow", "200k", "t2");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2" } });
    // The effort and the access are picks of a thread's too; the harness is not, so it names no thread.
    pick("ws_a", "effort", "low", "t3");
    pick("ws_a", "permissionMode", "plan", "t4");
    pick("ws_a", "harness", "codex", "t5");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t1", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
    // The access mode itself is not kept here: the host's record holds it, and this store holds only its thread.
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_a"]?.permissionMode).toBeUndefined();
    // The same value picked again on the same thread changes nothing at all.
    const before = useComposerOptionsStore.getState();
    pick("ws_a", "model", "claude-opus-5", "t1");
    expect(useComposerOptionsStore.getState()).toBe(before);
    // The same value picked again on another thread still moves that pick, and only that pick.
    pick("ws_a", "model", "claude-opus-5", "t9");
    expect(useComposerOptionsStore.getState().pickedOn).toEqual({ ws_a: { model: "t9", contextWindow: "t2", effort: "t3", permissionMode: "t4" } });
    expect(useComposerOptionsStore.getState().byWorkspaceId).toEqual({ ws_a: { model: "claude-opus-5", contextWindow: "200k", effort: "low", harness: "codex" } });
  });
});
