// SPDX-License-Identifier: AGPL-3.0-only
// A project's conversations kept outside wsp, in the app: the palette's one page of them per project, opened from the
// project's menu or the palette's root, searched over title, first prompt, branch and agent; a row already a thread
// opens that thread; a pick is held on the project's New thread page, whose send opens the thread on it; one open in
// another app asks first, offering a copy, and Try again where the agent lets go of a closed one.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_OPEN_KIND, CONVERSATION_WORDS, DEFAULT_PREFERENCES, conversationOpenFix, conversationOpenLine, refusal, type ConversationsAnswer, type HarnessCatalog, type OutsideConversation, type PlaceView, type ProjectView, type SessionEvent } from "@wsp/protocol";
import { resolveActions } from "../src/actions/registry.js";
import { projectActions } from "../src/actions/projectActions.js";
import { openCommandPalette } from "../src/commandPaletteBus.js";
import { CommandPalette } from "../src/components/palette/CommandPalette.js";
import { filterCommandPaletteGroups, type CommandPaletteActionItem, type CommandPaletteSubmenuItem } from "../src/components/palette/CommandPalette.logic.js";
import { CONVERSATIONS_PAGE, conversationsPage } from "../src/components/palette/conversationsPage.js";
import { buildPaletteItems, pickOrOpen } from "../src/components/palette/paletteItems.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { deriveSession } from "../src/adapt/session.js";
import type { Api, StartSessionOptions } from "../src/protocol/client.js";
import { projectHomeKey, useStore } from "../src/protocol/store.js";
import { ConversationConfirm } from "../src/shell/ConversationConfirm.js";
import { ProjectHome } from "../src/shell/ProjectHome.js";
import { useConversationsStore } from "../src/shell/conversations.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useMultiPickStore } from "../src/components/chat/composerMultiPick.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio", label: "studio", default: true, present: true } as PlaceView;
const LAB: ProjectView = { id: "pr_lab", name: "lab", computer: "here", source: { kind: "folder", path: "/work/acme/lab" }, path: "/work/acme/lab", remote: "", defaultBranch: "main", memoryKey: "-x", memoryDir: "/x", createdAt: "t" };
const HOME = projectHomeKey(LAB.id);

const row = (over: Partial<OutsideConversation>): OutsideConversation => ({ agent: "claude", id: "7414323d-e71b-4957-8b56-eefdf6bfa350", title: "lab codewords", cwd: LAB.path, lastAt: Date.now() - 2 * 3_600_000, origin: "terminal", live: false, ...over });
const TERMINAL = row({ firstPrompt: "Remember the codeword ALPHA.", branch: "feat/x", bytes: 1_258_291 });
const OPEN = row({ id: "e615a6ab-a2f2-4b10-8fd6-0dc38bf99c28", title: "pricing page", live: true, lastAt: Date.now() - 60_000 });
const CODEX = row({ agent: "codex", id: "01a12813-cd12-7a12-9b13-e76892906ff0", title: "lab terminal thread", firstPrompt: "lab terminal thread", branch: "main", letsGo: "Codex lets go about a minute after its window closes.", lastAt: Date.now() - 5 * 60_000 });
const THREADED = row({ id: "11111111-2222-4333-8444-555555555555", title: "the old thread", origin: "wsp", thread: "thread-7f", lastAt: Date.now() - 86_400_000 });
const ANSWER: ConversationsAnswer = { rows: [OPEN, CODEX, TERMINAL, THREADED], held: [] };

const titles = (page: CommandPaletteSubmenuItem): string[] => page.groups.flatMap(g => g.items).map(i => String(i.title));
const pageOf = (read: ConversationsAnswer | undefined, pick = vi.fn()) => conversationsPage({ project: LAB, computer: "studio", read, pick }) as CommandPaletteSubmenuItem;

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => {
  useConversationsStore.setState({ answers: {}, held: {}, confirm: null });
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  useMultiPickStore.setState({ byKey: {} });
});
afterEach(() => {
  cleanup();
  useStore.setState({ api: null, places: [], projects: [], projectHome: null, selectedId: null } as never);
});

describe("the palette's page of a project's conversations", () => {
  it("is one list newest first, each row the agent's mark, the title, the first prompt where it differs, the branch, the size and the age", () => {
    const page = pageOf(ANSWER);
    expect(page.value).toBe(CONVERSATIONS_PAGE);
    expect(page.placeholder).toBe(CONVERSATION_WORDS.search);
    expect(page.groups.map(g => g.label)).toEqual([CONVERSATION_WORDS.group("lab")]);
    expect(titles(page)).toEqual(["pricing page", "lab terminal thread", "lab codewords", "the old thread"]);
    const items = page.groups[0]!.items as CommandPaletteActionItem[];
    const drawn = render(
      <>
        {items.map(i => (
          <div key={i.value} data-row={i.value}>
            {i.icon}
            {i.description}
            {i.titleTrailingContent}
          </div>
        ))}
      </>,
    );
    const rowText = (value: string) => drawn.container.querySelector(`[data-row="${value}"]`)!.textContent!.replace(/\s+/g, " ").trim();
    expect(drawn.container.querySelector('[data-row^="conversation:codex"] [data-harness-mark="codex"]')).not.toBeNull();
    expect(rowText(`conversation:claude:${TERMINAL.id}`)).toBe("Remember the codeword ALPHA. feat/x 1 MB2h");
    // A first prompt the title already says is not said twice.
    expect(rowText(`conversation:codex:${CODEX.id}`)).toBe("main5m");
    expect(rowText(`conversation:claude:${OPEN.id}`)).toBe(`${CONVERSATION_WORDS.live}1m`);
    expect(rowText(`conversation:claude:${THREADED.id}`)).toBe(`${CONVERSATION_WORDS.thread}1d`);
  });

  it("finds a row by its title, its first prompt, its branch and its agent's name", () => {
    const page = pageOf(ANSWER);
    const found = (query: string) => filterCommandPaletteGroups({ activeGroups: page.groups, query, isInSubmenu: true, projectSearchItems: [], threadSearchItems: [] }).flatMap(g => g.items).map(i => String(i.title));
    expect(found("pricing")).toEqual(["pricing page"]);
    expect(found("ALPHA")).toEqual(["lab codewords"]);
    expect(found("feat/x")).toEqual(["lab codewords"]);
    expect(found("codex")).toEqual(["lab terminal thread"]);
  });

  it("says it is reading while the list is out, what the host refused, and none or no match after", () => {
    const reading = render(<>{pageOf(undefined).emptyStateMessage}</>);
    expect(reading.container.textContent).toBe(CONVERSATION_WORDS.reading("studio"));
    expect(reading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(pageOf({ rows: [], held: [] }).emptyStateMessage).toBe(CONVERSATION_WORDS.empty);
    expect(pageOf(ANSWER).emptyStateMessage).toBe(CONVERSATION_WORDS.noMatch);
    const refused = conversationsPage({ project: LAB, computer: "studio", read: { said: "studio is not answering" }, pick: vi.fn() }) as CommandPaletteSubmenuItem;
    expect(render(<>{refused.emptyStateMessage}</>).container.textContent).toBe("studio is not answering");
    const halves = conversationsPage({ project: LAB, computer: "studio", read: { said: "studio is not answering", fix: "Start it again." }, pick: vi.fn() }) as CommandPaletteSubmenuItem;
    expect(render(<>{halves.emptyStateMessage}</>).container.textContent).toBe("studio is not answering. Start it again.");
  });

  it("gives up a live row's first prompt on a narrow window, where only a letter of it would show", () => {
    const item = pageOf({ rows: [{ ...OPEN, firstPrompt: "Why do the short links 302 twice?" }], held: [] }).groups[0]!.items[0] as CommandPaletteActionItem;
    const prompt = [...render(<>{item.description}</>).container.querySelectorAll("span")].findLast(s => s.textContent?.includes("302 twice"));
    expect(prompt?.className).toContain("max-sm:hidden");
  });

  it("holds a row for an agent a daemon too old could not read, naming the update", () => {
    const page = pageOf({ rows: [CODEX], held: [{ agent: "claude", said: "Claude Code conversations on studio were not read", fix: "Update studio with wsp add studio --update to list them." }] });
    const last = page.groups[0]!.items.at(-1)!;
    expect([last.title, last.description, last.disabled]).toEqual([CONVERSATION_WORDS.heldRow("Claude Code"), CONVERSATION_WORDS.heldNote("studio"), true]);
  });

  it("stands on the palette's root for the project on screen, and is held there with no project on screen", () => {
    const handlers = { selectThread: vi.fn() } as never;
    const base = { projects: [], selectedId: null, query: "", messageHits: [], canCreate: true, recorded: [LAB], picks: [LAB], asks: false, handlers, verbs: {} as never, places: [HERE] };
    const held = buildPaletteItems({ ...base, conversations: { project: null, computer: "", read: undefined, pick: vi.fn() } }).actionItems.find(i => i.title === CONVERSATION_WORDS.row)!;
    expect([held.kind, held.disabled, held.description]).toEqual(["action", true, CONVERSATION_WORDS.openProjectFirst]);
    const open = buildPaletteItems({ ...base, conversations: { project: LAB, computer: "studio", read: ANSWER, pick: vi.fn() } }).actionItems.find(i => i.title === CONVERSATION_WORDS.row)!;
    expect([open.kind, open.value, open.disabled]).toEqual(["submenu", CONVERSATIONS_PAGE, undefined]);
  });

  it("opens the thread already on a row, and hands every other row to the pick", () => {
    const selectThread = vi.fn();
    const pick = vi.fn();
    const projects = [{ threads: [{ id: "thread-7f", threadId: "thread-7f", workspaceId: "ws_1" }] }] as never;
    const input = { projects, handlers: { selectThread } as never, conversations: { project: LAB, computer: "studio", read: ANSWER, pick } };
    pickOrOpen(input, THREADED);
    expect(selectThread).toHaveBeenCalledWith("ws_1", "thread-7f");
    pickOrOpen(input, TERMINAL);
    expect(pick).toHaveBeenCalledWith(TERMINAL);
  });
});

describe("the project's menu", () => {
  it("offers Resume a conversation, which opens the palette's page for that project", () => {
    const resumeConversation = vi.fn();
    const actions = resolveActions(projectActions, { id: LAB.id, name: LAB.name, workspaces: [] }, { newThread: vi.fn(), openSettings: vi.fn(), resumeConversation });
    const entry = actions.find(a => a.id === "resume-conversation")!;
    expect(entry.title).toBe(CONVERSATION_WORDS.menu);
    entry.run();
    expect(resumeConversation).toHaveBeenCalledWith(LAB.id);
  });
});

/** An api that answers the list with `answer` and the start of a thread on a conversation with `start`. */
function fakeApi(answer: ConversationsAnswer, start: (o: Record<string, unknown>) => Promise<unknown> = async o => ({ id: "s1", workspaceId: "ws_9", threadId: "th_9", harness: String(o["harness"]), status: "running" })) {
  const asked: Record<string, unknown>[] = [];
  const listed: string[] = [];
  const claude: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true }], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: true };
  const api = {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [claude],
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listWorkspaces: async () => [],
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: () => () => {},
    capabilities: async () => caps(),
    portReach: async () => ({ url: "https://x/", expiresAt: Date.now() + 1_000 }),
    getGolden: async () => undefined,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    getWorkspace: async (id: string) => ({ id }),
    workspacesLanding: async () => ({ name: "studio", capabilities: caps() }),
    placesList: async () => ({ places: [HERE], adds: [] }),
    startSession: async (o: StartSessionOptions) => ({ id: "s", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    conversationsList: async (project: string) => {
      listed.push(project);
      return answer;
    },
    resumeConversation: async (o: Record<string, unknown>) => {
      asked.push(o);
      return start(o);
    },
  } as unknown as Api;
  return { api, asked, listed };
}

function bind(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], creations: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {}, preferences: DEFAULT_PREFERENCES, projects: [LAB], places: [HERE] } as never);
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
}

describe("picking a conversation in the palette", () => {
  it("opens from the project's menu on that project, reads its list, and holds a pick on its New thread page", async () => {
    const { api, listed } = fakeApi(ANSWER);
    bind(api);
    render(
      <SidebarProvider>
        <CommandPalette />
        <ConversationConfirm />
      </SidebarProvider>,
    );
    act(() => openCommandPalette({ page: "conversations", project: LAB.id }));
    await waitFor(() => expect(screen.getByText("lab codewords")).toBeDefined());
    expect(listed).toEqual([LAB.id]);
    fireEvent.click(screen.getByText("lab codewords"));
    await waitFor(() => expect(useConversationsStore.getState().held[LAB.id]).toEqual({ row: TERMINAL, copy: false }));
    expect(useStore.getState().projectHome).toBe(LAB.id);
  });

  it("asks first about one open in another app, offering a copy as the one primary act", async () => {
    const { api } = fakeApi(ANSWER);
    bind(api);
    render(
      <SidebarProvider>
        <CommandPalette />
        <ConversationConfirm />
      </SidebarProvider>,
    );
    act(() => openCommandPalette({ page: "conversations", project: LAB.id }));
    fireEvent.click(await screen.findByText("pricing page"));
    const dialog = await waitFor(() => document.querySelector<HTMLElement>("[data-k=conversation-open]")!);
    expect(within(dialog).getByText(CONVERSATION_WORDS.openTitle("pricing page", "studio"))).toBeDefined();
    expect(within(dialog).getByText(CONVERSATION_WORDS.openNote(undefined))).toBeDefined();
    expect(dialog.querySelector("[data-k=conversation-try-again]")).toBeNull();
    const copy = dialog.querySelector<HTMLElement>("[data-k=conversation-copy]")!;
    expect(copy.textContent).toBe(CONVERSATION_WORDS.copy);
    fireEvent.click(copy);
    await waitFor(() => expect(useConversationsStore.getState().held[LAB.id]).toEqual({ row: OPEN, copy: true }));
    expect(useConversationsStore.getState().confirm).toBeNull();
  });
});

describe("a project's New thread page with a conversation held", () => {
  async function home(api: Api) {
    bind(api);
    render(
      <>
        <ProjectHome projectId={LAB.id} />
        <ConversationConfirm />
      </>,
    );
    await waitFor(() => expect(composerEditor()).toBeDefined());
  }

  it("offers Resume a conversation only when the folder has any, with how many", async () => {
    await home(fakeApi({ rows: [], held: [] }).api);
    await waitFor(() => expect(useConversationsStore.getState().answers[LAB.id]).toBeDefined());
    expect(document.querySelector("[data-k=resume-conversation]")).toBeNull();
    cleanup();
    useConversationsStore.setState({ answers: {} });
    await home(fakeApi(ANSWER).api);
    const offer = await waitFor(() => document.querySelector<HTMLElement>("[data-k=conversations-offer]")!);
    expect(offer.textContent).toBe(`${CONVERSATION_WORDS.row}${CONVERSATION_WORDS.inFolder(4)}`);
  });

  it("says which conversation the send continues, lets it go with Start fresh, and sends on it under its own agent", async () => {
    const { api, asked } = fakeApi(ANSWER);
    useConversationsStore.setState({ held: { [LAB.id]: { row: TERMINAL, copy: false } } });
    await home(api);
    const line = document.querySelector<HTMLElement>("[data-k=conversation-held]")!;
    expect(line.textContent).toBe(`${CONVERSATION_WORDS.continues("lab codewords", false)}feat/x 2h${CONVERSATION_WORDS.startFresh}`);
    expect(screen.getByRole("button", { name: CONVERSATION_WORDS.send })).toBeDefined();
    const editor = composerEditor();
    await typeInto(editor, "and now the tests");
    await press(editor, "Enter");
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({ project: LAB.id, prompt: "and now the tests", harness: "claude", resume: { id: TERMINAL.id } });
    expect(asked[0]!["resume"]).not.toHaveProperty("copy");
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_9"));
    expect(useConversationsStore.getState().held[LAB.id]).toBeUndefined();
  });

  it("lets a held conversation go with Start fresh", async () => {
    useConversationsStore.setState({ held: { [LAB.id]: { row: TERMINAL, copy: true } } });
    await home(fakeApi(ANSWER).api);
    expect(document.querySelector("[data-k=conversation-held]")!.textContent).toContain(CONVERSATION_WORDS.continues("lab codewords", true));
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=start-fresh]")!);
    await waitFor(() => expect(document.querySelector("[data-k=conversation-held]")).toBeNull());
  });

  it("opens the confirm on a send the agent refused as open elsewhere, keeps the message, and tries again or copies", async () => {
    let refuse = true;
    const { api, asked } = fakeApi(ANSWER, async o => {
      if (refuse && (o["resume"] as { copy?: boolean }).copy !== true) throw Object.assign(refusal(conversationOpenLine("lab terminal thread", "studio"), conversationOpenFix(CODEX.letsGo), CONVERSATION_OPEN_KIND), {});
      return { id: "s2", workspaceId: "ws_9", threadId: "th_9", harness: "codex", status: "running" };
    });
    useConversationsStore.setState({ held: { [LAB.id]: { row: CODEX, copy: false } } });
    await home(api);
    const editor = composerEditor();
    await typeInto(editor, "keep going");
    await press(editor, "Enter");
    const dialog = await waitFor(() => document.querySelector<HTMLElement>("[data-k=conversation-open]")!);
    expect(useComposerDraftStore.getState().drafts[HOME]?.prompt).toBe("keep going");
    expect(within(dialog).getByText(CONVERSATION_WORDS.openNote(CODEX.letsGo))).toBeDefined();
    fireEvent.click(dialog.querySelector<HTMLElement>("[data-k=conversation-try-again]")!);
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(document.querySelector("[data-k=conversation-open]")).not.toBeNull();
    refuse = false;
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=conversation-copy]")!);
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]).toMatchObject({ prompt: "keep going", harness: "codex", resume: { id: CODEX.id, copy: true } });
    await waitFor(() => expect(document.querySelector("[data-k=conversation-open]")).toBeNull());
    expect(useComposerDraftStore.getState().drafts[HOME]?.prompt).toBe("");
  });
});

describe("a thread opened on a conversation", () => {
  it("draws the earlier messages as messages and lines of no turn, ahead of its first turn", () => {
    const scope = { workspaceId: "ws_9", sessionId: TERMINAL.id, threadId: "th_9" };
    const events: SessionEvent[] = [
      { type: "session.earlier", ...scope, who: "note", text: "3 earlier messages stay in Claude Code's own history", at: 1, pos: 1 },
      { type: "session.earlier", ...scope, who: "person", text: "Remember ALPHA.", at: 2, pos: 2 },
      { type: "session.earlier", ...scope, who: "tool", text: "$ echo hi", at: 3, pos: 3 },
      { type: "session.earlier", ...scope, who: "agent", text: "ALPHA", at: 4, pos: 4 },
      { type: "session.start", ...scope, turnId: "t1", prompt: "go on", at: 5, pos: 5 },
    ];
    const model = deriveSession(events);
    expect(model.timeline.map(e => (e.kind === "message" ? `${e.message.role}: ${e.message.text}` : e.kind === "work" ? `work: ${e.entry.label}` : e.kind))).toEqual([
      "work: 3 earlier messages stay in Claude Code's own history",
      "user: Remember ALPHA.",
      "work: $ echo hi",
      "assistant: ALPHA",
      "user: go on",
    ]);
    expect(model.turns.map(t => t.turnId)).toEqual(["t1"]);
  });
});

describe("the words about conversations", () => {
  it("say conversation, never session", () => {
    const said = Object.values(CONVERSATION_WORDS).map(w => (typeof w === "function" ? (w as (...a: unknown[]) => string)("x", "y") : w));
    for (const words of said) expect(words).not.toMatch(/session/i);
  });
});
