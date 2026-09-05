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

describe("the agent's shell folder", () => {
  it("roots the panes over the thread's folder, and clears when the thread does", () => {
    useRootStore.getState().follow(WS, "/root");
    useRootStore.getState().shell(WS, "/root/2048");
    expect(root()).toBe("/root/2048");
    expect(useRootStore.getState().byWorkspaceId[WS]!.followed).toBe("/root");
    useRootStore.getState().shell(WS, null);
    expect(root()).toBe("/root");
  });

  it("loses to the pin, and is ignored outside the daemon's root", () => {
    useRootStore.getState().follow(WS, "/root");
    useRootStore.getState().pin(WS, "/root/docs");
    useRootStore.getState().shell(WS, "/root/2048");
    expect(root()).toBe("/root/docs");
    useRootStore.getState().unpin(WS);
    expect(root()).toBe("/root/2048");
    useRootStore.getState().shell(WS, "/tmp/scratch");
    expect(root()).toBe("/root");
    expect(selectRoot(useRootStore.getState().byWorkspaceId, WS, "/")).toBe("/tmp/scratch");
  });

  it("does not produce a new state for a shell folder already held", () => {
    useRootStore.getState().shell(WS, "/root/2048");
    const before = useRootStore.getState().byWorkspaceId;
    useRootStore.getState().shell(WS, "/root/2048");
    expect(useRootStore.getState().byWorkspaceId).toBe(before);
  });
});
