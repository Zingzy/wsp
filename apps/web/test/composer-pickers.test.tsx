// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort and access pickers inside the composer box: filled from
// the catalog the workspace's machine reports (the table until it answers,
// and marked when it never does), a pick rides the next sessions.start and is
// remembered per workspace, a model narrows the effort and context sections,
// favourites sort first, cmd-1 picks the first row, and the harness is
// pinned once the thread has a turn. Base UI's menu and popover never settle
// under jsdom (see composer-checkout.test), so both are stood in by a plain
// open/closed context.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const MenuRadioItem = ({ children, value, className: _c, ...props }: { children: ReactNode; value: string; className?: string; [key: string]: unknown }) => {
    const radio = useContext(Radio);
    return (
      <div role="menuitemradio" aria-checked={radio.value === value} onClick={() => radio.pick(value)} {...(props as Record<string, unknown>)}>
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  const MenuGroupLabel = ({ children }: { children: ReactNode }) => <div data-menu-label>{children}</div>;
  const MenuSeparator = () => <hr />;
  return { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator };
});

vi.mock("../src/components/ui/popover.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
    const [own, setOwn] = useState(false);
    const set = (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    };
    return <Ctx.Provider value={{ open: open ?? own, set }}>{children}</Ctx.Provider>;
  };
  const PopoverTrigger = ({ children, render: _render, className, ...props }: { children: ReactNode; render?: unknown; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <button type="button" className={className} onClick={() => ctx.set(!ctx.open)} {...(props as Record<string, unknown>)}>
        {children}
      </button>
    );
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFavouritesStore } from "../src/components/chat/composerFavouritesStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_HELLO, LISTING, fakeWire, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  resetSurfaces();
  provideDaemonHello(WS, DAEMON_HELLO);
  provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": { branch: { oid: "abc", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/root" } }));
  useComposerDraftStore.setState({ drafts: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {} });
  useComposerFavouritesStore.setState({ keys: [] });
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

const CONTEXT = [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }];
const MODES = [{ value: "plan", label: "Plan", description: "Read and plan only" }, { value: "bypassPermissions", label: "Bypass", description: "Run every tool without asking", isDefault: true }];

/** What the machine's binary reported. */
const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", description: "Best for everyday, complex tasks", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
    { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] },
  ],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
  contextWindows: CONTEXT,
  permissionModes: MODES,
};

/** The runtime's table, what stands before the machine answers. */
const TABLE: HarnessCatalog = {
  ...CLAUDE,
  source: "table",
  version: "claude --help 2.1.257, 2026-09-05",
  models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }],
};

const CODEX: HarnessCatalog = { harness: "codex", label: "Codex", source: "table", version: null, models: [{ value: "gpt-6-astra", label: "GPT-6 Astra" }], efforts: [{ value: "high", label: "High" }], contextWindows: [], permissionModes: [] };

function fixtureApi(opts: { table: HarnessCatalog[]; machine?: HarnessCatalog[] | Error; history?: ReadonlyArray<SessionEvent>; sessions?: SessionView[] }) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const listed: Array<string | undefined> = [];
  const api: Api = {
    listHarnesses: async workspaceId => {
      listed.push(workspaceId);
      if (workspaceId === undefined) return opts.table;
      if (opts.machine instanceof Error) throw opts.machine;
      return opts.machine ?? opts.table;
    },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [...(opts.history ?? [])],
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
    listSessions: async () => opts.sessions ?? [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspace,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async o => {
      started.push(o);
      return { id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running", prompt: o.prompt, startedAt: 0 };
    },
  };
  return { api, started, listed };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {} });
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
const modelMenu = () => document.querySelector<HTMLElement>("[data-composer-model-menu]");
const openModelMenu = async () => {
  fireEvent.click(picker("model")!);
  await waitFor(() => expect(modelMenu()).not.toBeNull());
  return modelMenu()!;
};

describe("composer pickers", () => {
  it("sit inside the composer box with the machine's catalog, read the defaults, and picks ride the next start", async () => {
    const { api, started, listed } = fixtureApi({ table: [TABLE, CODEX], machine: [CLAUDE, CODEX] });
    await setup(api);
    await waitFor(() => expect(document.querySelector('[data-composer-catalog-source], [data-composer-picker="model"][data-value]')).not.toBeNull());
    await waitFor(() => expect(listed).toContain(WS));
    const footer = document.querySelector("[data-chat-composer-footer]")!;
    expect(footer.contains(picker("model"))).toBe(true);
    expect(document.querySelector("[data-composer-checkout] [data-composer-picker]")).toBeNull();
    // Defaults read: the catalog's default model under the harness's mark, the default context, the default mode.
    expect(picker("model")?.textContent).toContain("Opus 5");
    expect(picker("model")?.querySelector('[data-harness-mark="claude"]')).not.toBeNull();
    expect(picker("effort")?.textContent).toBe("Effort · 1M");
    expect(picker("permissionMode")?.textContent).toContain("Bypass");
    expect(pickerValue("permissionMode")).toBe("bypassPermissions");

    // The model menu: the machine's three models with search, jump chips and stars; the footer names the source.
    const menu = await openModelMenu();
    await waitFor(() => expect(within(menu).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]));
    expect(within(menu).getByText("Best for everyday, complex tasks")).toBeTruthy();
    expect(within(menu).getAllByRole("option")[0]?.textContent).toMatch(/⌘1|Ctrl\+1/);
    expect(menu.querySelector("[data-composer-catalog-source]")?.textContent).toBe("Claude Code 2.1.257 on this machine");
    fireEvent.change(within(menu).getByLabelText("Search models"), { target: { value: "son" } });
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
    fireEvent.click(option("claude-sonnet-5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    expect(modelMenu()).toBeNull();
    // Sonnet takes no context window, so the effort button reads the effort alone.
    expect(picker("effort")?.textContent).toBe("Effort");

    fireEvent.click(option("claude-opus-5") ?? (await openModelMenu(), option("claude-opus-5")!));
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));

    // The effort menu: two sections, the default marked, and the button reads "<effort> · <context>".
    fireEvent.click(picker("effort")!);
    const effortMenu = await screen.findByRole("menu");
    expect(within(effortMenu).getAllByText(/^(Reasoning|Context Window)$/).map(el => el.textContent)).toEqual(["Reasoning", "Context Window"]);
    expect(option("1m")?.textContent).toContain("default");
    expect(option("high")?.textContent).not.toContain("default");
    fireEvent.click(option("high")!);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("High · 1M"));
    fireEvent.click(picker("effort")!);
    fireEvent.click(option("200k")!);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("High · 200k"));

    // The access menu: an icon and a line per mode, the default marked.
    fireEvent.click(picker("permissionMode")!);
    expect(screen.getByText("Read and plan only")).toBeTruthy();
    expect(option("bypassPermissions")?.getAttribute("aria-checked")).toBe("true");
    expect(option("bypassPermissions")?.querySelector("svg")).not.toBeNull();
    fireEvent.click(option("plan")!);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "go", model: "claude-opus-5", effort: "high", contextWindow: "200k", permissionMode: "plan" });
    expect(started[0]?.harness).toBeUndefined();
  });

  it("shows the table, marked so, until the machine answers, and keeps it when the machine never does", async () => {
    const { api } = fixtureApi({ table: [TABLE], machine: new Error("machine not running") });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const menu = await openModelMenu();
    expect(menu.querySelector("[data-composer-catalog-source]")?.textContent).toBe("From a table, binary did not answer · pinned to claude --help 2.1.257, 2026-09-05");
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
  });

  it("sends nothing for a picker left alone; a context window pick brings the model it rides on", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("effort")).not.toBeNull());
    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.model).toBeUndefined();
    expect(started[0]?.effort).toBeUndefined();
    expect(started[0]?.permissionMode).toBeUndefined();
    expect(started[0]?.contextWindow).toBeUndefined();
  });

  it("a context window pick alone brings the model it rides on", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("effort")).not.toBeNull());
    fireEvent.click(picker("effort")!);
    fireEvent.click(option("1m")!);
    await waitFor(() => expect(picker("effort")?.dataset["contextWindow"]).toBe("1m"));
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ model: "claude-opus-5", contextWindow: "1m" });
    expect(started[0]?.effort).toBeUndefined();
  });

  it("a model narrows the sections: Haiku takes no effort and no context, so the effort picker goes and a stale effort pick is not sent", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    useComposerOptionsStore.setState({ byWorkspaceId: { [WS]: { effort: "high", model: "claude-haiku-4-5" } } });
    await setup(api);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-haiku-4-5"));
    expect(picker("effort")).toBeNull();
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(started[0]?.effort).toBeUndefined();
  });

  it("favourites sort first and persist across workspaces; cmd-1 picks the first row", async () => {
    const { api } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    let menu = await openModelMenu();
    fireEvent.click(menu.querySelector('[data-composer-favourite="claude-sonnet-5"]')!);
    await waitFor(() => expect(within(menu).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]));
    expect(menu.querySelector('[data-composer-favourite="claude-sonnet-5"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("wsp:composer-favourites:v1") ?? "{}")).toMatchObject({ state: { keys: ["claude:claude-sonnet-5"] } });
    // The star did not pick.
    expect(pickerValue("model")).toBe("claude-opus-5");
    fireEvent.keyDown(menu, { key: "1", metaKey: true });
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    expect(modelMenu()).toBeNull();
    menu = await openModelMenu();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));
  });

  it("remembers the last pick per workspace across a remount", async () => {
    const { api } = fixtureApi({ table: [CLAUDE] });
    const view = await setup(api);
    await waitFor(() => expect(picker("effort")).not.toBeNull());
    fireEvent.click(picker("effort")!);
    fireEvent.click(option("low")!);
    await waitFor(() => expect(pickerValue("effort")).toBe("low"));
    expect(JSON.parse(window.localStorage.getItem("wsp:composer-options:v1") ?? "{}")).toMatchObject({ state: { byWorkspaceId: { [WS]: { effort: "low" } } } });
    view.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(pickerValue("effort")).toBe("low"));
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_other"]).toBeUndefined();
  });

  it("pins the harness once the thread has a turn: another one answers with one line and changes nothing; before a turn the rail switches", async () => {
    const pinned = fixtureApi({ table: [CLAUDE, CODEX], history: CHAT_STREAM, sessions: [{ id: "s0", workspaceId: WS, harness: "claude", status: "completed" }] });
    const view = await setup(pinned.api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    let menu = await openModelMenu();
    const codex = () => menu.querySelector<HTMLButtonElement>('[data-composer-harness="codex"]')!;
    expect(menu.querySelector<HTMLButtonElement>('[data-composer-harness="claude"]')?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(codex());
    await waitFor(() => expect(within(menu).getByRole("status").textContent).toBe("Start a new thread to use Codex here"));
    expect(picker("model")?.dataset["harness"]).toBe("claude");
    expect(useComposerOptionsStore.getState().byWorkspaceId[WS]?.harness).toBeUndefined();
    view.unmount();

    const fresh = fixtureApi({ table: [CLAUDE, CODEX] });
    await setup(fresh.api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    menu = await openModelMenu();
    fireEvent.click(codex());
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("codex"));
    // The rail stays and the list is Codex's; the model button reads its name until one is picked, since Codex marks no default.
    expect(picker("model")?.textContent).toContain("Model");
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["gpt-6-astra"]));
    fireEvent.click(option("gpt-6-astra")!);
    await waitFor(() => expect(pickerValue("model")).toBe("gpt-6-astra"));
  });

  it("shows the running session's values while a turn streams, the CLI's 1M suffix read as the context window", async () => {
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "claude", status: "running", model: "claude-opus-5[1m]", effort: "low", permissionMode: "plan" };
    const { api } = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running] });
    await setup(api);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("Low · 1M"));
    expect(pickerValue("model")).toBe("claude-opus-5");
    expect(pickerValue("permissionMode")).toBe("plan");
  });

  it("shows nothing at all when the runtime serves no catalog for the harness", async () => {
    const { api } = fixtureApi({ table: [] });
    await setup(api);
    await waitFor(() => expect(screen.getByRole("button", { name: /Working folder/ })).toBeTruthy());
    expect(document.querySelector("[data-composer-picker]")).toBeNull();
  });
});
