// SPDX-License-Identifier: AGPL-3.0-only
// A workspace that holds a copy of its project works in the copy: the panes root there and a dialog about the
// working folder names it, never the project folder the copy was taken from.
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceView } from "@wsp/protocol";
import { useRoots, useWorkingFolder } from "../src/files/root.js";
import { provideDaemonHello } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { DAEMON_HELLO, resetSurfaces } from "./surface-harness.js";

const WS = "ws_copy";
const copied: WorkspaceView = {
  id: WS,
  name: "cart",
  machineId: "local",
  phase: "running",
  golden: "",
  createdAt: "2026-09-01T00:00:00Z",
  project: { id: "pr_1", name: "spoo", path: "/Users/maya/spoo", computer: "here" },
  copy: { path: "/Users/maya/wsp-work/spoo-cart", base: "main", branch: "cart", road: "worktree", source: "/Users/maya/spoo", carried: "nothing" },
};

beforeEach(() => {
  resetSurfaces();
  provideDaemonHello(WS, DAEMON_HELLO);
  useStore.setState({ workspaces: [copied] });
});

describe("a copy's folders", () => {
  it("roots the panes at the copy, not the project folder it was taken from", () => {
    const { result } = renderHook(() => useRoots(WS));
    expect(result.current).toContain("/Users/maya/wsp-work/spoo-cart");
    expect(result.current).not.toContain("/Users/maya/spoo");
  });

  it("names the copy as the working folder before the thread reports one", () => {
    const { result } = renderHook(() => useWorkingFolder(WS));
    expect(result.current).toBe("/Users/maya/wsp-work/spoo-cart");
  });
});
