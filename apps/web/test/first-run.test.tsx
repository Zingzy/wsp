// SPDX-License-Identifier: AGPL-3.0-only
// The window with no golden: the shell as always, since this computer is a
// workspace of its own, and at the sidebar's bottom one quiet row that opens
// the way to cloud machines; with a golden sealed the row is not there.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, type GoldenManifest, type WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_golden-v1", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "claude --version", exitCode: 0 } }],
};
const first: WorkspaceView = { id: "ws_first", name: "first", machineId: "m_fork", phase: "running", golden: "snap_golden-v1", createdAt: "t" };
const local: WorkspaceView = { id: "ws_local", name: "thisbox", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: "t" };
const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, kept: false, sizes: [] };

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
  useStore.setState({ api: null, capabilities: null, hasGolden: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
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
  it("is the shell on this computer, with one muted mono row at the sidebar's bottom for the cloud", async () => {
    await mount({ workspaces: [local] });
    await waitFor(() => expect(screen.getByText("Workspaces")).toBeDefined());
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_local"));
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.closest("[data-slot=sidebar-footer]")).not.toBeNull();
    // A hairline above parts it from the list; the words are centred mono, muted, one tone up on hover.
    expect(row.parentElement?.className).toContain("border-t");
    expect(row.className).toContain("justify-center");
    expect(row.className).toContain("font-mono");
    expect(row.className).toContain("text-sidebar-muted-foreground");
    expect(row.className).toContain("hover:text-sidebar-foreground");
    expect(row.textContent).toBe(CLOUD_SETUP_WORDS.row);
    // One cloud glyph, the halo on it alone: no glow class on the row, no badge, nothing animated at rest.
    const glyphs = row.querySelectorAll("svg");
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.classList.contains("lucide-cloud")).toBe(true);
    expect(glyphs[0]!.className.baseVal).toContain("drop-shadow-");
    expect(row.className).not.toContain("drop-shadow");
    expect(row.className).not.toMatch(/animate-|translate|scale-/);
    expect(row.querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    expect(screen.queryByText(/No golden image yet/)).toBeNull();
  });

  it("the row opens the init instructions in a dialog, and closing it leaves the shell as it was", async () => {
    await mount({ workspaces: [local] });
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.title);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.noGolden);
    expect(dialog.textContent).not.toMatch(/sk-ant|slr_live/);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeDefined();
  });

  it("with a golden sealed the row is not there, and the first workspace is selected", async () => {
    await mount({ golden: manifest, workspaces: [first] });
    await waitFor(() => expect(screen.getByText("Workspaces")).toBeDefined());
    await waitFor(() => expect(useStore.getState().hasGolden).toBe(true));
    expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull();
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_first"));
  });
});
