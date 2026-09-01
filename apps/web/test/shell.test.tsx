// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStore } from "../src/protocol/store.js";
import { Rail } from "../src/components/Rail.js";
import type { Api } from "../src/protocol/client.js";
import type { WorkspaceView } from "@wsp/protocol";

function fakeApi(workspaces: WorkspaceView[]): Api {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
  };
}

describe("shell scaffold", () => {
  it("rail renders a card per workspace from the store", async () => {
    const ws: WorkspaceView[] = [
      { id: "ws_aaaaaaaa", name: "api", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" },
      { id: "ws_bbbbbbbb", name: "web", machineId: "m2", phase: "napping", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" },
    ];
    useStore.getState().bind(fakeApi(ws));
    render(<Rail />);
    await waitFor(() => expect(screen.getByText("api")).toBeDefined());
    expect(screen.getByText("web")).toBeDefined();
    // one selectable card per workspace (nap/wake and new-workspace are extra buttons)
    expect(screen.getAllByRole("button", { name: /^(api|web)/ }).length).toBe(2);
  });
});
