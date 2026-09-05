// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort and permission pickers in the composer's context strip:
// filled from the runtime's harness catalog, a pick rides the next
// sessions.start and is remembered per workspace, a harness without a list
// has no such picker, and the header names what the running session uses.
// Base UI's menu never settles under jsdom (see composer-checkout.test), so
// the menu primitives are stood in by a plain open/closed context.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessCatalog, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";

vi.mock("../src/components/ui/menu.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Radio = createContext<{ value: string | null; pick: (value: string) => void }>({ value: null, pick: () => {} });
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
  const MenuItem = ({ children, onClick, ...props }: { children: ReactNode; onClick?: () => void; [key: string]: unknown }) => (
    <div role="menuitem" onClick={onClick} {...(props as Record<string, unknown>)}>{children}</div>
  );
  const MenuRadioGroup = ({ children, value, onValueChange }: { children: ReactNode; value: string | null; onValueChange: (value: string) => void }) => {
    const ctx = useContext(Ctx);
    return (
      <Radio.Provider value={{ value, pick: next => { onValueChange(next); ctx.set(false); } }}>
        <div role="group">{children}</div>
      </Radio.Provider>
    );
  };
  const MenuRadioItem = ({ children, value, ...props }: { children: ReactNode; value: string; [key: string]: unknown }) => {
    const radio = useContext(Radio);
    return (
      <div role="menuitemradio" aria-checked={radio.value === value} onClick={() => radio.pick(value)} {...(props as Record<string, unknown>)}>
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  const MenuSeparator = () => <hr />;
  return { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator };
});

import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { ThreadModelLabel } from "../src/shell/ThreadModelLabel.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { provideDaemonRoot, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_ROOT, LISTING, fakeWire, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  resetSurfaces();
  provideDaemonRoot(WS, DAEMON_ROOT);
  provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": { branch: { oid: "abc", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/root" } }));
  useComposerDraftStore.setState({ drafts: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {} });
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

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  models: [{ value: "claude-opus-5", label: "Opus 5" }, { value: "claude-sonnet-5", label: "Sonnet 5" }],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
  permissionModes: [{ value: "plan", label: "Plan", description: "Read and plan only" }, { value: "bypassPermissions", label: "Bypass", isDefault: true }],
};

function fixtureApi(catalogs: HarnessCatalog[], history: SessionEvent[] = [], sessions: SessionView[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const api: Api = {
    listHarnesses: async () => catalogs,
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    upgrade: async () => workspace,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
    listSessions: async () => sessions,
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspace,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  return { api, started };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {}, harnesses: [] });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const picker = (kind: string) => document.querySelector<HTMLElement>(`[data-composer-picker="${kind}"]`);
const pickerValue = (kind: string) => picker(kind)?.dataset["value"];
const option = (value: string) => document.querySelector<HTMLElement>(`[data-composer-option="${value}"]`);

describe("composer pickers", () => {
  it("renders the harness catalog, and a pick rides the next start", async () => {
    const { api, started } = fixtureApi([CLAUDE]);
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    expect(picker("model")?.textContent).toContain("Model");
    expect(picker("effort")?.textContent).toContain("Effort");
    // The catalog's default is what runs when nothing is picked, so the label says so.
    expect(picker("permissionMode")?.textContent).toContain("Bypass");
    expect(pickerValue("permissionMode")).toBe("bypassPermissions");

    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.getAllByRole("menuitemradio").map(el => el.textContent)).toEqual(["Opus 5", "Sonnet 5"]);
    fireEvent.click(option("claude-opus-5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(picker("model")?.textContent).toContain("Opus 5");

    fireEvent.click(screen.getByRole("button", { name: /^Effort/ }));
    fireEvent.click(option("high")!);
    await waitFor(() => expect(pickerValue("effort")).toBe("high"));

    fireEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(screen.getByText("Read and plan only")).toBeTruthy();
    expect(option("bypassPermissions")?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(option("plan")!);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "go", model: "claude-opus-5", effort: "high", permissionMode: "plan" });
  });

  it("sends nothing for a picker left alone, so the CLI's own default applies", async () => {
    const { api, started } = fixtureApi([CLAUDE]);
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.model).toBeUndefined();
    expect(started[0]?.effort).toBeUndefined();
    expect(started[0]?.permissionMode).toBeUndefined();
  });

  it("remembers the last pick per workspace across a remount", async () => {
    const { api } = fixtureApi([CLAUDE]);
    const view = await setup(api);
    await waitFor(() => expect(picker("effort")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Effort/ }));
    fireEvent.click(option("low")!);
    await waitFor(() => expect(pickerValue("effort")).toBe("low"));
    expect(JSON.parse(window.localStorage.getItem("wsp:composer-options:v1") ?? "{}")).toMatchObject({ state: { byWorkspaceId: { [WS]: { effort: "low" } } } });
    view.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(pickerValue("effort")).toBe("low"));
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_other"]).toBeUndefined();
  });

  it("a harness whose CLI lacks a flag has no such picker, and the running session's values show while a turn streams", async () => {
    const pi: HarnessCatalog = { harness: "pi", label: "Pi", models: [], efforts: [{ value: "high", label: "High" }], permissionModes: [] };
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "pi", status: "running", model: "google/gemini-2.5-pro", effort: "high" };
    const { api } = fixtureApi([CLAUDE, pi], CHAT_STREAM.slice(0, 2), [running]);
    await setup(api);
    await waitFor(() => expect(picker("effort")).not.toBeNull());
    expect(picker("model")).toBeNull();
    expect(picker("permissionMode")).toBeNull();
    expect(picker("effort")?.textContent).toContain("High");
  });

  it("shows nothing at all when the runtime serves no catalog for the harness", async () => {
    const { api } = fixtureApi([]);
    await setup(api);
    await waitFor(() => expect(screen.getByRole("button", { name: /Working folder/ })).toBeTruthy());
    expect(document.querySelector("[data-composer-picker]")).toBeNull();
  });
});

describe("thread model label", () => {
  it("names the model and effort of the workspace's latest session, effort omitted when none was asked", async () => {
    useStore.setState({ sessions: { [WS]: [{ id: "s1", workspaceId: WS, harness: "claude", status: "completed", model: "claude-sonnet-5" }, { id: "s2", workspaceId: WS, harness: "claude", status: "running", model: "claude-opus-5", effort: "high" }] } });
    render(<ThreadModelLabel workspaceId={WS} />);
    expect(screen.getByText("claude-opus-5")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    act(() => useStore.setState({ sessions: { [WS]: [{ id: "s3", workspaceId: WS, harness: "claude", status: "running", model: "claude-sonnet-5" }] } }));
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
    expect(screen.queryByText("high")).toBeNull();
    act(() => useStore.setState({ sessions: {} }));
    expect(document.querySelector("[data-thread-model]")).toBeNull();
  });
});
