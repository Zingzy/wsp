// SPDX-License-Identifier: AGPL-3.0-only
// The center region under the shell header: the selected workspace's thread
// with its composer and the terminal drawer under it, or a prompt to pick a
// workspace. Nothing stands between the header and the thread.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GoldenManifest, WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals } from "../src/terminal/link.js";
import { installFakeLayout } from "./fake-layout.js";

const WS = "ws_center";
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};

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
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => manifest,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
  };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false, gaps: 0 });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});
afterEach(() => {
  cleanup();
  provideTerminals(WS, null);
});

async function mount(workspaces: WorkspaceView[]) {
  useStore.getState().bind(fakeApi(workspaces));
  render(<Shell />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
}

describe("workspace center", () => {
  it("the selected workspace's center is its thread with the composer, and no tab strip stands in front", async () => {
    await mount([workspace]);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("What should we build in");
    expect(heading.textContent).toContain("api");
    expect(screen.getByTestId("composer-editor")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "screen" })).toBeNull();
  });

  it("the terminal drawer opens under the thread and says so while the workspace's link is not live", async () => {
    provideTerminals(WS, new WorkspaceTerminals({ request: () => Promise.reject(new Error("no daemon in this test")) }));
    await mount([workspace]);
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector('[data-terminal-owner="drawer"]')).toBeNull();
    act(() => useTerminalDrawerStore.getState().toggle(WS));
    const drawer = document.querySelector('[data-terminal-owner="drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain("Not connected to this workspace");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("with no workspace the center asks for one instead of showing a strip", async () => {
    await mount([]);
    await screen.findByText("Pick a workspace to continue");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
