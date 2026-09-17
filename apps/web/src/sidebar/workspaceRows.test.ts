// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { THIS_COMPUTER, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { whereWord } from "./workspaceRows";

const workspace = (over: Partial<WorkspaceView>): WorkspaceView =>
  ({ id: "ws_1", name: "a", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-12T00:00:00.000Z", ...over }) as WorkspaceView;

describe("where a row says a workspace runs", () => {
  it("reads the live record's provider, and the computer the host runs on in that machine's own words", () => {
    expect(whereWord({ workspace: workspace({ kind: "cloud", provider: "solari" }), status: null })).toBe("solari");
    expect(whereWord({ workspace: workspace({ kind: "local" }), status: null })).toBe(THIS_COMPUTER);
    expect(whereWord({ workspace: workspace({ kind: "local" }), status: { machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, facts: { os: "macOS 26.4" } } as WorkspaceStatus })).toBe("this Mac");
  });
});
