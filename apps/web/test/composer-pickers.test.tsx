// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort and access pickers inside the composer box: filled from
// the catalog the workspace's machine reports (the table until it answers,
// and marked when it never does), a pick rides the next sessions.start and is
// remembered per workspace, the access pick on the host's own record and into
// a running turn where its harness takes one, a model narrows the effort and context sections,
// favourites sort first, cmd-1 picks the first row, and the harness is
// pinned once the thread has a turn. Base UI's menu and popover never settle
// under jsdom (see composer-checkout.test), so both are stood in by a plain
// open/closed context.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, accessFromNextMessage, applyPreferencesPatch, codexNotSignedInLine, keptAccess, THIS_COMPUTER, type HarnessCatalog, type PreferencesPatch, type SessionAccessOutcome, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";

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
});

const WS = CHAT_WS;
const BARE: WorkspaceView = {
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
    upgrade: async () => workspace,
    capabilities: async () => (caps()),
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
const option = (value: string) => document.querySelector<HTMLElement>(`[data-composer-option="${value}"]`);
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
    const triggerMark = picker("model")?.querySelector('svg[data-harness-mark="claude"]');
    expect(triggerMark?.classList.contains("text-agent-claude")).toBe(true);
    // A monochrome mark would take the foreground from this span rather than the button's muted label colour.
    expect(triggerMark?.parentElement?.tagName).toBe("SPAN");
    expect(triggerMark?.parentElement?.classList.contains("text-foreground")).toBe(true);
    expect(picker("effort")?.textContent).toBe("High · 1M");
    expect(pickerValue("effort")).toBe("high");
    expect(picker("permissionMode")?.textContent).toContain("Bypass");
    expect(pickerValue("permissionMode")).toBe("bypassPermissions");

    // The model menu: the machine's three models with search, jump chips and stars; the footer names the source.
    const menu = await openModelMenu();
    await waitFor(() => expect(within(menu).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]));
    expect(within(menu).getByText("Best for everyday, complex tasks")).toBeTruthy();
    expect(within(menu).getAllByRole("option")[0]?.textContent).toMatch(/⌘1|Ctrl\+1/);
    expect(menu.querySelector("[data-composer-catalog-source]")?.textContent).toBe("Claude Code 2.1.257 on m1");
    fireEvent.change(within(menu).getByLabelText("Search models"), { target: { value: "son" } });
    await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
    fireEvent.click(option("claude-sonnet-5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("claude-sonnet-5"));
    expect(modelMenu()).toBeNull();
    // Sonnet takes no context window, so the effort button reads the effort alone.
    expect(picker("effort")?.textContent).toBe("High");

    fireEvent.click(option("claude-opus-5") ?? (await openModelMenu(), option("claude-opus-5")!));
    await waitFor(() => expect(pickerValue("model")).toBe("claude-opus-5"));

    // The effort menu: two sections, each default marked and checked, and the button reads "<effort> · <context>".
    fireEvent.click(picker("effort")!);
    const effortMenu = await screen.findByRole("menu");
    expect(within(effortMenu).getAllByText(/^(Reasoning|Context Window)$/).map(el => el.textContent)).toEqual(["Reasoning", "Context Window"]);
    expect(option("1m")?.textContent).toContain("default");
    expect(option("high")?.textContent).toContain("default");
    expect(option("high")?.getAttribute("aria-checked")).toBe("true");
    expect(option("low")?.textContent).not.toContain("default");
    fireEvent.click(option("low")!);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("Low · 1M"));
    fireEvent.click(picker("effort")!);
    expect(option("low")?.getAttribute("aria-checked")).toBe("true");
    expect(option("high")?.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(option("200k")!);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("Low · 200k"));

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
    expect(started[0]).toMatchObject({ prompt: "go", model: "claude-opus-5", effort: "low", contextWindow: "200k", permissionMode: "plan" });
    expect(started[0]?.harness).toBeUndefined();
  });

  it("shows the table, marked so, until the machine answers, and keeps it when the machine never does", async () => {
    const { api } = fixtureApi({ table: [TABLE], machine: new Error("machine not running") });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const menu = await openModelMenu();
    expect(menu.querySelector("[data-composer-catalog-source]")?.textContent).toBe("claude table · --help 2.1.257, 2026-09-05");
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
  });

  it("each tab of a machine that never answered lists that agent's own pinned models under that agent's own footer", async () => {
    const { api } = fixtureApi({ table: [CLAUDE_TABLE, CODEX_TABLE], machine: new Error("machine not running") });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    const source = () => modelMenu()!.querySelector("[data-composer-catalog-source]")?.textContent;
    const tab = (harness: string) => modelMenu()!.querySelector<HTMLElement>(`[data-composer-harness="${harness}"]`)!;

    fireEvent.click(tab("codex"));
    await waitFor(() => expect(within(modelMenu()!).getAllByRole("option").map(el => el.dataset["composerOption"])).toEqual(CODEX_TABLE.models.map(m => m.value)));
    expect(CODEX_TABLE.models.length).toBeGreaterThan(0);
    expect(source()).toBe("codex table · app-server 0.153.0, 2026-09-07");

    fireEvent.click(tab("claude"));
    await waitFor(() => expect(source()).toBe("claude table · --help 2.1.257, 2026-09-05"));
  });

  it("the foot says a turn runs on the agent's own sign-in on this computer and costs this wsp nothing", async () => {
    const { api } = fixtureApi({ table: [CLAUDE], workspace: { ...BARE, kind: "local" } });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const menu = await openModelMenu();
    const foot = menu.querySelector<HTMLElement>("[data-composer-model-foot]")!;
    expect([...foot.children].map(el => el.textContent)).toEqual([
      "Claude Code 2.1.257 on this computer",
      "Threads run on Claude Code's own sign-in on this computer, which costs this wsp nothing.",
      "The prices are its list prices, not a bill.",
    ]);
    expect(foot.textContent).not.toMatch(/machine/i);
  });

  it("the foot on a workspace somewhere else names that place, in the same sentences", async () => {
    const { api } = fixtureApi({ table: [CLAUDE], workspace: { ...BARE, kind: "cloud", provider: "hetzner" } });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    const menu = await openModelMenu();
    const foot = menu.querySelector<HTMLElement>("[data-composer-model-foot]")!;
    expect([...foot.children].map(el => el.textContent)).toEqual([
      "Claude Code 2.1.257 on hetzner",
      "Threads run on Claude Code's own sign-in on hetzner, which costs this wsp nothing.",
      "The prices are its list prices, not a bill.",
    ]);
    expect(foot.textContent).not.toContain(THIS_COMPUTER);
    expect(foot.textContent).not.toMatch(/machine/i);
  });

  it("a binary that answered and named a sign-in as why says that in the footer, with its own pin behind it", async () => {
    const refused = { ...CODEX_TABLE, refusal: codexNotSignedInLine("codex login --device-auth") };
    const { api } = fixtureApi({ table: [CLAUDE_TABLE, refused], machine: [CLAUDE_TABLE, refused] });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    fireEvent.click(modelMenu()!.querySelector<HTMLElement>('[data-composer-harness="codex"]')!);
    await waitFor(() =>
      expect(modelMenu()!.querySelector("[data-composer-catalog-source]")?.textContent).toBe(
        "Codex is not signed in where this workspace runs; run codex login --device-auth there · app-server 0.153.0, 2026-09-07",
      ),
    );
    expect(within(modelMenu()!).getAllByRole("option").length).toBe(CODEX_TABLE.models.length);
  });

  it("sends nothing for a picker left alone, though it shows the default that will run", async () => {
    const { api, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("High · 1M"));
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

  it("marks the effort the picked model runs at, not the one the binary's own default model runs at", async () => {
    const { api, started } = fixtureApi({ table: [CODEX_TABLE, CLAUDE_TABLE] });
    await setup(api);
    await waitFor(() => expect(picker("model")).not.toBeNull());
    await openModelMenu();
    fireEvent.click(modelMenu()!.querySelector<HTMLElement>('[data-composer-harness="codex"]')!);
    // GPT-5.6-Sol leads the tab and its app-server reports low for it.
    await waitFor(() => expect(picker("effort")?.textContent).toBe("Low"));
    fireEvent.click(option("gpt-5.5")!);
    await waitFor(() => expect(pickerValue("model")).toBe("gpt-5.5"));
    // The app-server reports medium for GPT-5.5, so that is what the button reads and the menu marks.
    expect(picker("effort")?.textContent).toBe("Medium");
    expect(pickerValue("effort")).toBe("medium");
    fireEvent.click(picker("effort")!);
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

  it("a model with no effort levels hides the Reasoning section and the button reads the context alone", async () => {
    const flash = { value: "claude-flash", label: "Flash", isDefault: true, efforts: [], contextWindows: ["200k", "1m"] };
    const { api } = fixtureApi({ table: [{ ...CLAUDE, models: [flash] }] });
    await setup(api);
    await waitFor(() => expect(picker("effort")?.textContent).toBe("1M"));
    expect(pickerValue("effort")).toBeUndefined();
    fireEvent.click(picker("effort")!);
    const effortMenu = await screen.findByRole("menu");
    expect(within(effortMenu).getAllByText(/^(Reasoning|Context Window)$/).map(el => el.textContent)).toEqual(["Context Window"]);
    expect(option("high")).toBeNull();
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
    // The rail draws each agent's own mark: Claude's in its hue, OpenAI's monochrome as published in the tab's own colour, both bare.
    expect(menu.querySelector('[data-composer-harness="claude"] svg[data-harness-mark="claude"]')?.classList.contains("text-agent-claude")).toBe(true);
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

  it("keeps the access pick on the host's record, where the next thread reads it, not in this browser's storage", async () => {
    const { api, patches, started } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("bypassPermissions"));
    fireEvent.click(picker("permissionMode")!);
    fireEvent.click(option("plan")!);

    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));
    expect(useStore.getState().preferences.access).toEqual({ [WS]: "plan" });
    expect(patches).toEqual([{ access: { [WS]: "plan" } }]);
    // The record is the pick's one home: this browser's own store keeps the other picks and not this one.
    expect(useComposerOptionsStore.getState().byWorkspaceId[WS]).toBeUndefined();
    expect(JSON.stringify(window.localStorage.getItem("wsp:composer-options:v1"))).not.toContain("plan");

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.permissionMode).toBe("plan");
  });

  it("shows the pick the record already carries for this workspace, over the mode the catalog marks", async () => {
    const { api } = fixtureApi({ table: [CLAUDE] });
    await setup(api);
    await waitFor(() => expect(picker("permissionMode")).not.toBeNull());
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, access: { [WS]: "plan" } } });
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));
    expect(picker("permissionMode")?.textContent).toContain("Plan");
  });

  it("on a kept machine the access button wears the mode's short form and its menu row names the machine", async () => {
    const kept = keptAccess({ ...CLAUDE, keptMode: "plan", bypassMode: "bypassPermissions" }, THIS_COMPUTER);
    const { api } = fixtureApi({ table: [kept] });
    await setup(api);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));
    expect(picker("permissionMode")?.textContent).toBe("Plan");
    fireEvent.click(picker("permissionMode")!);
    expect(option("bypassPermissions")?.textContent).toContain(`Bypass on ${THIS_COMPUTER}`);
    fireEvent.click(option("bypassPermissions")!);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("bypassPermissions"));
    // The button says the CLI's word; whose computer it is stays in the menu and in the button's accessible name.
    expect(picker("permissionMode")?.textContent).toBe("Bypass");
    expect(picker("permissionMode")?.getAttribute("aria-label")).toBe(`Access: Bypass on ${THIS_COMPUTER}`);
  });

  it("a pick made while a turn runs reaches that turn, and says when it lands where the harness will not take it", async () => {
    const running: SessionView = { id: "s9", workspaceId: WS, harness: "claude", status: "running", claudeSessionId: "sess_0001", model: "claude-opus-5", permissionMode: "bypassPermissions" };
    const took = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "set" });
    await setup(took.api);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("bypassPermissions"));
    fireEvent.click(picker("permissionMode")!);
    fireEvent.click(option("plan")!);
    await waitFor(() => expect(took.moved).toEqual([{ sessionId: "s9", permissionMode: "plan" }]));
    // The harness took it, so there is nothing to say: the turn in front of the person is at the picked mode.
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("plan"));
    expect(document.querySelector("[data-composer-refusal]")?.textContent).toBe("");

    const missed = fixtureApi({ table: [CLAUDE], history: CHAT_STREAM.slice(0, 2), sessions: [running], access: "unsupported" });
    await setup(missed.api);
    await waitFor(() => expect(pickerValue("permissionMode")).toBe("bypassPermissions"));
    fireEvent.click(picker("permissionMode")!);
    fireEvent.click(option("plan")!);
    await waitFor(() => expect(document.querySelector("[data-composer-refusal]")?.textContent).toBe(accessFromNextMessage("Plan")));
    // The pick is kept either way: the line says when it lands, not that it was dropped.
    expect(useStore.getState().preferences.access).toEqual({ [WS]: "plan" });
    expect(pickerValue("permissionMode")).toBe("plan");
  });

  const SPOO = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z" };
  const WSP = { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" };
  const withProjects: WorkspaceView = { ...BARE, projects: [SPOO, WSP] };
  const projectOption = (name: string) => document.querySelector<HTMLElement>(`[data-composer-project="${name}"]`);
  const folderLine = () => document.querySelector<HTMLElement>("[data-composer-folder]")?.dataset["composerFolder"];

  it("the project pick sits beside the access pick, filled by the rule (the record's last project for this workspace), and a pick lands on the record and rides the start as project, the line under the box naming its folder", async () => {
    const { api, patches, started } = fixtureApi({ table: [CLAUDE], workspace: withProjects });
    await setup(api);
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, project: { [WS]: "spoo" } } });
    await waitFor(() => expect(pickerValue("project")).toBe("spoo"));
    const footer = document.querySelector("[data-chat-composer-footer]")!;
    expect(footer.contains(picker("project"))).toBe(true);
    expect(footer.contains(picker("permissionMode"))).toBe(true);
    // The two triggers are one button: same size and the same muted label class, the project's name in mono; the
    // project's alone is capped at the row, since its name is as long as the person made the folder's.
    expect(picker("project")!.className).toBe(`${picker("permissionMode")!.className} max-w-full`);
    expect(picker("project")!.querySelector("[data-composer-project-name]")!.className).toContain("font-mono");
    expect(folderLine()).toBe("/root/spoo");

    fireEvent.click(picker("project")!);
    await waitFor(() => expect(projectOption("wsp")).not.toBeNull());
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-composer-project]")).map(el => el.dataset["composerProject"])).toEqual(["spoo", "wsp"]);
    expect(screen.getByRole("menuitem", { name: /other folder/ })).toBeTruthy();
    fireEvent.click(projectOption("wsp")!);
    await waitFor(() => expect(pickerValue("project")).toBe("wsp"));
    expect(patches).toEqual([{ project: { [WS]: "wsp" } }]);
    expect(useStore.getState().preferences.project).toEqual({ [WS]: "wsp" });
    expect(folderLine()).toBe("/root/wsp");

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ project: "wsp" });
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("with no pick on the record the only project fills it, two projects leave it empty and the start names nothing, and a workspace without projects has no pick at all", async () => {
    const one = fixtureApi({ table: [CLAUDE], workspace: { ...BARE, projects: [SPOO] } });
    const view = await setup(one.api);
    await waitFor(() => expect(pickerValue("project")).toBe("spoo"));
    expect(folderLine()).toBe("/root/spoo");
    view.unmount();

    const two = fixtureApi({ table: [CLAUDE], workspace: withProjects });
    const second = await setup(two.api);
    await waitFor(() => expect(picker("project")).not.toBeNull());
    expect(pickerValue("project")).toBeUndefined();
    expect(picker("project")!.textContent).toContain("Project");
    expect(folderLine()).toBe("/root");
    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(two.started).toHaveLength(1));
    expect(two.started[0]?.project).toBeUndefined();
    expect(two.started[0]?.cwd).toBeUndefined();
    second.unmount();

    const none = fixtureApi({ table: [CLAUDE] });
    await setup(none.api);
    await waitFor(() => expect(picker("permissionMode")).not.toBeNull());
    expect(picker("project")).toBeNull();
  });

  it("other folder opens the folder picker under the box; the folder picked there is what the start names as cwd, and the pick reads as that folder until a project is picked again", async () => {
    const { api, started, patches } = fixtureApi({ table: [CLAUDE], workspace: withProjects });
    await setup(api);
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, project: { [WS]: "spoo" } } });
    await waitFor(() => expect(pickerValue("project")).toBe("spoo"));
    fireEvent.click(picker("project")!);
    fireEvent.click(screen.getByRole("menuitem", { name: /other folder/ }));
    // The picker opens on the folder the thread would start in, the project's; up is the daemon's home, which lists.
    await waitFor(() => expect(document.querySelector('[data-composer-folder-pick="/root/spoo"]')).not.toBeNull());
    fireEvent.click(screen.getByText(/Up to/));
    await waitFor(() => expect(document.querySelector('[data-composer-folder-entry="/root/app"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-composer-folder-entry="/root/app"]')!);
    await waitFor(() => expect(document.querySelector('[data-composer-folder-pick="/root/app"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-composer-folder-pick="/root/app"]')!);
    await waitFor(() => expect(folderLine()).toBe("/root/app"));
    expect(pickerValue("project")).toBeUndefined();
    expect(picker("project")!.textContent).toContain("app");
    // A folder is not a project: the record's pick stands, so the next thread on this workspace still opens in spoo.
    expect(patches).toEqual([]);

    const editor = composerEditor();
    await typeInto(editor, "go");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ cwd: "/root/app" });
    expect(started[0]?.project).toBeUndefined();
  });

  it("reads each access mode's sentence off the runtime's table, so the app spells none of them itself", async () => {
    const { api } = fixtureApi({ table: [CLAUDE_TABLE] });
    await setup(api);
    await waitFor(() => expect(picker("permissionMode")).not.toBeNull());
    fireEvent.click(picker("permissionMode")!);
    const modes = CLAUDE_TABLE.permissionModes;
    expect(modes).toHaveLength(7);
    for (const mode of modes) expect(option(mode.value)?.textContent, mode.value).toContain(mode.description!);
    // The sentences have one home. A copy in the app would go on saying what the table no longer says, which is how
    // this menu came to explain itself in the binary's own words; the dev shell's fixture is pinned to them instead.
    const app = appSources(APPS);
    expect(app.length).toBeGreaterThan(100);
    for (const mode of modes) {
      expect(app.filter(([, body]) => body.includes(mode.description!)).map(([f]) => f), mode.value).toEqual([]);
    }
    const shell = readFileSync(SHELL_FIXTURE, "utf8");
    for (const mode of modes.filter(o => shell.includes(`value: "${o.value}"`))) expect(shell, mode.value).toContain(mode.description!);
  });

  it("shows nothing at all when the runtime serves no catalog for the harness", async () => {
    const { api } = fixtureApi({ table: [] });
    await setup(api);
    await waitFor(() => expect(screen.getByRole("button", { name: /Working folder/ })).toBeTruthy());
    expect(document.querySelector("[data-composer-picker]")).toBeNull();
  });
});
