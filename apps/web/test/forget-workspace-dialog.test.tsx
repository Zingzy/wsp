// SPDX-License-Identifier: AGPL-3.0-only
// The delete confirmation's sentence for a copy on a computer somebody
// joined: that computer by the name the app gives it, never the cloud.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceView, WorkspaceView } from "@wsp/protocol";
import { ForgetWorkspaceDialog } from "../src/components/ForgetWorkspaceDialog.js";
import { useStore } from "../src/protocol/store.js";

const spoo: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", label: "spoo in Helsinki", default: false };
const onSpoo: WorkspaceView = { id: "ws_fix", name: "fix-login", machineId: "wsp-workspace-ws_fix", kind: "cloud", place: "p_spoo", project: { id: "pr_1", name: "api", path: "/root/api", computer: "p_spoo" }, phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z" };

afterEach(() => {
  cleanup();
  useStore.setState({ places: [] });
});

describe("the delete confirmation", () => {
  it("says a copy on a computer somebody joined is deleted from that computer, by the name the app gives it", () => {
    useStore.setState({ places: [spoo] });
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={() => {}} />);
    const said = document.body.textContent ?? "";
    expect(said).toContain("Its copy on spoo in Helsinki is deleted; its record and 1 thread leave this computer.");
    expect(said).not.toMatch(/cloud|wsp-workspace-ws_fix/);
  });

  it("says each of several copies Keep this one deletes on that computer is deleted from it, never by machine id", () => {
    useStore.setState({ places: [spoo] });
    const second: WorkspaceView = { ...onSpoo, id: "ws_fix2", name: "fix-login-2", machineId: "wsp-workspace-ws_fix2" };
    render(<ForgetWorkspaceDialog workspaces={[onSpoo, second]} threads={2} act="delete" open onOpenChange={() => {}} />);
    const said = document.body.textContent ?? "";
    expect(said).toContain("Each one's copy on spoo in Helsinki is deleted; their records and 2 threads leave this computer.");
    expect(said).not.toMatch(/cloud|wsp-workspace-ws_fix/);
  });
});
