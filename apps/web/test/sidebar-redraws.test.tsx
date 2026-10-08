// SPDX-License-Identifier: AGPL-3.0-only
// Neither a keystroke in the composer nor a trip to Settings and back draws a sidebar tile again: the owner saw
// every tile redrawn while typing, and Settings back to a long thread blocked the window for 3.8 s rebuilding the
// sidebar and the thread. The shell, the sidebar's tiles and the thread's composer are the real ones; ThreadTile is
// counted where the sidebar draws it.
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ tiles: 0 }));
vi.mock("../src/sidebar/ThreadTile.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/sidebar/ThreadTile.js")>();
  return {
    ...real,
    ThreadTile: (props: Parameters<typeof real.ThreadTile>[0]) => {
      drawn.tiles++;
      return real.ThreadTile(props);
    },
  };
});
vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import type { HarnessCatalog, ProjectView, SessionView, WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AppShell } from "../src/shell/AppShell.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { caps } from "./caps.js";
import { composerEditor, typeInto } from "./composer-harness.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { installFakeLayout } from "./fake-layout.js";

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {} });
});

const WS = "ws_a";
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};
const PROJECT: ProjectView = { id: "pr_1", name: "the-project", computer: "default", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/acme/lab.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" };
const CLAUDE: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };
const thread = (n: number, status: SessionView["status"]): SessionView => ({ id: `s${n}`, workspaceId: WS, harness: "claude", status, prompt: `thread number ${n}`, threadId: `thr_${n}`, startedAt: n });
const SESSIONS = [thread(1, "running"), thread(2, "completed"), thread(3, "completed")];

const api: Api = {
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  nap: async () => workspace,
  wake: async () => workspace,
  capabilities: async () => caps(),
  listSessions: async () => SESSIONS,
  listHarnesses: async () => [CLAUDE],
  watchStatuses: async () => [],
  subscribe: () => () => {},
  getGolden: async () => undefined,
  projectsList: async () => [PROJECT],
  startSession: async o => ({ id: "s9", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
};

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 50)));

async function mount(): Promise<HTMLElement> {
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  render(
    <AppShell>
      <WorkspaceThread workspaceId={WS} />
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
  act(() => useStore.getState().select(WS, "thr_1"));
  await waitFor(() => expect(document.querySelectorAll("[data-slot=sidebar] [data-thread-tile], [data-slot=sidebar] [data-row-id^='thr']").length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return composerEditor();
}

describe("the sidebar's tiles", () => {
  it("are not drawn again by a keystroke in the composer", async () => {
    const editor = await mount();
    await typeInto(editor, "a");
    const before = drawn.tiles;
    expect(before).toBeGreaterThanOrEqual(SESSIONS.length);
    for (const ch of "bcdefghij") await typeInto(editor, ch);
    expect(editor.textContent).toBe("abcdefghij");
    expect(drawn.tiles - before).toBe(0);
  });

  it("are not drawn again by Settings and back, and the thread's composer is the one it was", async () => {
    const editor = await mount();
    const before = drawn.tiles;
    act(() => useStore.getState().openSettings());
    await settle();
    act(() => useStore.getState().closeSettings());
    await settle();
    expect(drawn.tiles - before).toBe(0);
    expect(composerEditor()).toBe(editor);
  });
});
