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
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
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
    expect(screen.getAllByRole("button").length).toBe(2);
  });
});
