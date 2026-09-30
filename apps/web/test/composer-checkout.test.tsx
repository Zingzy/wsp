// SPDX-License-Identifier: AGPL-3.0-only
// The checkout row under the composer: a label naming the folder, never a
// picker, and its branch read over the daemon wire; before the first message
// the folder is the one the next start opens, after a turn the harness's own
// cwd, which the panes follow until pinned. Base UI's menu popup never
// settles under jsdom (its positioner loops and a close hangs the run), so
// the menu primitives are stood in by a plain open/closed context here.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventUnion, type PlaceView, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";

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
  // Base UI renders the element the trigger is handed, so the stand-in clones it rather than painting a bare button:
  // the trigger a test reads then carries the same merged classes the app's does, the button's own among them.
  const MenuTrigger = ({ children, render: element, className, ...props }: { children: ReactNode; render?: ReactElement<Record<string, unknown>>; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    const own = { className, onClick: () => ctx.set(!ctx.open), ...(props as Record<string, unknown>) };
    return element === undefined ? <button type="button" {...own}>{children}</button> : cloneElement(element, own, children);
  };
  // Base UI dismisses the popup on an Escape that reaches it, which is the whole of what a field inside one must
  // not swallow, so the stand-in does the same.
  const MenuPopup = ({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) => {
    const ctx = useContext(Ctx);
    return ctx.open ? (
      <div role="menu" className={className} style={style} onKeyDown={e => (e.key === "Escape" ? ctx.set(false) : undefined)}>
        {children}
      </div>
    ) : null;
  };
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
  // The app's kit closes the menu on a radio pick unless the caller says otherwise; the stand-in does the same.
  const RadioCtx = createContext<{ value: unknown; change: (value: unknown) => void }>({ value: null, change: () => {} });
  const MenuRadioGroup = ({ children, value, onValueChange, ...props }: { children: ReactNode; value?: unknown; onValueChange?: (value: unknown) => void; [key: string]: unknown }) => (
    <div role="group" {...(props as Record<string, unknown>)}>
      <RadioCtx.Provider value={{ value, change: onValueChange ?? (() => {}) }}>{children}</RadioCtx.Provider>
    </div>
  );
  const MenuRadioItem = ({ children, value, closeOnClick = true, ...props }: { children: ReactNode; value: unknown; closeOnClick?: boolean; [key: string]: unknown }) => {
    const radio = useContext(RadioCtx);
    const menu = useContext(Ctx);
    return (
      <div
        role="menuitemradio"
        aria-checked={radio.value === value ? "true" : "false"}
        onClick={() => {
          radio.change(value);
          if (closeOnClick) menu.set(false);
        }}
        {...(props as Record<string, unknown>)}
      >
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
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useNewThreadRequests } from "../src/components/chat/newThreadRequests.js";
import { selectRoot, useRootStore } from "../src/files/root.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_HELLO, DAEMON_ROOT, fakeWire, LISTING, PROJECT_DEST, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

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
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "sess_0001",
};
/** The same workspace after one import: the picker browses home and the project folder. */
const withProject: WorkspaceView = { ...workspace, project: { id: "pr_wsp", name: "wsp", path: PROJECT_DEST, computer: "default" } };
const STATUS = { branch: { oid: "abc", head: "feature/panes", ahead: 0, behind: 0 }, entries: [], root: "/root/app" };

function fixtureApi(history: SessionEvent[] = [], rows: SessionView[] = [], ws: WorkspaceView = workspace) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; thread?: string; cwd?: string; project?: string }> = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [ws],
    getWorkspace: async () => ws,
    createWorkspace: async () => ws,
    nap: async () => ws,
    wake: async () => ws,
    capabilities: async () => (caps()),
    listSessions: async () => rows,
    listHarnesses: async () => [TABLE_CATALOG],
    watchStatuses: async () => [],
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
  await whenAgentsAnswered();
  render(<WorkspaceThread workspaceId={WS} threadId={threadId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
}

const row = () => document.querySelector<HTMLElement>("[data-composer-checkout]");
const folder = () => document.querySelector<HTMLElement>("[data-composer-folder]")?.dataset["composerFolder"];
const branchSlot = () => document.querySelector<HTMLElement>("[data-composer-branch]");
const branch = () => branchSlot()?.dataset["composerBranch"];
const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";
/** The height pair every item of the row carries; an empty slot with it keeps the row from moving. */
const SLOT_HEIGHT = ["h-7", "sm:h-6"];
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS, [DAEMON_ROOT]);

describe("composer checkout row", () => {
  it("names the computer first, then the access and the branch, every item in one grammar, and neither the folder's path nor a pull request's number", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) }));
    const { api } = fixtureApi();
    await setup(api);
    expect(row()?.dataset["opening"]).toBe("true");
    // The folder the start opens is still what the row reads, though it no longer says it.
    expect(folder()).toBe("/root");
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    const items = ([...row()!.children] as HTMLElement[]).filter(item => item.getAttribute("role") !== "tooltip");
    expect(items[0]!.matches("[data-composer-computer]")).toBe(true);
    expect(items.at(-1)!.matches("[data-composer-branch]")).toBe(true);
    for (const item of items) {
      expect(item.className.split(" "), item.outerHTML.slice(0, 80)).toEqual(expect.arrayContaining(["h-7", "sm:h-6", "px-2", "text-xs", "text-muted-foreground"]));
      expect(item.className).not.toContain("font-mono");
      expect(item.className.split(" ").filter(c => /^(\w+:)*text-(\[\d|xs|sm|base)/.test(c))).toEqual(["text-xs"]);
    }
    expect(row()!.className.split(" ")).toContain("gap-1");
    expect(row()!.textContent).not.toMatch(/\/root|#\d/);
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
  });

  it("shows no branch word for a copy on a detached head", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": { ...STATUS, branch: { ...STATUS.branch, head: "(detached)" } } }));
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("detached"));
    expect(branchSlot()!.textContent).toBe("");
    expect(branchSlot()!.querySelector("svg")).toBeNull();
    expect(document.body.textContent).not.toContain("(detached)");
  });

  it("names a repository's branch with the glyph beside it and says on hover that it is read, not switched", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).not.toBeNull();
    expect(slot.textContent).toBe("feature/panes");
    expect(screen.getByText(BRANCH_NOTE).getAttribute("role")).toBe("tooltip");
  });

  it("leaves the branch slot empty when the machine could not read the folder's git state, before the first message, and nothing shifts", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => Object.assign(new Error("outside the browsable roots"), { code: "outside-root" }) });
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("refused"));
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
    expect(folder()).toBe("/root");
  });

  it("leaves the slot empty beside the locked label once a turn exists: a dropped wire is a read that failed too", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": () => new Error("socket closed") }));
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["opening"]).toBeUndefined();
    await waitFor(() => expect(branch()).toBe("refused"));
    const slot = branchSlot()!;
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
  });

  it("asks again every time the link changes its word, so a read made before it was up is not the row's last word", async () => {
    // The wire is there from the first paint and the link is up a moment later; asked once, the row kept the
    // refusal from that first read for the whole of a session, on a folder it could read fine.
    let up = false;
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => (up ? STATUS : new Error("not answering")) });
    provideDaemonWire(WS, wire);
    const terminals = new WorkspaceTerminals(wire);
    provideTerminals(WS, terminals);
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(branch()).toBe("refused"));
    up = true;
    act(() => terminals.feedStatus("live"));
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    expect(branchSlot()?.textContent).toBe("feature/panes");
    provideTerminals(WS, null);
  });

  it("asks again as a running turn moves while the branch is not known, and shows nothing but the branch", async () => {
    // A thread opened on a copy that is still being made asks before the copy's folder is there; the turn then runs,
    // and a row that held that first failure for the whole turn printed its placeholder word over a copy on main.
    let made = false;
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => (made ? { ...STATUS, branch: { ...STATUS.branch, head: "main" } } : Object.assign(new Error("/root is not there"), { code: "not-found" })) });
    provideDaemonWire(WS, wire);
    const { api, emit } = fixtureApi(CHAT_STREAM.slice(0, 3));
    await setup(api);
    await screen.findByText(/then starting it\./);
    await waitFor(() => expect(wire.calls.some(([op]) => op === "git.status")).toBe(true));
    await settle();
    expect(branchSlot()!.textContent).toBe("");
    made = true;
    emit(CHAT_STREAM[3]! as unknown as EventUnion);
    await waitFor(() => expect(branch()).toBe("main"));
    expect(branchSlot()!.textContent).toBe("main");
  });

  it("keeps the read in flight while a running turn moves, and asks again only once it has settled", async () => {
    // A cloud copy answers in a few hundred ms and a turn can add entries faster than that; dropping the read on
    // every entry meant no answer landed until the turn ended, and one git status went out per entry.
    const inner = fakeWire({ "fs.list": LISTING });
    const answers: Array<(reply: Record<string, unknown>) => void> = [];
    const wire: TerminalWire = { request: (op, params) => (op === "git.status" ? new Promise(resolve => answers.push(resolve)) : inner.request(op, params)) };
    provideDaemonWire(WS, wire);
    const { api, emit } = fixtureApi(CHAT_STREAM.slice(0, 3));
    await setup(api);
    await screen.findByText(/then starting it\./);
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    const asked = answers.length;
    emit(CHAT_STREAM[3]! as unknown as EventUnion);
    emit(CHAT_STREAM[4]! as unknown as EventUnion);
    await settle();
    expect(answers.length).toBe(asked);
    act(() => answers[asked - 1]!({ ...STATUS, branch: { ...STATUS.branch, head: "main" } }));
    await waitFor(() => expect(branch()).toBe("main"));
    await settle();
    expect(answers.length).toBeLessThanOrEqual(asked + 1);
  });

  it("leaves the branch slot empty, no glyph and no words, while the ask is still out", async () => {
    const inner = fakeWire({ "fs.list": LISTING });
    const wire: TerminalWire = { request: (op, params) => (op === "git.status" ? new Promise(() => {}) : inner.request(op, params)) };
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await settle();
    const slot = branchSlot()!;
    expect(branch()).toBe("unknown");
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
    expect(folder()).toBe("/root");
  });

  it("leaves the branch slot empty for a folder outside any repository", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => Object.assign(new Error("not a git repository"), { code: "not-a-git-repo" }) });
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("none"));
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.queryByText("no repository")).toBeNull();
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
  });

  it("starts an unpicked thread naming no folder at all: the runtime opens it in the workspace's project, which is the folder under the box", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) }));
    const { api, started } = fixtureApi([], [], withProject);
    await setup(api);
    expect(folder()).toBe(PROJECT_DEST);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.project).toBeUndefined();
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("on this computer the line names the workspace's own folder, the one the runtime publishes, not the home the daemon browses from, and the start still names nothing", async () => {
    const WORK = "/Users/dev/wsp-work";
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: "/Users/dev" });
    provideDaemonWire(WS, fakeWire({ "fs.list": () => ({ entries: [], truncated: false, total: 0 }), "git.status": () => Object.assign(new Error("not a git repository"), { code: "not-a-git-repo" }) }));
    const { api, started } = fixtureApi([], [], { ...workspace, kind: "local", machineId: "local", project: { id: "pr_1", name: "the-project", path: WORK, computer: "default" }, golden: "", folder: WORK });
    await setup(api);
    expect(folder()).toBe(WORK);
    // The computer's icon is the one the Computers page draws for it, the person's own pick included.
    const here: PlaceView = { id: "here", kind: "computer", name: "dev-mbp", label: "dev's MacBook Pro", mac: "macbook", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 1024 ** 3 };
    act(() => useStore.setState({ places: [here] }));
    const glyph = () => row()!.querySelector("[data-composer-computer] [data-computer-glyph]")?.getAttribute("data-computer-glyph");
    await waitFor(() => expect(glyph()).toBe("laptop"));
    act(() => useStore.setState(s => ({ preferences: { ...s.preferences, computerLook: { here: { icon: "home" } } } })));
    expect(glyph()).toBe("home");
    act(() => useStore.setState({ places: [] }));
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
    expect(started[0]?.project).toBeUndefined();
  });

  it("starts an unpicked thread on a workspace without projects naming no folder, so the runtime's rule lands it in the machine's own, the one the line under the box shows", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi();
    await setup(api);
    expect(folder()).toBe("/root");
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
    expect(started[0]?.project).toBeUndefined();
  });

  it("sends no cwd before the daemon named its root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    provideDaemonHello(WS, null);
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
    const { api, started, emit } = fixtureApi(CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" })));
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["opening"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const editor = composerEditor();
    await typeInto(editor, "and now from the app");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ thread: "thr_a", cwd: "/root" });

    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_a", at: Date.now(), cwd: "/root/app" });
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(root()).toBe("/root/app");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0003", turnId: "turn_0003", threadId: "thr_a", at: Date.now(), cwd: "/root/app/packages/web" });
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

  it("keeps a long folder off the row on a thread that has run, and offers no new-thread button", async () => {
    const LONG = "/var/folders/xx/90zsjs6n7yjgw9bb1vp6_tx00000gn/T/checkouts/acme-platform/services/gateway-and-edge-router";
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi(CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, cwd: LONG } : e))).api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["opening"]).toBeUndefined();
    expect(folder()).toBe(LONG);
    expect(row()!.textContent).not.toContain("gateway-and-edge-router");
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
    expect(row()?.dataset["opening"]).toBeUndefined();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ thread: "thr_a", cwd: "/root/app" });
  });

  it("on an empty latest view, the send goes into the remembered session's thread in its row's folder, the strip locked to it, not in the daemon root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi([], [ROW]);
    await setup(api);
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(row()?.dataset["opening"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ thread: "thr_a", cwd: "/root/app" });
  });

  it("an empty latest view whose remembered session has no row names the folder the next start opens: no turn names one", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi([], []);
    await setup(api);
    expect(row()?.dataset["opening"]).toBe("true");
    expect(folder()).toBe("/root");
  });
});
