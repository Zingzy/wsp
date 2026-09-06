// SPDX-License-Identifier: AGPL-3.0-only
// The checkout row under the composer: before the first message it offers
// the folder and names its branch over the daemon wire, across the same
// roots the panes browse, and the send starts the session in that folder;
// after a turn it is a label carrying the harness's own cwd, which the
// panes follow until pinned. Base UI's menu popup never settles under jsdom
// (its positioner loops and a close hangs the run), so the menu primitives
// are stood in by a plain open/closed context here and the picker's own
// browsing and picking run for real.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventUnion, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";

vi.mock("../src/components/ui/menu.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Menu = ({ children, open, onOpenChange }: { children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
    const [own, setOwn] = useState(false);
    const set = (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    };
    return <Ctx.Provider value={{ open: open ?? own, set }}>{children}</Ctx.Provider>;
  };
  const MenuTrigger = ({ children, render: _render, className, ...props }: { children: ReactNode; render?: unknown; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <button type="button" className={className} onClick={() => ctx.set(!ctx.open)} {...(props as Record<string, unknown>)}>
        {children}
      </button>
    );
  };
  const MenuPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="menu">{children}</div> : null);
  const MenuItem = ({ children, onClick, closeOnClick = true, disabled, ...props }: { children: ReactNode; onClick?: () => void; closeOnClick?: boolean; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <div
        role="menuitem"
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          onClick?.();
          if (closeOnClick) ctx.set(false);
        }}
        {...(props as Record<string, unknown>)}
      >
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  // Base UI's radio items hold the checked state and never close the menu; the stand-in does the same.
  const RadioCtx = createContext<{ value: unknown; change: (value: unknown) => void }>({ value: null, change: () => {} });
  const MenuRadioGroup = ({ children, value, onValueChange, ...props }: { children: ReactNode; value?: unknown; onValueChange?: (value: unknown) => void; [key: string]: unknown }) => (
    <div role="group" {...(props as Record<string, unknown>)}>
      <RadioCtx.Provider value={{ value, change: onValueChange ?? (() => {}) }}>{children}</RadioCtx.Provider>
    </div>
  );
  const MenuRadioItem = ({ children, value, ...props }: { children: ReactNode; value: unknown; [key: string]: unknown }) => {
    const ctx = useContext(RadioCtx);
    return (
      <div role="menuitemradio" aria-checked={ctx.value === value ? "true" : "false"} onClick={() => ctx.change(value)} {...(props as Record<string, unknown>)}>
        {children}
      </div>
    );
  };
  const MenuSeparator = () => <hr />;
  return { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator };
});

vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useNewThreadRequests } from "../src/components/chat/newThreadRequests.js";
import { selectRoot, useRootStore } from "../src/files/root.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_HELLO, DAEMON_ROOT, fakeWire, imported, LISTING, PROJECT_DEST, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  resetSurfaces();
  provideDaemonHello(WS, DAEMON_HELLO);
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
  claudeSessionId: "sess_0001",
};
/** The same workspace after one import: the picker browses home and the project folder. */
const withProject: WorkspaceView = { ...workspace, project: imported.project };
const STATUS = { branch: { oid: "abc", head: "feature/panes", ahead: 0, behind: 0 }, entries: [], root: "/root/app" };

function fixtureApi(history: SessionEvent[] = [], rows: SessionView[] = [], ws: WorkspaceView = workspace) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string; cwd?: string }> = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [ws],
    getWorkspace: async () => ws,
    createWorkspace: async () => ws,
    nap: async () => ws,
    wake: async () => ws,
    upgrade: async () => ws,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
    listSessions: async () => rows,
    watchStatuses: async () => [],
    createFromGoldenHead: async () => ws,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

async function setup(api: Api, threadId: string | null = null) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  render(<WorkspaceThread workspaceId={WS} threadId={threadId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
}

const row = () => document.querySelector<HTMLElement>("[data-composer-checkout]");
const folder = () => document.querySelector<HTMLElement>("[data-composer-folder]")?.dataset["composerFolder"];
const branch = () => document.querySelector<HTMLElement>("[data-composer-branch]")?.dataset["composerBranch"];
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS, [DAEMON_ROOT]);
const menuEntry = (path: string) => document.querySelector<HTMLElement>(`[data-composer-folder-entry="${path}"]`);
const menuPick = (path: string) => document.querySelector<HTMLElement>(`[data-composer-folder-pick="${path}"]`);
const menuRoots = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-composer-folder-root]")).map(el => [el.dataset["composerFolderRoot"], el.getAttribute("aria-checked")]);

describe("composer checkout row", () => {
  it("offers the folder before the first message, names its branch, and starts the session there", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi();
    await setup(api);
    expect(row()?.dataset["pickable"]).toBe("true");
    expect(folder()).toBe("/root");
    await waitFor(() => expect(branch()).toBe("feature/panes"));

    // The picker browses the daemon's listings from the daemon root down; the pick is the folder's absolute path.
    fireEvent.click(screen.getByRole("button", { name: "Working folder: /root" }));
    await waitFor(() => expect(menuEntry("/root/app")).not.toBeNull());
    expect(menuPick("/root")).not.toBeNull();
    expect(screen.queryByText(/Up to/)).toBeNull();
    expect(menuRoots()).toEqual([]);
    fireEvent.click(menuEntry("/root/app")!);
    await waitFor(() => expect(menuEntry("/root/app/lib")).not.toBeNull());
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual(["/root", "/root/app"]);
    fireEvent.click(menuPick("/root/app")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Working folder: /root/app" })).toBeTruthy());
    expect(wire.calls.filter(([op]) => op === "git.status").map(([, p]) => p["cwd"])).toEqual(["/root", "/root/app"]);
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "build it here");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "build it here", cwd: "/root/app" });
  });

  it("offers home and the imported project as roots, and browses and picks inside the project", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi([], [], withProject);
    await setup(api);
    expect(folder()).toBe("/root");

    fireEvent.click(screen.getByRole("button", { name: "Working folder: /root" }));
    await waitFor(() => expect(menuEntry("/root/app")).not.toBeNull());
    expect(menuRoots()).toEqual([["/root", "true"], [PROJECT_DEST, "false"]]);

    fireEvent.click(document.querySelector<HTMLElement>(`[data-composer-folder-root="${PROJECT_DEST}"]`)!);
    await waitFor(() => expect(menuEntry(`${PROJECT_DEST}/packages`)).not.toBeNull());
    expect(menuRoots()).toEqual([["/root", "false"], [PROJECT_DEST, "true"]]);
    expect(menuPick(PROJECT_DEST)).not.toBeNull();
    // Up stops at the project root, which the daemon browses; its parent is outside every root.
    expect(screen.queryByText(/Up to/)).toBeNull();

    fireEvent.click(menuEntry(`${PROJECT_DEST}/packages`)!);
    await waitFor(() => expect(menuEntry(`${PROJECT_DEST}/packages/web`)).not.toBeNull());
    expect(screen.getByText(/Up to/).textContent).toBe(`Up to ${PROJECT_DEST}`);
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual(["/root", PROJECT_DEST, `${PROJECT_DEST}/packages`]);

    fireEvent.click(menuPick(`${PROJECT_DEST}/packages`)!);
    await waitFor(() => expect(screen.getByRole("button", { name: `Working folder: ${PROJECT_DEST}/packages` })).toBeTruthy());
    const editor = composerEditor();
    await typeInto(editor, "work in the project");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "work in the project", cwd: `${PROJECT_DEST}/packages` });
  });

  it("starts an unpicked thread in the daemon root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBe("/root");
  });

  it("offers no picker and sends no cwd before the daemon named its root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    provideDaemonHello(WS, null);
    const { api, started } = fixtureApi();
    await setup(api);
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
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

  it("follows the agent's shell when a tool call moves it, while the strip keeps the harness folder, until pinned", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, emit } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const scope = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...scope, at: Date.now(), cwd: "/root" });
    emit({ type: "session.delta", ...scope, at: Date.now(), kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: JSON.stringify({ command: "cd /root/app && ls" }), cwd: "/root/app" });
    await waitFor(() => expect(root()).toBe("/root/app"));
    expect(folder()).toBe("/root");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    emit({ type: "session.delta", ...scope, at: Date.now(), kind: "tool_use", toolName: "Bash", toolUseId: "t2", text: JSON.stringify({ command: "cd /root/app/lib" }), cwd: "/root/app/lib" });
    await waitFor(() => expect(useRootStore.getState().byWorkspaceId[WS]?.shell).toBe("/root/app/lib"));
    expect(root()).toBe("/root/app");
    expect(folder()).toBe("/root");
    act(() => useRootStore.getState().unpin(WS));
    expect(root()).toBe("/root/app/lib");

    // The shell folder is the thread's: a new thread starts over from the harness folder.
    act(() => useNewThreadRequests.getState().request(WS));
    await waitFor(() => expect(root()).toBe("/root"));
  });

  it("explains the locked folder on hover and offers a new thread here with the picker open", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.getByText("The folder this thread's harness runs in. A cd inside the agent's shell does not move it; start a new thread to work from another folder.").getAttribute("role")).toBe("tooltip");

    fireEvent.click(screen.getByRole("button", { name: "New thread here" }));
    await waitFor(() => expect(row()?.dataset["pickable"]).toBe("true"));
    expect(screen.getByRole("button", { name: "Working folder: /root" })).toBeTruthy();
    await waitFor(() => expect(menuEntry("/root/app")).not.toBeNull());
    expect(menuPick("/root")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "New thread here" })).toBeNull();
  });
});

describe("composer checkout row on a thread resumed from its row", () => {
  const TAIL: SessionEvent[] = CHAT_STREAM.slice(1).map(e => ({ ...e, threadId: "thr_a" }));
  const ROW: SessionView = { id: "sess_0001", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_a", prompt: "hello", startedAt: 0, cwd: "/root/app" };

  it("pinned to a thread whose start fell off the cap, is a label for the row's folder and sends there, not where the person was following", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi(TAIL, [ROW]);
    act(() => useRootStore.getState().follow(WS, "/root/lib"));
    await setup(api, "thr_a");
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: "sess_0001", cwd: "/root/app" });
  });

  it("on an empty latest view, the remembered session resumes in its row's folder, the strip locked to it, not in the daemon root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi([], [ROW]);
    await setup(api);
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: "sess_0001", cwd: "/root/app" });
  });

  it("an empty latest view whose remembered session has no row keeps the picker: nothing names its folder", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi([], []);
    await setup(api);
    expect(row()?.dataset["pickable"]).toBe("true");
    expect(folder()).toBe("/root");
  });
});
