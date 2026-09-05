// SPDX-License-Identifier: AGPL-3.0-only
// Where the panes are rooted: the thread's folder as it moves, unless pinned.
import { beforeEach, describe, expect, it } from "vitest";
import { selectRoot, useRootStore } from "../src/files/root.js";

const WS = "ws_root";
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS, "/root");

beforeEach(() => useRootStore.setState({ byWorkspaceId: {} }));

describe("pane root", () => {
  it("is the daemon root until a thread names a folder, then follows every change", () => {
    expect(selectRoot({}, WS, null)).toBeNull();
    expect(root()).toBe("/root");
    useRootStore.getState().follow(WS, "/root/app");
    expect(root()).toBe("/root/app");
    useRootStore.getState().follow(WS, "/root/app/packages/web");
    expect(root()).toBe("/root/app/packages/web");
    expect(selectRoot(useRootStore.getState().byWorkspaceId, "ws_other", "/root")).toBe("/root");
  });

  it("stays where it was pinned while the thread moves, and follows again when unpinned", () => {
    useRootStore.getState().follow(WS, "/root/app");
    useRootStore.getState().pin(WS, "/root/app/docs");
    expect(root()).toBe("/root/app/docs");
    useRootStore.getState().follow(WS, "/root/elsewhere");
    expect(root()).toBe("/root/app/docs");
    expect(useRootStore.getState().byWorkspaceId[WS]!.followed).toBe("/root/elsewhere");
    useRootStore.getState().unpin(WS);
    expect(root()).toBe("/root/elsewhere");
  });

  it("does not produce a new state for a folder already followed", () => {
    useRootStore.getState().follow(WS, "/root/app");
    const before = useRootStore.getState().byWorkspaceId;
    useRootStore.getState().follow(WS, "/root/app");
    expect(useRootStore.getState().byWorkspaceId).toBe(before);
  });
});
