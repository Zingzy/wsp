// SPDX-License-Identifier: AGPL-3.0-only
// The checkout row under the composer: before the first message it offers
// the folder and names its branch over the daemon wire, and the send starts
// the session in that folder; after a turn it is a label carrying the
// harness's own cwd, which the panes follow until pinned.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { selectRoot, useRootStore } from "../src/files/root.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { fakeWire, LISTING, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  resetSurfaces();
  useComposerDraftStore.setState({ drafts: {} });
});

const WS = CHAT_WS;
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};
const STATUS = { branch: { oid: "abc", head: "feature/panes", ahead: 0, behind: 0 }, entries: [], root: "/root/app" };

function fixtureApi(history: SessionEvent[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string; cwd?: string }> = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    upgrade: async () => workspace,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true }),
    listSessions: async () => [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspace,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
}

const row = () => document.querySelector<HTMLElement>("[data-composer-checkout]");
const folder = () => document.querySelector<HTMLElement>("[data-composer-folder]")?.dataset["composerFolder"];
const branch = () => document.querySelector<HTMLElement>("[data-composer-branch]")?.dataset["composerBranch"];
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS);

describe("composer checkout row", () => {
  it("offers the folder before the first message, names its branch, and starts the session there", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi();
    await setup(api);
    expect(row()?.dataset["pickable"]).toBe("true");
    expect(folder()).toBe(".");
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    expect(screen.getByRole("button", { name: "Working folder: ~" })).toBeTruthy();

    // Base UI menus do not open under jsdom, so the pick lands the way a menu item does: on the store.
    act(() => useRootStore.getState().follow(WS, "/root/app"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Working folder: /root/app" })).toBeTruthy());
    expect(wire.calls.filter(([op]) => op === "git.status").map(([, p]) => p["cwd"])).toEqual([".", "/root/app"]);
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "build it here");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "build it here", cwd: "/root/app" });
  });

  it("sends no cwd while the folder is the daemon root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("is a label after a turn, carries the harness's cwd, and the panes follow it until pinned", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started, emit } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const editor = composerEditor();
    await typeInto(editor, "and now from the app");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: workspace.claudeSessionId, cwd: "/root" });

    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002", at: Date.now(), cwd: "/root/app" });
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(root()).toBe("/root/app");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0003", turnId: "turn_0003", at: Date.now(), cwd: "/root/app/packages/web" });
    await waitFor(() => expect(folder()).toBe("/root/app/packages/web"));
    expect(root()).toBe("/root/app");
  });
});
