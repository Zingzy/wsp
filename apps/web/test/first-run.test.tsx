// SPDX-License-Identifier: AGPL-3.0-only
// The window before a golden exists: one line pointing at wsp init and nothing
// else, since the terminal owns the whole onboarding; the shell the moment a
// golden is there.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldenManifest, WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_golden-v1", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "claude --version", exitCode: 0 } }],
};
const first: WorkspaceView = { id: "ws_first", name: "first", machineId: "m_fork", phase: "running", golden: "snap_golden-v1", createdAt: "t" };
const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] };

function fakeApi(opts: { golden?: GoldenManifest; workspaces?: WorkspaceView[] }) {
  return {
    listWorkspaces: vi.fn(async () => opts.workspaces ?? []),
    getWorkspace: vi.fn(async () => first),
    createWorkspace: vi.fn(async () => first),
    createFromGoldenHead: vi.fn(async () => first),
    watchStatuses: vi.fn(async () => []),
    nap: vi.fn(async () => first),
    wake: vi.fn(async () => first),
    upgrade: vi.fn(async () => first),
    rebuild: vi.fn(async () => first),
    capabilities: vi.fn(async () => CAPS),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    startSession: vi.fn(async () => ({ id: "s1", workspaceId: "ws_first", harness: "claude", status: "running" as const })),
    listSessions: vi.fn(async () => []),
    sessionHistory: vi.fn(async () => []),
    interruptSession: vi.fn(async () => "accepted" as const),
    listForwards: vi.fn(async () => []),
    stopForward: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    getGolden: vi.fn(async () => opts.golden),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: vi.fn(async () => null),
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
  } satisfies Api;
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
});
afterEach(cleanup);

async function mount(opts: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(opts);
  useStore.getState().bind(api);
  render(<Shell />);
  await waitFor(() => expect(api.getGolden).toHaveBeenCalled());
  return api;
}

describe("the window before a golden exists", () => {
  it("shows one line pointing at wsp init: no sidebar, no button, no builder, nothing to seal", async () => {
    await mount({});
    const line = await screen.findByText("No golden image yet. Run wsp init in a terminal; it opens this app when the machine is ready.");
    expect(line.tagName).toBe("P");
    expect(document.body.textContent).toBe(line.textContent);
    expect(screen.queryByText("Workspaces")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Save|seal|sign in|checklist|sk-ant|slr_live/i);
  });

  it("renders the shell with its sidebar the moment a golden exists, and the first workspace is selected", async () => {
    await mount({ golden: manifest, workspaces: [first] });
    await waitFor(() => expect(screen.getByText("Workspaces")).toBeDefined());
    expect(screen.queryByText(/No golden image yet/)).toBeNull();
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_first"));
  });
});
