// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort and access pickers inside the composer box: filled from
// the catalog the workspace's machine reports (the table until it answers,
// and marked when it never does), a new thread opens on the defaults read by
// the one rule, a pick rides the draft's sessions.start and goes with it, the
// access pick on the host's own record and into
// a running turn where its harness takes one, a model narrows the effort and context sections,
// favourites sort first, cmd-1 picks the first row, and the harness is
// pinned once the thread has a turn. Base UI's menu and popover never settle
// under jsdom (see composer-checkout.test), so both are stood in by a plain
// open/closed context.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_REFUSED_LINE, DEFAULT_PREFERENCES, markedFor, resolveThreadDefaults, accessReachLine, applyPreferencesPatch, codexNotSignedInLine, type HarnessCatalog, type PreferencesPatch, type SessionAccessOutcome, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";

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
  const MenuItem = ({ children, onClick, closeOnClick: _close, ...props }: { children: ReactNode; onClick?: () => void; closeOnClick?: boolean; [key: string]: unknown }) => (
    <div role="menuitem" onClick={onClick} {...(props as Record<string, unknown>)}>{children}</div>
  );
  const MenuRadioGroup = ({ children, value, onValueChange }: { children: ReactNode; value: string | null; onValueChange: (value: string) => void }) => (
    <Radio.Provider value={{ value, pick: onValueChange }}>
      <div role="group">{children}</div>
    </Radio.Provider>
  );
  // The app's kit closes the menu on a pick unless the caller says otherwise; the stand-in does the same.
  const MenuRadioItem = ({ children, value, className: _c, closeOnClick = true, ...props }: { children: ReactNode; value: string; className?: string; closeOnClick?: boolean; [key: string]: unknown }) => {
    const radio = useContext(Radio);
    const menu = useContext(Ctx);
    return (
      <div
        role="menuitemradio"
        aria-checked={radio.value === value}
        onClick={() => {
          radio.pick(value);
          if (closeOnClick) menu.set(false);
        }}
        {...(props as Record<string, unknown>)}
      >
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  const MenuGroupLabel = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <div data-menu-label {...(props as Record<string, unknown>)}>{children}</div>
  );
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
import { ProjectHome } from "../src/shell/ProjectHome.js";
import { useMultiPickStore } from "../src/components/chat/composerMultiPick.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFavouritesStore } from "../src/components/chat/composerFavouritesStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_HELLO, LISTING, fakeWire, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";
import { harnessCatalog } from "@wsp/runtime";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

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
  useMultiPickStore.setState({ byKey: {} });
});

const WS = CHAT_WS;
const BARE: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

const CONTEXT = [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }];
const MODES = [{ value: "acceptEdits", label: "Accept edits", description: "Edit files without asking" }, { value: "bypassPermissions", label: "Bypass", description: "Run every tool without asking", isDefault: true }];

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
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: CONTEXT,
  permissionModes: MODES,
  steers: true,
  renames: true,
  images: true,
};

/** The runtime's table, what stands before the machine answers. */
const TABLE: HarnessCatalog = {
  ...CLAUDE,
  source: "table",
  version: "--help 2.1.257, 2026-09-05",
  models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }],
};

const CODEX: HarnessCatalog = { harness: "codex", label: "Codex", source: "table", version: null, models: [{ value: "gpt-6-astra", label: "GPT-6 Astra" }], efforts: [{ value: "high", label: "High" }], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };

/** The runtime's own tables, what the composer is served on a machine whose binaries never answered. */
const CODEX_TABLE = harnessCatalog("codex")!;
const CLAUDE_TABLE = harnessCatalog("claude")!;

function fixtureApi(opts: {
  table: HarnessCatalog[];
  machine?: HarnessCatalog[] | Error;
  history?: ReadonlyArray<SessionEvent>;
  sessions?: SessionView[];
  /** What the host answers a pick made while a turn runs; absent, the client has no such road at all. */
  access?: SessionAccessOutcome;
  /** The workspace the thread is on; the bare one without projects unless a case brings its own. */
  workspace?: WorkspaceView;
}) {
  const workspace = opts.workspace ?? BARE;
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const listed: Array<string | undefined> = [];
  const patches: PreferencesPatch[] = [];
  const moved: Array<{ sessionId: string; permissionMode: string }> = [];
  const api: Api = {
    preferences: async () => useStore.getState().preferences,
    setPreferences: async patch => {
      patches.push(patch);
      return applyPreferencesPatch(useStore.getState().preferences, patch);
    },
    ...(opts.access === undefined
      ? {}
      : {
          setSessionAccess: async (sessionId: string, permissionMode: string) => {
            moved.push({ sessionId, permissionMode });
            return opts.access!;
          },
        }),
    listHarnesses: async workspaceId => {
      listed.push(workspaceId);
      if (workspaceId === undefined) return opts.table;
      if (opts.machine instanceof Error) throw opts.machine;
      return opts.machine ?? opts.table;
    },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [...(opts.history ?? [])],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => (caps()),
    listSessions: async () => opts.sessions ?? [],
    watchStatuses: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async o => {
      started.push(o);
      return { id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running", prompt: o.prompt, startedAt: 0 };
    },
  };
  return { api, started, listed, patches, moved };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {}, preferences: DEFAULT_PREFERENCES });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const picker = (kind: string) => document.querySelector<HTMLElement>(`[data-composer-picker="${kind}"]`);
const pickerValue = (kind: string) => picker(kind)?.dataset["value"];
/** One pick off the button that holds it: the effort and the window off the reasoning button, the access off its own. */
const picked = (key: "effort" | "contextWindow" | "access") => picker(key === "access" ? "access" : "reasoning")?.dataset[key];
const option = (value: string) => document.querySelector<HTMLElement>(`[data-composer-option="${value}"]`);
/** What the access menu says about the turn running now, over its list. */
const reachNote = () => document.querySelector<HTMLElement>("[data-composer-access-reach]");
/** The refusal the running turn gave an access pick, which stands on the picker; null while there is none. */
const accessRefusal = () => picker("access")?.getAttribute("data-access-refused") ?? null;
const modelMenu = () => document.querySelector<HTMLElement>("[data-composer-model-menu]");
const openModelMenu = async () => {
  fireEvent.click(picker("model")!);
  await waitFor(() => expect(modelMenu()).not.toBeNull());
  return modelMenu()!;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = join(HERE, "..", "..");
/** The dev shell's fixture catalog, the one file allowed to repeat the table's sentences: the test below pins it to
 * the table's current words, so a screenshot of the shell is never a menu the table stopped saying. */
const SHELL_FIXTURE = join(HERE, "shell", "main.tsx");
/** Every source file of the web and desktop apps, where a second copy of a person's words could hide. */
function appSources(dir: string, out: Array<readonly [string, string]> = []): Array<readonly [string, string]> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".") || path === SHELL_FIXTURE) continue;
    if (e.isDirectory()) appSources(path, out);
    else if (/\.tsx?$/.test(e.name)) out.push([path, readFileSync(path, "utf8")] as const);
  }
  return out;
}

describe("composer pickers", () => {
  it("sit inside the composer box, the access under it, with the machine's catalog, read the defaults, and picks ride the next start", async () => {
    const { api, started, listed } = fixtureApi({ table: [TABLE, CODEX], machine: [CLAUDE, CODEX] });
    await setup(api);
    await waitFor(() => expect(document.querySelector('[data-composer-picker="model"][data-value]')).not.toBeNull());
    await waitFor(() => expect(listed).toContain(WS));
    const footer = document.querySelector("[data-chat-composer-footer]")!;
    expect(footer.contains(picker("model"))).toBe(true);
    expect(footer.contains(picker("reasoning"))).toBe(true);
    expect(footer.contains(picker("access"))).toBe(false);
    expect(document.querySelector("[data-composer-checkout]")!.contains(picker("access"))).toBe(true);
    // Defaults read: the catalog's default model beside its agent's mark, the default
    // context, and the mode under the word for what it sets.
    expect(picker("model")?.textContent).toBe("Opus 5");
    const triggerMark = picker("model")?.querySelector('svg[data-harness-mark="claude"]');
    expect(triggerMark?.classList.contains("text-(--ink-0)")).toBe(true);
    // A monochrome mark would take the foreground from this span rather than the button's muted label colour.
    expect(triggerMark?.parentElement?.tagName).toBe("SPAN");
    expect(triggerMark?.parentElement?.classList.contains("text-foreground")).toBe(true);
    expect(picker("reasoning")?.textContent).toBe("High 1M");
    expect(picker("access")?.textContent).toBe("Bypass");
    expect(picked("effort")).toBe("high");
    expect(picked("contextWindow")).toBe("1m");
    expect(picked("access")).toBe("bypassPermissions");

    // The model menu: the machine's three models with search, jump chips and stars, each row its name alone with no
    // id or description line under it, and no foot at rest.
    const menu = await openModelMenu();
    await waitFor(() => expect(within(menu).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]));
    expect(within(menu).queryByText("Best for everyday, complex tasks")).toBeNull();
    expect(within(menu).getAllByRole("option")[0]?.textContent).not.toContain("claude-opus-5");
    expect(within(menu).getAllByRole("option")[0]?.textContent).toMatch(/⌘1|Ctrl\+1/);
    expect(menu.querySelector("[data-composer-model-foot]")).toBeNull();
    fireEvent.change(within(menu).getByLabelText("Search models"), { target: { value: "son" } });
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
    fireEvent.click(option("claude-sonnet-5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    expect(modelMenu()).toBeNull();
    // Sonnet takes no context window, so the reasoning button reads the effort alone.
    expect(picker("reasoning")?.textContent).toBe("High");
    expect(picked("contextWindow")).toBeUndefined();

    fireEvent.click(option("claude-opus-5") ?? (await openModelMenu(), option("claude-opus-5")!));
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));

    // The reasoning menu: two groups, each default marked and checked, and the button reads "<effort> <window>".
    fireEvent.click(picker("reasoning")!);
    const effortMenu = await screen.findByRole("menu");
    expect(within(effortMenu).getAllByText(/^(Reasoning|Context window|Access)$/).map(el => el.textContent)).toEqual(["Reasoning", "Context window"]);
    expect(option("1m")?.textContent).toContain("default");
    expect(option("high")?.textContent).toContain("default");
    expect(option("high")?.getAttribute("aria-checked")).toBe("true");
    expect(option("low")?.textContent).not.toContain("default");
    fireEvent.click(option("low")!);
    await waitFor(() => expect(picker("reasoning")?.textContent).toBe("Low 1M"));
    fireEvent.click(picker("reasoning")!);
    expect(option("low")?.getAttribute("aria-checked")).toBe("true");
    expect(option("high")?.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(option("200k")!);
    await waitFor(() => expect(picked("contextWindow")).toBe("200k"));

    // The access menu: an icon and a line per mode, the default marked.
    fireEvent.click(picker("access")!);
    expect(screen.getByText("Edit files without asking")).toBeTruthy();
    expect(option("bypassPermissions")?.getAttribute("aria-checked")).toBe("true");
    expect(option("bypassPermissions")?.querySelector("svg")).not.toBeNull();
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    // A send that opens a thread names the agent the box shows.
    expect(started[0]).toMatchObject({ prompt: "go", harness: "claude", model: "claude-opus-5", effort: "low", contextWindow: "200k", permissionMode: "acceptEdits" });
  });

  it("shows the table, marked so, until the machine answers, and keeps it when the machine never does", async () => {
    const { api } = fixtureApi({ table: [TABLE], machine: new Error("machine not running") });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const menu = await openModelMenu();
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    expect(menu.querySelector("[data-composer-model-foot]")).toBeNull();
  });

  it("each tab of a machine that never answered lists that agent's own pinned models", async () => {
    const { api } = fixtureApi({ table: [CLAUDE_TABLE, CODEX_TABLE], machine: new Error("machine not running") });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    const tab = (harness: string) => modelMenu()!.querySelector<HTMLElement>(`[data-composer-harness="${harness}"]`)!;

    fireEvent.click(tab("codex"));
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(CODEX_TABLE.models.map(m => m.value)));
    expect(CODEX_TABLE.models.length).toBeGreaterThan(0);

    fireEvent.click(tab("claude"));
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(CLAUDE_TABLE.models.map(m => m.value)));
  });

  it("draws no foot at rest and no sentence about who pays, on this computer or anywhere else", async () => {
    for (const workspace of [{ ...BARE, kind: "local" as const }, { ...BARE, kind: "cloud" as const, provider: "hetzner" }]) {
      const { api } = fixtureApi({ table: [CLAUDE], workspace });
      await setup(api);
      await waitFor(() => expect(picker("model")).not.toBeNull());
      const menu = await openModelMenu();
      expect(menu.querySelector("[data-composer-model-foot]")).toBeNull();
      expect(menu.textContent).not.toMatch(/sign-in|costs this wsp|list prices/);
      cleanup();
    }
  });

  it("a binary that answered and named a sign-in as why still lists its own pinned models", async () => {
    const refused = { ...CODEX_TABLE, refusal: codexNotSignedInLine("codex login --device-auth") };
    const { api } = fixtureApi({ table: [CLAUDE_TABLE, refused], machine: [CLAUDE_TABLE, refused] });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    fireEvent.click(modelMenu()!.querySelector<HTMLElement>('[data-composer-harness="codex"]')!);
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").length).toBe(CODEX_TABLE.models.length));
  });

  it("sends nothing for a picker left alone, though it shows the default that will run", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("reasoning")?.textContent).toBe("High 1M"));
    expect(picker("access")?.textContent).toBe("Bypass");
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
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("reasoning")!);
    fireEvent.click(option("1m")!);
    await waitFor(() => expect(picked("contextWindow")).toBe("1m"));
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ model: "claude-opus-5", contextWindow: "1m" });
    expect(started[0]?.effort).toBeUndefined();
  });

  it("marks the effort the picked model runs at, not the one the binary's own default model runs at", async () => {
    const { api, started } = fixtureApi({ table: [CODEX_TABLE, CLAUDE_TABLE] });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    fireEvent.click(modelMenu()!.querySelector<HTMLElement>('[data-composer-harness="codex"]')!);
    // GPT-5.6-Sol leads the tab and its app-server reports low for it.
    await waitFor(() => expect(picked("effort")).toBe("low"));
    // GPT-5.5 is a generation behind, so it sits under the legacy fold.
    expect(option("gpt-5.5")).toBeNull();
    fireEvent.click(modelMenu()!.querySelector<HTMLElement>("[data-composer-legacy-fold]")!);
    fireEvent.click(option("gpt-5.5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("gpt-5.5"));
    // The app-server reports medium for GPT-5.5, so that is what the button reads and the menu marks.
    expect(picked("effort")).toBe("medium");
    fireEvent.click(picker("reasoning")!);
    expect(option("medium")?.textContent).toContain("default");
    expect(option("medium")?.getAttribute("aria-checked")).toBe("true");
    expect(option("low")?.textContent).not.toContain("default");
    expect(option("low")?.getAttribute("aria-checked")).toBe("false");
    // Still a default shown, still nothing sent for a picker left alone.
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ harness: "codex", model: "gpt-5.5" });
    expect(started[0]?.effort).toBeUndefined();
  });

  it("a model with no effort levels hides the Reasoning group and the reasoning button reads the window alone", async () => {
    const flash = { value: "claude-flash", label: "Flash", isDefault: true, efforts: [], contextWindows: ["200k", "1m"] };
    const { api } = fixtureApi({ table: [{ ...CLAUDE, models: [flash] }] });
    await setup(api);
    await waitFor(() => expect(picker("reasoning")?.textContent).toBe("1M"));
    expect(picker("access")?.textContent).toBe("Bypass");
    expect(picked("effort")).toBeUndefined();
    expect(picked("contextWindow")).toBe("1m");
    fireEvent.click(picker("reasoning")!);
    const effortMenu = await screen.findByRole("menu");
    expect(within(effortMenu).getAllByText(/^(Reasoning|Context window|Access)$/).map(el => el.textContent)).toEqual(["Context window"]);
    expect(option("high")).toBeNull();
  });

  it("a model narrows the pickers: Haiku takes no effort and no context, so the bar holds the access alone and a stale effort pick is not sent", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    useComposerOptionsStore.setState({ byWorkspaceId: { [WS]: { effort: "high", model: "claude-haiku-4-5" } } });
    await setup(api);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-haiku-4-5"));
    expect(picker("reasoning")).toBeNull();
    fireEvent.click(picker("access")!);
    expect(within(await screen.findByRole("menu")).getAllByText(/^(Reasoning|Context window|Access)$/).map(el => el.textContent)).toEqual(["Access"]);
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
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("reasoning")!);
    fireEvent.click(option("low")!);
    await waitFor(() => expect(picked("effort")).toBe("low"));
    expect(JSON.parse(window.localStorage.getItem("wsp:composer-options:v1") ?? "{}")).toMatchObject({ state: { byWorkspaceId: { [WS]: { effort: "low" } } } });
    view.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(picked("effort")).toBe("low"));
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_other"]).toBeUndefined();
  });

  it("pins the harness once the thread has a turn: another one answers with one line and changes nothing; before a turn the rail switches", async () => {
    const pinned = fixtureApi({ table: [CLAUDE, CODEX], history: CHAT_STREAM, sessions: [{ id: "s0", workspaceId: WS, harness: "claude", status: "completed" }] });
    const view = await setup(pinned.api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    let menu = await openModelMenu();
    const codex = () => menu.querySelector<HTMLButtonElement>('[data-composer-harness="codex"]')!;
    expect(menu.querySelector<HTMLButtonElement>('[data-composer-harness="claude"]')?.getAttribute("aria-selected")).toBe("true");
    // The rail draws each agent's own mark: Claude's in its hue, OpenAI's monochrome as published in the tab's own colour, both bare.
    expect(menu.querySelector('[data-composer-harness="claude"] svg[data-harness-mark="claude"]')?.classList.contains("text-(--ink-0)")).toBe(true);
    expect([...codex().querySelector('svg[data-harness-mark="codex"]')!.classList].filter(c => c.startsWith("text-"))).toEqual([]);
    expect(codex().textContent).toBe("");
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
    // The rail stays and the list is Codex's; the button names the agent it switched to, since Codex marks no
    // default model yet.
    expect(picker("model")?.textContent).toBe("Codex");
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["gpt-6-astra"]));
    fireEvent.click(option("gpt-6-astra")!);
    await waitFor(() => expect(pickerValue("model")).toBe("gpt-6-astra"));
  });

  it("a send into a thread that has run carries the effort picked on it and neither the agent nor the access, which stay the thread's own", async () => {
    const ran: SessionView = { id: "s0", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_a", model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" };
    const history = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
    const { api, started, moved } = fixtureApi({ table: [CLAUDE, CODEX], history, sessions: [ran], access: "set" });
    // An agent picked on the rail is the workspace's pick for its next thread; this thread runs on Claude and stays
    // pinned to it, so the pick stands in what the composer resolved and must not reach the wire.
    useComposerOptionsStore.setState({ byWorkspaceId: { [WS]: { harness: "codex" } } });
    await setup(api);
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("claude"));
    fireEvent.click(picker("reasoning")!);
    fireEvent.click(option("low")!);
    await waitFor(() => expect(picked("effort")).toBe("low"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    // The access went through the access verb, the one road that changes a thread's access, and not into the send.
    expect(moved).toEqual([{ sessionId: "s0", permissionMode: "acceptEdits" }]);

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ thread: "thr_a", effort: "low" });
    expect(started[0]).not.toHaveProperty("harness");
    expect(started[0]).not.toHaveProperty("permissionMode");
  });

  it("an access picked on a thread that has run and is between turns goes through the access verb, so the thread's next turn runs at it", async () => {
    const ran: SessionView = { id: "s0", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", model: "claude-opus-5", permissionMode: "bypassPermissions" };
    const idle = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM, sessions: [ran], access: "set" });
    await setup(idle.api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(idle.moved).toEqual([{ sessionId: "s0", permissionMode: "acceptEdits" }]));
    // The button says what the thread is now at, and nothing under the box: the verb answered set, the thread's
    // record has the mode, and the next thread in this workspace starts at it too.
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(accessRefusal()).toBeNull();
    expect(useStore.getState().preferences.access).toEqual({ [WS]: "acceptEdits" });

    // A thread that has not run names no row: its pick decides what it opens at and the verb is not called.
    cleanup();
    const fresh = fixtureApi({ table: [CLAUDE], access: "set" });
    await setup(fresh.api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(fresh.moved).toEqual([]);
  });

  it("shows the running session's values while a turn streams, the CLI's 1M suffix read as the context window", async () => {
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "claude", status: "running", model: "claude-opus-5[1m]", effort: "low", permissionMode: "acceptEdits" };
    const { api } = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running] });
    await setup(api);
    await waitFor(() => expect(picker("reasoning")?.textContent).toBe("Low 1M"));
    expect(picker("access")?.textContent).toBe("Accept edits");
    expect(picked("contextWindow")).toBe("1m");
    expect(pickerValue("model")).toBe("claude-opus-5");
    expect(picked("access")).toBe("acceptEdits");
  });

  it("keeps the access pick on the host's record, where the next thread reads it, not in this browser's storage", async () => {
    const { api, patches, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);

    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(useStore.getState().preferences.access).toEqual({ [WS]: "acceptEdits" });
    expect(patches).toEqual([{ access: { [WS]: "acceptEdits" } }]);
    // The record is the pick's one home: this browser's own store keeps the other picks and not this one.
    expect(useComposerOptionsStore.getState().byWorkspaceId[WS]).toBeUndefined();
    expect(JSON.stringify(window.localStorage.getItem("wsp:composer-options:v1"))).not.toContain("acceptEdits");

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.permissionMode).toBe("acceptEdits");
  });

  it("shows the pick the record already carries for this workspace, over the mode the catalog marks", async () => {
    const { api } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("access")).not.toBeNull());
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, access: { [WS]: "acceptEdits" } } });
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(picker("access")?.textContent).toBe("Accept edits");
  });

  it("says what a pick does to the turn running now, over the list, while a turn runs and not before", async () => {
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "claude", status: "running", claudeSessionId: "sess_0001", model: "claude-opus-5", permissionMode: "bypassPermissions" };
    const moves = fixtureApi({ table: [{ ...CLAUDE, movesAccess: true }], history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "set" });
    await setup(moves.api);
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("access")!);
    await waitFor(() => expect(reachNote()).not.toBeNull());
    expect(reachNote()?.textContent).toBe(accessReachLine(true));

    // A harness whose turns take no mode change says so on the same line, before anything is picked.
    cleanup();
    const waits = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "unsupported" });
    await setup(waits.api);
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("access")!);
    await waitFor(() => expect(reachNote()?.textContent).toBe(accessReachLine(false)));

    // Nothing to say where no turn is running: the pick only decides what the next one starts at.
    cleanup();
    const idle = fixtureApi({ table: [{ ...CLAUDE, movesAccess: true }] });
    await setup(idle.api);
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("access")!);
    await waitFor(() => expect(option("acceptEdits")).not.toBeNull());
    expect(reachNote()).toBeNull();
  });

  it("a pick made while a turn runs reaches that turn, and a refusal the harness answered with stands on the picker", async () => {
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "claude", status: "running", claudeSessionId: "sess_0001", model: "claude-opus-5", permissionMode: "bypassPermissions" };
    const moves = [{ ...CLAUDE, movesAccess: true }];
    const took = fixtureApi({ table: moves, history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "set" });
    await setup(took.api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(took.moved).toEqual([{ sessionId: "s9", permissionMode: "acceptEdits" }]));
    // The harness took it, so there is nothing to say: the turn in front of the person is at the picked mode.
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(accessRefusal()).toBeNull();

    // A harness whose row says it takes the change and then refuses it: that refusal is the person's news, in the
    // two halves every refusal here has.
    cleanup();
    const refused = fixtureApi({ table: moves, history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "unsupported" });
    await setup(refused.api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    // On the picker itself, in the refusal's ink with the sentence on its hover, and nothing above the box.
    await waitFor(() => expect(accessRefusal()).toBe(ACCESS_REFUSED_LINE));
    expect(picker("access")!.getAttribute("title")).toBe(ACCESS_REFUSED_LINE);
    expect(picker("access")!.className).toContain("text-error-foreground");
    expect(document.querySelector("[data-composer-refusal]")).toBeNull();
    // The pick is kept either way: the refusal says where it lands instead, not that it was dropped.
    expect(useStore.getState().preferences.access).toEqual({ [WS]: "acceptEdits" });
    expect(picked("access")).toBe("acceptEdits");

    // A harness whose row says a pick waits for the thread's next turn said so over the list before the pick, so
    // nothing is said again under the box. The pick still goes through the access verb, which is where the thread's
    // record takes it for that next turn; the turn running now keeps its mode.
    cleanup();
    const waits = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "unsupported" });
    await setup(waits.api);
    await waitFor(() => expect(picked("access")).toBe("bypassPermissions"));
    fireEvent.click(picker("access")!);
    fireEvent.click(option("acceptEdits")!);
    await waitFor(() => expect(waits.moved).toEqual([{ sessionId: "s9", permissionMode: "acceptEdits" }]));
    await waitFor(() => expect(picked("access")).toBe("acceptEdits"));
    expect(accessRefusal()).toBeNull();
  });

  it("reads each access mode's sentence off the runtime's table, so the app spells none of them itself", async () => {
    const { api } = fixtureApi({ table: [CLAUDE_TABLE] });
    await setup(api);
    await waitFor(() => expect(picker("access")).not.toBeNull());
    fireEvent.click(picker("access")!);
    const modes = CLAUDE_TABLE.permissionModes;
    // Plan mode is gone: the table offers none, and every mode it does offer is a row here.
    expect(modes.map(mode => mode.value)).not.toContain("plan");
    expect(modes.length).toBeGreaterThan(3);
    for (const mode of modes) expect(option(mode.value)?.textContent, mode.value).toContain(mode.description!);
    // The sentences have one home. A copy in the app would go on saying what the table no longer says, which is how
    // this menu came to explain itself in the binary's own words; the dev shell's fixture is pinned to them instead.
    const app = appSources(APPS);
    expect(app.length).toBeGreaterThan(100);
    for (const mode of modes) {
      expect(app.filter(([, body]) => body.includes(mode.description!)).map(([f]) => f), mode.value).toEqual([]);
    }
    // Every row the dev shell's fixture lists is a mode the table offers, in the table's own sentence: a fixture row
    // the table dropped would draw a mode the product no longer has.
    const shell = readFileSync(SHELL_FIXTURE, "utf8");
    const rows = [...shell.matchAll(/\{ value: "([^"]+)", label: "[^"]*", description: "([^"]*)" \}/g)].map(m => [m[1], m[2]]);
    expect(rows.length).toBeGreaterThan(2);
    for (const [value, description] of rows) expect(modes.find(o => o.value === value)?.description, value).toBe(description);
  });

  it("on a project's home a shift-click adds a model beside the one shown: chips with each agent's mark over the box, the send reads Send to N, and a plain click goes back to one model", async () => {
    const { api } = fixtureApi({ table: [CLAUDE, CODEX] });
    useStore.setState({ projects: [{ id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" }] });
    useStore.getState().bind(api);
    useStore.getState().setConn("live");
    render(<ProjectHome projectId="pr_1" />);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));
    const chips = () => [...document.querySelectorAll<HTMLElement>("[data-composer-model-chip]")].map(chip => chip.textContent);
    const send = () => document.querySelector<HTMLButtonElement>('[data-chat-composer-actions] button[type="submit"]')!;
    expect(chips()).toEqual([]);
    expect(send().textContent).not.toContain("Send to");

    const menu = await openModelMenu();
    fireEvent.click(option("claude-sonnet-5")!, { shiftKey: true });
    await waitFor(() => expect(chips()).toEqual(["Opus 5", "Sonnet 5"]));
    // The menu stays up for the next add, and the model the button shows is still the first pick.
    expect(modelMenu()).not.toBeNull();
    expect(pickerValue("model")).toBe("claude-opus-5");
    expect(option("claude-sonnet-5")?.getAttribute("aria-selected")).toBe("true");
    expect(send().textContent).toBe("Send to 2");
    fireEvent.click(menu.querySelector('[data-composer-harness="codex"]')!);
    await waitFor(() => expect(option("gpt-6-astra")).not.toBeNull());
    // While the list stands the rail browses: the composer's own pick stays the list's first.
    expect(pickerValue("model")).toBe("claude-opus-5");
    expect(picker("model")?.dataset["harness"]).toBe("claude");
    fireEvent.click(option("gpt-6-astra")!, { shiftKey: true });
    await waitFor(() => expect(chips()).toEqual(["Opus 5", "Sonnet 5", "GPT-6 Astra"]));
    expect(document.querySelector('[data-composer-model-chip="codex:gpt-6-astra"] svg[data-harness-mark="codex"]')).not.toBeNull();
    expect(send().textContent).toBe("Send to 3");
    expect(send().getAttribute("aria-label")).toBe("Send to 3");
    // A chip's own remove takes that model off.
    fireEvent.click(screen.getByRole("button", { name: "Remove Sonnet 5" }));
    await waitFor(() => expect(chips()).toEqual(["Opus 5", "GPT-6 Astra"]));

    // A plain click is a pick of one model, which ends the list.
    fireEvent.click(option("gpt-6-astra")!);
    await waitFor(() => expect(chips()).toEqual([]));
    expect(pickerValue("model")).toBe("gpt-6-astra");
    expect(modelMenu()).toBeNull();
    expect(send().textContent).not.toContain("Send to");
  });

  it("a shift-click on a workspace's composer is a plain pick, since only a home's send opens a copy per model", async () => {
    const { api } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));
    await openModelMenu();
    fireEvent.click(option("claude-sonnet-5")!, { shiftKey: true });
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    expect(modelMenu()).toBeNull();
    expect(document.querySelector("[data-composer-model-chip]")).toBeNull();
    expect(useMultiPickStore.getState().byKey).toEqual({});
  });

  it("shows nothing at all when the runtime serves no catalog for the harness", async () => {
    const { api } = fixtureApi({ table: [] });
    await setup(api);
    await waitFor(() => expect(document.querySelector("[data-composer-folder]")).not.toBeNull());
    expect(document.querySelector("[data-composer-picker]")).toBeNull();
  });
});

const PROJECT = { id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder" as const, path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" };

/** Each list as the host's harnesses.list marks it: the project's agent with its model, effort and access over the
 * person's defaults, read by the one rule; a list read for no workspace knows no project. */
function hostMarked(catalogs: HarnessCatalog[], projectId: string | undefined): HarnessCatalog[] {
  const prefs = useStore.getState().preferences;
  const project = projectId === undefined ? undefined : prefs.projectDefaults[projectId];
  const ask = { catalogOf: (id: string) => catalogs.find(c => c.harness === id), prefs, ...(project !== undefined ? { project } : {}) };
  const agent = resolveThreadDefaults({ firstAgent: catalogs[0]!.harness, ...ask }).agent.value;
  return catalogs.map(c => ({ ...markedFor(c, resolveThreadDefaults({ firstAgent: c.harness, named: c.harness, ...ask })), ...(c.harness === agent ? { isDefault: true } : {}) }));
}

/** The fixture's host, its lists marked as the real one marks them. */
function markedApi(opts: Parameters<typeof fixtureApi>[0]) {
  const made = fixtureApi(opts);
  made.api.listHarnesses = async workspaceId => hostMarked(opts.table, workspaceId === undefined ? undefined : (opts.workspace ?? BARE).project?.id);
  return made;
}

const WORDS = { ask: "default", "auto-edit": "acceptEdits", full: "bypassPermissions" } as const;
const CLAUDE_WORDS: HarnessCatalog = { ...CLAUDE, access: WORDS, permissionModes: [{ value: "default", label: "Ask" }, ...MODES] };
const CODEX_WORDS: HarnessCatalog = { ...CODEX, access: { full: "danger-full-access" }, permissionModes: [{ value: "danger-full-access", label: "Full", isDefault: true }] };

async function home(prefs: Partial<typeof DEFAULT_PREFERENCES>) {
  const made = markedApi({ table: [CLAUDE_WORDS, CODEX_WORDS] });
  useStore.setState({ conn: "connecting", workspaces: [], sessions: {}, harnesses: [], harnessesByWorkspace: {}, projects: [PROJECT], preferences: { ...DEFAULT_PREFERENCES, ...prefs } });
  useStore.getState().bind(made.api);
  useStore.getState().setConn("live");
  const view = render(<ProjectHome projectId="pr_1" />);
  await waitFor(() => expect(useStore.getState().harnesses.length).toBe(2));
  await waitFor(() => expect(picker("model")).not.toBeNull());
  return { ...made, view };
}

describe("a new thread opens on the defaults", () => {
  it("New thread on a project whose default agent is Codex opens on Codex", async () => {
    await home({ projectDefaults: { pr_1: { agent: "codex" } } });
    expect(picker("model")?.dataset["harness"]).toBe("codex");
  });

  it("New thread opens on the default agent where the project names none", async () => {
    await home({ defaultAgent: "codex" });
    expect(picker("model")?.dataset["harness"]).toBe("codex");
  });

  it("New thread shows the project's model and access over the agent's own", async () => {
    await home({ agentDefaults: { claude: { model: "claude-opus-5", access: "ask" } }, projectDefaults: { pr_1: { model: "claude-sonnet-5", access: "auto-edit" } } });
    expect(pickerValue("model")).toBe("claude-sonnet-5");
    expect(picked("access")).toBe("acceptEdits");
  });

  it("New thread shows the agent's own model, effort and access", async () => {
    await home({ agentDefaults: { claude: { model: "claude-sonnet-5", effort: "low", access: "ask" } } });
    expect(pickerValue("model")).toBe("claude-sonnet-5");
    expect(picked("effort")).toBe("low");
    expect(picked("access")).toBe("default");
  });

  it("an open New thread follows a default changed in Settings", async () => {
    await home({});
    expect(picker("model")?.dataset["harness"]).toBe("claude");
    useStore.setState(s => ({ preferences: { ...s.preferences, projectDefaults: { pr_1: { agent: "codex" } } } }));
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("codex"));
  });

  it("a pick made for a draft wins, goes with the send to the workspace it makes, and the next draft follows the defaults", async () => {
    await home({ projectDefaults: { pr_1: { agent: "codex" } } });
    expect(picker("model")?.dataset["harness"]).toBe("codex");
    useComposerOptionsStore.getState().pick("project:pr_1", "harness", "claude");
    useComposerOptionsStore.getState().pick("project:pr_1", "model", "claude-sonnet-5", "project:pr_1");
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    const editor = composerEditor();
    await typeInto(editor, "fix the login test");
    await press(editor, "Enter");
    await waitFor(() => expect(useComposerDraftStore.getState().queues[WS]?.length).toBe(1));
    expect(useComposerOptionsStore.getState().byWorkspaceId[WS]).toEqual({ harness: "claude", model: "claude-sonnet-5" });
    expect(useComposerOptionsStore.getState().pickedOn[WS]).toEqual({ model: WS });
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("codex"));
    expect(useComposerOptionsStore.getState().byWorkspaceId["project:pr_1"]).toBeUndefined();
  });

  it("a model picked on a thread that ran does not stand over the default model of the workspace's next thread", async () => {
    const { api } = markedApi({ table: [CLAUDE_WORDS, CODEX_WORDS], history: CHAT_STREAM, sessions: [{ id: "s0", workspaceId: WS, harness: "claude", status: "completed", threadId: "t1" }] });
    useStore.setState({ projects: [PROJECT], freshThread: false, selectedId: WS });
    await setup(api);
    cleanup();
    const ran = render(<WorkspaceThread workspaceId={WS} threadId="t1" />);
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("claude"));
    await openModelMenu();
    fireEvent.click(option("claude-sonnet-5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    ran.unmount();
    useStore.setState({ freshThread: true, selectedId: WS });
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    expect(pickerValue("model")).toBe("claude-opus-5");
  });

  it("an agent picked for a workspace's new thread rides its send and is gone once the thread opens", async () => {
    const { api, started } = markedApi({ table: [CLAUDE_WORDS, CODEX_WORDS] });
    await setup(api);
    useStore.setState({ projects: [PROJECT], preferences: { ...DEFAULT_PREFERENCES, projectDefaults: { pr_1: { agent: "codex" } } } });
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("codex"));
    act(() => useComposerOptionsStore.getState().pick(WS, "harness", "claude"));
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("claude"));
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ harness: "claude" });
    await waitFor(() => expect(useComposerOptionsStore.getState().byWorkspaceId[WS]).toBeUndefined());
  });

  it("a workspace's next thread opens on the project's default agent, not the agent of its last thread, and its send names it", async () => {
    const { api, started } = markedApi({ table: [CLAUDE_WORDS, CODEX_WORDS], history: CHAT_STREAM, sessions: [{ id: "s0", workspaceId: WS, harness: "claude", status: "completed", threadId: "t1" }] });
    await setup(api);
    cleanup();
    useStore.setState({ projects: [PROJECT], preferences: { ...DEFAULT_PREFERENCES, projectDefaults: { pr_1: { agent: "codex" } } }, freshThread: true, selectedId: WS });
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(picker("model")?.dataset["harness"]).toBe("codex"));
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ harness: "codex" });
    expect(started[0]).not.toHaveProperty("thread");
  });
});
