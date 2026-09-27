// SPDX-License-Identifier: AGPL-3.0-only
// The page's side of a wsp:// link: a thread opens on the workspace its row is
// on, a workspace, a project's home and a Settings group each open, a link to
// nothing here says so, and nothing a link names is ever sent or started.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkTarget, ProjectView, SessionView, WorkspaceView } from "@wsp/protocol";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { LINK_WORDS, openLink, wireLinks } from "../src/shell/links.js";

const AT = "2026-09-27T09:00:00.000Z";
const workspace = (id: string): WorkspaceView => ({ id, name: id, machineId: `m_${id}`, kind: "local", project: { id: "pr_spoo", name: "spoo", path: "/Users/dev/spoo", computer: "here" }, phase: "running", golden: "", createdAt: AT });
const row = (workspaceId: string, threadId: string): SessionView => ({ id: `s_${threadId}`, workspaceId, threadId, harness: "claude", status: "completed", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 }) as SessionView;
const project: ProjectView = { id: "pr_spoo", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", remote: "", defaultBranch: "main", memoryKey: "k", memoryDir: "/m", createdAt: AT };

const sends = { send: vi.fn(), run: vi.fn(), startThread: vi.fn() };

beforeEach(() => {
  useNotices.getState().clear();
  useStore.setState({ api: sends as never, ready: true, projectsRead: true, workspaces: [workspace("ws_a"), workspace("ws_b")], projects: [project], sessions: { ws_a: [row("ws_a", "th_one")], ws_b: [row("ws_b", "th_two")] }, selectedId: "ws_a", selectedThreadId: null, settingsOpen: false, projectHome: null });
});

afterEach(() => {
  delete window.wsp;
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

const errors = (): string[] => useNotices.getState().notices.filter(n => n.kind === "error").map(n => n.text);
const open = (target: LinkTarget): void => openLink(useStore, target);

describe("a wsp:// link on the page", () => {
  it("opens a thread on the workspace its row is on, and sends nothing into it", () => {
    open({ kind: "thread", id: "th_two" });
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "th_two", settingsOpen: false });
    expect(window.location.hash).toBe("#w/ws_b/t/th_two");
    for (const act of Object.values(sends)) expect(act).not.toHaveBeenCalled();
  });

  it("opens a workspace, a project's home and a Settings group", () => {
    open({ kind: "workspace", id: "ws_b" });
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null });
    open({ kind: "project", id: "pr_spoo" });
    expect(useStore.getState()).toMatchObject({ selectedId: null, projectHome: "pr_spoo" });
    open({ kind: "settings", id: "keybindings" });
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "keybindings" });
    expect(errors()).toEqual([]);
  });

  it("says in one line when what it names is not here, and moves nothing", () => {
    open({ kind: "thread", id: "th_gone" });
    open({ kind: "workspace", id: "ws_gone" });
    open({ kind: "project", id: "pr_gone" });
    open({ kind: "settings", id: "general" });
    open({ kind: "settings", id: "nowhere" });
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", settingsOpen: false, projectHome: null });
    expect(errors().toReversed()).toEqual([LINK_WORDS.gone("thread"), LINK_WORDS.gone("workspace"), LINK_WORDS.gone("project"), LINK_WORDS.gone("settings"), LINK_WORDS.gone("settings")]);
    expect(LINK_WORDS.gone("thread")).toBe("That link names a thread this wsp does not have.");
  });

  it("opens the link the first page's hash carries once the rows have landed, and only once", async () => {
    window.history.replaceState(null, "", "/#open/thread/th_two");
    useStore.setState({ ready: false });
    const stop = wireLinks(useStore);
    expect(useStore.getState().selectedId).toBe("ws_a");
    useStore.setState({ ready: true });
    await Promise.resolve();
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "th_two" });
    useStore.getState().select("ws_a");
    useStore.setState({ ready: true, projectsRead: true, workspaces: [...useStore.getState().workspaces] });
    await Promise.resolve();
    expect(useStore.getState().selectedId).toBe("ws_a");
    stop();
  });

  it("opens the held link after the first refresh has written its own address, so the address names the thread", async () => {
    window.history.replaceState(null, "", "/#open/thread/th_two");
    const rows = [row("ws_a", "th_one"), row("ws_b", "th_two")];
    useStore.setState({ ready: false, sessions: {}, selectedId: null, api: { ...sends, listWorkspaces: async () => [workspace("ws_a"), workspace("ws_b")], listSessions: async () => rows } as never });
    const stop = wireLinks(useStore);
    await useStore.getState().refresh();
    await Promise.resolve();
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "th_two" });
    expect(window.location.hash).toBe("#w/ws_b/t/th_two");
    stop();
  });

  it("opens each link the shell hands over while the page is up, and stops listening when unmounted", () => {
    let handler: ((target: LinkTarget) => void) | undefined;
    const off = vi.fn();
    window.wsp = { onOpen: fn => ((handler = fn), off) };
    const stop = wireLinks(useStore);
    handler!({ kind: "thread", id: "th_two" });
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "th_two" });
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
});
