// SPDX-License-Identifier: AGPL-3.0-only
// A subagent's own page: the lead's transcript cut to that subagent's lines, led by what its lead asked it as a
// person's bubble, with no working row, no turn fold and no footer; the bar in the composer's shell in its four
// states, at the composer's row and insets; the screen reader told the state once per change; Back to lead; the ways
// in (its sidebar row, its live tile, the fold row in the lead's timeline); its row marked in the sidebar and an ended
// one standing under its lead's shut Finished fold while the page is open; and the bar's timer ticking without a
// render. The shell, the sidebar and the thread are the real ones.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import type { HarnessCatalog, ProjectView, SessionEvent, SessionView, SubagentView, WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useSelectedSubagent, useSelectedThreadId, useStore } from "../src/protocol/store.js";
import { AppShell } from "../src/shell/AppShell.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { SubagentFoldRow } from "../src/components/chat/SubagentFoldRow.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { installFakeLayout } from "./fake-layout.js";

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (minutes: number): number => NOW - minutes * 60_000;
const WS = "ws_lab";
const LEAD = "thr_lead";
const workspace: WorkspaceView = {
  id: WS,
  name: "lab",
  machineId: "m1",
  project: { id: "pr_lab", name: "lab", path: "/root/lab", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-10-01T00:00:00Z",
};
const PROJECT: ProjectView = { id: "pr_lab", name: "lab", computer: "default", source: { kind: "folder", path: "/root/lab" }, path: "/root/lab", remote: "https://github.com/acme/lab.git", defaultBranch: "main", memoryKey: "-root-lab", memoryDir: "/root/.claude/projects/-root-lab/memory", createdAt: "t" };
const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "table",
  version: null,
  models: [{ value: "claude-haiku-4-5", label: "Haiku 4.5" }],
  efforts: [],
  contextWindows: [],
  permissionModes: [],
  steers: false,
  renames: false,
  images: false,
};

const PROMPT = "Read every open ticket on acme/lab-map with no branch yet, and list them with the files each one names.";
const FAILURE = "WebFetch could not reach https://acme.dev: connect ETIMEDOUT";
/** What Claude answers a launching call its stop cut short with. */
const INTERRUPTED = "[Request interrupted by user for tool use]";
/** The done subagent's report, two paragraphs as a real one runs: the launching call's answer keeps the first line. */
const REPORT = "add-sheet.test.tsx:41 pins the order.\n\nIt pins it in three cases, all green.";

/** The lead's four subagents as its listing carries them: one running, one done after 3m, one failed, one stopped
 * after 2m and naming no model. */
const SUBAGENTS: SubagentView[] = [
  { id: "map", title: "Read the open tickets on the map", state: "running", parentToolUseId: "tu_map", model: "claude-haiku-4-5", startedAt: ago(1) },
  { id: "order", title: "Check the sheet's tests for the step order", state: "done", parentToolUseId: "tu_order", model: "claude-haiku-4-5", startedAt: ago(5), endedAt: ago(2) },
  { id: "hdr", title: "Check the landing's CSP headers", state: "failed", parentToolUseId: "tu_hdr", model: "claude-haiku-4-5", startedAt: ago(4), endedAt: ago(3), failure: FAILURE },
  { id: "csp", title: "Rerun the CSP gate", state: "stopped", parentToolUseId: "tu_csp", startedAt: ago(4), endedAt: ago(2) },
];

let LISTED = SUBAGENTS;
const leadRow = (): SessionView => ({ id: "s_lead", workspaceId: WS, harness: "claude", status: "running", prompt: "Run the marathon", threadId: LEAD, startedAt: ago(6), subagents: LISTED });

const scope = { workspaceId: WS, sessionId: "s_lead", threadId: LEAD, turnId: "turn_lead" };
const launch = (id: string, prompt: string, title: string, at: number): SessionEvent[] => [
  { type: "session.delta", ...scope, at, kind: "tool_use", toolName: "Agent", toolUseId: `tu_${id}`, text: JSON.stringify({ description: title, prompt, subagent_type: "Explore" }) },
  { type: "session.subagent", ...scope, at, task: id, state: "running", parentToolUseId: `tu_${id}`, title },
];
const line = (id: string, text: string, at: number): SessionEvent => ({ type: "session.delta", ...scope, at, kind: "text", text, parentToolUseId: `tu_${id}` });

/** The lead's running turn: its own words, and its four subagents' lines among them, each keyed by its call. */
const HISTORY: SessionEvent[] = [
  { type: "session.start", ...scope, at: ago(6), prompt: "Run the marathon", model: "claude-opus-5-5" },
  { type: "session.delta", ...scope, at: ago(6), kind: "text", text: "Starting four subagents." },
  ...launch("order", "Read the add sheet's tests and say whether any of them pins the order of the steps.", SUBAGENTS[1]!.title, ago(5)),
  line("order", "Reading the add sheet's tests.", ago(4.5)),
  line("order", REPORT, ago(2.1)),
  { type: "session.delta", ...scope, at: ago(2), kind: "tool_result", toolUseId: "tu_order", text: REPORT },
  ...launch("hdr", "Fetch the landing page and list its Content-Security-Policy header.", SUBAGENTS[2]!.title, ago(4)),
  line("hdr", "Fetching the landing page.", ago(3.5)),
  { type: "session.delta", ...scope, at: ago(3), kind: "tool_result", toolUseId: "tu_hdr", text: FAILURE, isError: true },
  ...launch("csp", "Run pnpm gate:csp and report each failing rule.", SUBAGENTS[3]!.title, ago(4)),
  line("csp", "Building the landing first.", ago(3)),
  { type: "session.delta", ...scope, at: ago(2), kind: "tool_result", toolUseId: "tu_csp", text: INTERRUPTED, isError: true },
  ...launch("map", PROMPT, SUBAGENTS[0]!.title, ago(1)),
  line("map", "Listing the open tickets with no branch yet.", ago(0.9)),
  { type: "session.delta", ...scope, at: ago(0.8), kind: "tool_use", toolName: "Bash", toolUseId: "tu_map_1", text: JSON.stringify({ command: "gh issue list", description: "List the map's open tickets" }), parentToolUseId: "tu_map" },
  { type: "session.delta", ...scope, at: ago(0.7), kind: "tool_result", toolUseId: "tu_map_1", text: "34 issues", parentToolUseId: "tu_map" },
  line("map", "34 open. Reading each one for the files it names.", ago(0.6)),
  { type: "session.delta", ...scope, at: ago(0.55), kind: "tool_use", toolName: "Bash", toolUseId: "tu_map_2", text: JSON.stringify({ command: "gh issue view 1830", description: "Read ticket 1830" }), parentToolUseId: "tu_map" },
  { type: "session.delta", ...scope, at: ago(0.5), kind: "text", text: "Eight threads are out." },
];

const api: Api = {
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => HISTORY,
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  nap: async () => workspace,
  wake: async () => workspace,
  capabilities: async () => caps(),
  listSessions: async () => [leadRow()],
  listHarnesses: async () => [CLAUDE],
  watchStatuses: async () => [],
  subscribe: () => () => {},
  getGolden: async () => undefined,
  projectsList: async () => [PROJECT],
  startSession: async o => ({ id: "s9", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
};

/** The centre as the app mounts it: the thread the store has selected, and its subagent where one is. */
function Centre({ onRender }: { onRender?: () => void }) {
  const threadId = useSelectedThreadId();
  const subagent = useSelectedSubagent();
  const page = <WorkspaceThread workspaceId={WS} threadId={threadId} subagent={subagent} />;
  return onRender === undefined ? page : <Profiler id="centre" onRender={onRender}>{page}</Profiler>;
}

async function mount(onRender?: () => void): Promise<void> {
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  render(
    <AppShell>
      <Centre {...(onRender === undefined ? {} : { onRender })} />
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
  act(() => useStore.getState().select(WS, LEAD));
  await waitFor(() => expect(document.body.textContent).toContain("Eight threads are out."));
}

const page = (): HTMLElement => document.querySelector<HTMLElement>("[data-chat-view]")!;
/** The one element a selector finds, waited for: a wait that returns null would pass at once. */
const found = (selector: string, within: ParentNode = document): Promise<HTMLElement> =>
  waitFor(() => {
    const el = within.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    return el!;
  });
/** The rows of the list on screen: a switch holds the list it left, hidden, until the next one has painted. */
const shownRows = (): HTMLElement[] => [...page().querySelectorAll<HTMLElement>("[data-timeline-row-kind]")].filter(el => el.closest("[aria-hidden=true]") === null);
const shownText = (): string => shownRows().map(el => el.textContent).join("\n");
const bar = (): HTMLElement => document.querySelector<HTMLElement>("[data-subagent-bar]")!;
const rowKinds = (): string[] => shownRows().map(el => el.getAttribute("data-timeline-row-kind")!);
const sidebarRows = (): string[] => [...document.querySelectorAll("[data-slot=sidebar] [data-row-id]")].map(el => el.getAttribute("data-row-id")!);

async function openPage(id: string): Promise<void> {
  act(() => useStore.getState().select(WS, LEAD, `tu_${id}`));
  await waitFor(() => expect(bar()).not.toBeNull());
}

beforeEach(() => {
  window.location.hash = "";
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  LISTED = SUBAGENTS;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a subagent's page", () => {
  it("shows that subagent's lines alone, led by what its lead asked it as a person's bubble, with no working row, folds or footer", async () => {
    await mount();
    await openPage("map");
    await waitFor(() => expect(shownRows()[0]?.textContent).toContain(PROMPT));
    const kinds = rowKinds();
    expect(kinds[0]).toBe("message");
    expect(shownRows()[0]!.getAttribute("data-message-role")).toBe("user");
    expect(shownText()).toContain("Listing the open tickets with no branch yet.");
    expect(shownText()).toContain("34 open. Reading each one for the files it names.");
    // Its call stands as a work row, worded as the thread's own would be.
    expect(kinds).toContain("work-toggle");
    // The lead's own words and every other subagent's stay on the lead's page.
    expect(shownText()).not.toContain("Eight threads are out.");
    expect(shownText()).not.toContain("Starting four subagents.");
    expect(shownText()).not.toContain("Reading the add sheet's tests.");
    expect(shownText()).not.toContain("Fetching the landing page.");
    // The bar carries its state: none of the rows a turn draws about itself, and no footer.
    for (const kind of ["working", "thinking", "turn-fold", "spawn", "subagent"]) expect(kinds).not.toContain(kind);
    expect(page().querySelector("[data-testid=settled-footer]")).toBeNull();
    // Nobody writes to a subagent: no message box.
    expect(page().querySelector("[contenteditable=true]")).toBeNull();
  });

  it("says an ended subagent's last words once, though the launching call's answer repeats them, and a running one's last message carries no reply footer", async () => {
    await mount();
    await openPage("order");
    await waitFor(() => expect(shownRows()[0]?.textContent).toContain("pins the order of the steps"));
    await waitFor(() => expect(shownText()).toContain("It pins it in three cases, all green."));
    expect(shownText().split("add-sheet.test.tsx:41 pins the order.").length - 1).toBe(1);
    await openPage("map");
    await waitFor(() => expect(shownRows()[0]?.textContent).toContain(PROMPT));
    expect(page().querySelectorAll("[data-reply-meta]").length - document.querySelectorAll("[aria-hidden=true] [data-reply-meta]").length).toBe(0);
  });

  it("draws a running subagent's call in progress as its live row, as a running turn draws its own", async () => {
    await mount();
    await openPage("map");
    await waitFor(() => expect(rowKinds().at(-1)).toBe("work-live"));
    expect(shownRows().at(-1)!.textContent).toContain("Read ticket 1830");
  });

  it("leaves a failed subagent's failure to its bar, and keeps the marker a stopped one's call answered with", async () => {
    await mount();
    await openPage("hdr");
    await waitFor(() => expect(shownText()).toContain("Fetching the landing page."));
    expect(shownText()).not.toContain(FAILURE);
    expect(bar().textContent).toContain(FAILURE);
    await openPage("csp");
    await waitFor(() => expect(shownText()).toContain("Building the landing first."));
    expect(shownText()).toContain(INTERRUPTED);
  });

  it("draws the bar in each of its four states, the model as a label and the agent's name where the listing names none", async () => {
    await mount();
    await openPage("map");
    expect(bar().querySelector("[data-subagent-model]")!.textContent).toBe("Haiku 4.5");
    expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe("Working for 1m");
    await openPage("order");
    await waitFor(() => expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe("Worked for 3m"));
    await openPage("hdr");
    await waitFor(() => expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe(`Failed: ${FAILURE}`));
    await openPage("csp");
    await waitFor(() => expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe("Stopped after 2m"));
    expect(bar().querySelector("[data-subagent-model]")!.textContent).toBe("Claude Code");
    // A label, not a menu: nothing in the model's group is a button.
    expect(bar().querySelector("[data-subagent-model] button, [data-subagent-model][role=button]")).toBeNull();
  });

  it("stands in the composer's shell at its 48 px row and 50 px frame, hugging its words, at 20 px left, 8 right, 12 between the groups and 6 between the mark and the model", async () => {
    await mount();
    await openPage("map");
    const classes = (el: Element | null): string[] => (el?.getAttribute("class") ?? "").split(/\s+/);
    const shell = document.querySelector("[data-slot=composer-shell][data-subagent-composer]")!;
    expect(shell).not.toBeNull();
    // Hugs its contents and stands centred in the composer's column.
    expect(classes(shell)).toEqual(expect.arrayContaining(["w-fit", "mx-auto"]));
    expect(shell.querySelector("[data-slot=composer-host]")).not.toBeNull();
    // The surface's 1 px on each side around the 48 px row: the composer's 50 px frame.
    expect(classes(shell.querySelector("[data-chat-composer-main-surface]"))).toContain("p-px");
    // 48 px tall at the least, 16 px in under 640 and 20 from there, 8 px at the right, 12 between the groups.
    expect(classes(bar())).toEqual(expect.arrayContaining(["min-h-12", "ps-4", "sm:ps-5", "pe-2", "gap-3"]));
    const model = bar().querySelector("[data-subagent-model]")!;
    expect(classes(model)).toEqual(expect.arrayContaining(["gap-1.5", "text-foreground", "text-note"]));
    expect(classes(model.querySelector("svg, img, [data-harness-mark]"))).toContain("size-4");
    const state = bar().querySelector("[data-subagent-state]")!;
    expect(classes(state)).toEqual(expect.arrayContaining(["text-muted-foreground", "tabular-nums", "sm:truncate", "max-sm:line-clamp-3"]));
    // Back to lead: a borderless ghost button with its arrow, its words hidden under 640 px and named on its tooltip.
    const back = bar().querySelector<HTMLButtonElement>("[data-subagent-back]")!;
    expect(classes(back)).toEqual(expect.arrayContaining(["border-transparent", "text-muted-foreground"]));
    expect(classes(back)).not.toContain("border-input");
    expect(back.getAttribute("aria-label")).toBe("Back to lead");
    expect(back.querySelector("svg.lucide-arrow-up-left")).not.toBeNull();
    expect(classes(back.querySelector("span"))).toContain("max-sm:hidden");
    // No Stop and no message box on the bar.
    expect(bar().querySelectorAll("button")).toHaveLength(1);
  });

  it("tells a screen reader the state word once, and again when it changes", async () => {
    await mount();
    await openPage("map");
    const statuses = bar().querySelectorAll("[role=status]");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toBe("Working");
    LISTED = SUBAGENTS.map(sub => (sub.id === "map" ? { ...sub, state: "done" as const, endedAt: NOW } : sub));
    await act(() => useStore.getState().reloadSessions(WS));
    await waitFor(() => expect(bar().querySelector("[role=status]")!.textContent).toBe("Done"));
    expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe("Worked for 1m");
  });

  it("goes back to the lead on Back to lead, its lines and its composer as they were", async () => {
    await mount();
    await openPage("hdr");
    fireEvent.click(bar().querySelector("[data-subagent-back]")!);
    await waitFor(() => expect(bar()).toBeNull());
    const s = useStore.getState();
    expect([s.selectedId, s.selectedThreadId, s.selectedSubagent]).toEqual([WS, LEAD, null]);
    await waitFor(() => expect(shownText()).toContain("Eight threads are out."));
    expect(page().querySelector("[contenteditable=true]")).not.toBeNull();
    // The road back from where the dock stands gives the composer the keys.
    await waitFor(() => expect(document.activeElement?.closest("[contenteditable=true]")).not.toBeNull());
  });

  it("draws the bar, Back to lead and the crumb off the subagent's own fold where the lead's listing does not carry it", async () => {
    LISTED = SUBAGENTS.filter(sub => sub.id !== "order");
    await mount();
    fireEvent.click(await found('[data-subagent="tu_order"] [data-subagent-open]', page()));
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(useStore.getState().selectedSubagent).toBe("tu_order");
    expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe("Worked for 3m");
    expect(bar().querySelector("[data-subagent-back]")).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-thread-breadcrumb]")!.textContent).toBe(`lab/Run the marathon/${SUBAGENTS[1]!.title}`));
  });

  it("says a failed subagent's failure once on the bar it draws off its own fold", async () => {
    LISTED = SUBAGENTS.filter(sub => sub.id !== "hdr");
    await mount();
    fireEvent.click(await found('[data-subagent="tu_hdr"] [data-subagent-open]', page()));
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(bar().querySelector("[data-subagent-state]")!.textContent).toBe(`Failed: ${FAILURE}`);
  });

  it("opens the lead where the address names a call neither its listing nor its transcript knows", async () => {
    await mount();
    act(() => useStore.getState().select(WS, LEAD, "tu_nobody"));
    await waitFor(() => expect(useStore.getState().selectedSubagent).toBeNull());
    expect(useStore.getState().selectedThreadId).toBe(LEAD);
    expect(window.location.hash).toBe(`#w/${WS}/t/${LEAD}`);
    await waitFor(() => expect(page().querySelector("[contenteditable=true]")).not.toBeNull());
  });

  it("names the project, the lead and the subagent in the breadcrumb", async () => {
    await mount();
    await openPage("order");
    const crumb = document.querySelector("[data-thread-breadcrumb]")!;
    await waitFor(() => expect(crumb.textContent).toBe(`lab/Run the marathon/${SUBAGENTS[1]!.title}`));
    expect(crumb.querySelector("[data-breadcrumb-opener]")!.getAttribute("href")).toMatch(new RegExp(`#w/${WS}/t/${LEAD}$`));
  });

  it("ticks its timer on its own node: over 3 s the page commits no render", async () => {
    // A second install over the one every case starts with is a no-op: take it off first, then fake the interval too.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    let commits = 0;
    await mount(() => commits++);
    await openPage("map");
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 50)));
    const timer = bar().querySelector("[data-subagent-state]")!;
    const before = commits;
    const text = timer.textContent;
    act(() => vi.advanceTimersByTime(3_000));
    expect(timer.textContent).not.toBe(text);
    expect(commits - before).toBe(0);
  });
});

describe("the ways in", () => {
  it("the subagent's sidebar row opens its page and stands marked", async () => {
    await mount();
    const row = await found("[data-slot=sidebar] [data-subagent-row=map]");
    fireEvent.click(row);
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(useStore.getState().selectedSubagent).toBe("tu_map");
    expect(document.querySelector("[data-slot=sidebar] [data-subagent-row=map]")!.getAttribute("data-active")).toBe("true");
    // The lead's own tile is not the one open while its subagent's page is.
    expect(document.querySelector(`[data-slot=sidebar] [data-row-id="thread:${LEAD}"] [data-active=true], [data-slot=sidebar] [data-row-id="thread:${LEAD}"][data-active=true]`)).toBeNull();
  });

  it("the subagent's live tile in the lead's transcript opens its page", async () => {
    await mount();
    const tile = await found("[data-spawn-tiles] [data-subagent-row=order]", page());
    // The keyboard reaches it through a real link to the page's own address, as a child thread's row's name is.
    const link = tile.querySelector<HTMLAnchorElement>("a[data-subagent-open]")!;
    expect(link.getAttribute("href")).toBe(`#w/${WS}/t/${LEAD}/a/tu_order`);
    fireEvent.click(link);
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(useStore.getState().selectedSubagent).toBe("tu_order");
  });

  it("the fold row in the lead's timeline opens its page", async () => {
    useStore.setState({ selectedId: WS, selectedThreadId: LEAD, selectedSubagent: null } as never);
    render(<SubagentFoldRow subagent={{ parentToolUseId: "tu_x", turnId: "turn_lead", title: "Read the map", prompt: null, lines: [], prompts: [], state: "done", startedAt: "", endedAt: null }} onAnswer={async () => {}} />);
    const open = document.querySelector("[data-subagent-open]")!;
    // Named on its tooltip as the bar and the rows are, not on a native title.
    expect(open.getAttribute("title")).toBeNull();
    fireEvent.click(open);
    const s = useStore.getState();
    expect([s.selectedId, s.selectedThreadId, s.selectedSubagent]).toEqual([WS, LEAD, "tu_x"]);
  });
});

describe("an ended subagent's row in the sidebar", () => {
  it("stands under its lead's shut Finished fold while its page is open, and after Back to lead the sidebar draws the same rows as before", async () => {
    await mount();
    await waitFor(() => expect(document.querySelector("[data-slot=sidebar] [data-child-fold=finished]")).not.toBeNull());
    const fold = document.querySelector<HTMLElement>("[data-slot=sidebar] [data-child-fold=finished]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-slot=sidebar] [data-subagent-row=order]")).toBeNull();
    const before = sidebarRows();
    await openPage("order");
    const row = await found("[data-slot=sidebar] [data-subagent-row=order]");
    expect(row.getAttribute("data-active")).toBe("true");
    // Under the fold's own head, which stays shut, and no other finished row comes with it.
    expect(document.querySelector("[data-slot=sidebar] [data-child-fold=finished]")!.getAttribute("aria-expanded")).toBe("false");
    expect(row.closest("li")!.parentElement!.closest("li")!.querySelector("[data-child-fold=finished]")).not.toBeNull();
    expect(document.querySelector("[data-slot=sidebar] [data-subagent-row=hdr]")).toBeNull();
    fireEvent.click(bar().querySelector("[data-subagent-back]")!);
    await waitFor(() => expect(bar()).toBeNull());
    expect(sidebarRows()).toEqual(before);
  });
});

/** A host that answers heads and pages over these events, each read written down: the head and the newest page are
 * the last 200, as a real host's are. */
function pagedApi(events: ReadonlyArray<SessionEvent & { pos: number }>, reads: string[]): Api {
  const total = events.length;
  return {
    ...api,
    sessionHistory: async () => events.slice(-200),
    sessionHead: async threadId => {
      reads.push("head");
      const r = leadRow();
      return { facts: { id: r.id, threadId, workspaceId: WS, harness: r.harness, startedBy: "person", status: r.status, title: r.prompt ?? "", sessionId: r.id, turns: 1, ran: true }, events: events.slice(-200), pos: total, total };
    },
    sessionPage: async (_workspaceId, _threadId, window = {}) => {
      reads.push(window.before === undefined ? "page" : `page before ${window.before}`);
      const under = events.filter(e => window.before === undefined || e.pos < window.before);
      return { events: under.slice(-(window.limit ?? 200)), pos: total, total };
    },
  };
}

/** The app opened on an address, as a refresh or a pasted link opens it. */
function openAt(hash: string, host: Api): void {
  window.location.hash = hash;
  useStore.getState().bind(host);
  useStore.getState().setConn("live");
  render(
    <AppShell>
      <Centre />
    </AppShell>,
  );
}

describe("an old subagent's page", () => {
  it("reads the lead's older pages until the launching call is in, so a refresh opens its whole page", async () => {
    const lead = Array.from({ length: 700 }, (_, i): SessionEvent => ({ type: "session.delta", ...scope, at: ago(0.4), kind: "text", text: `Lead line ${i}.`, messageId: `m${i}` }));
    const reads: string[] = [];
    openAt(`#w/${WS}/t/${LEAD}/a/tu_order`, pagedApi([...HISTORY, ...lead].map((e, i) => ({ ...e, pos: i + 1 })), reads));
    await waitFor(
      () => {
        expect(shownRows()[0]?.textContent).toContain("pins the order of the steps");
        expect(shownText()).toContain("Reading the add sheet's tests.");
      },
      { timeout: 8000 },
    );
    expect(reads.filter(r => r.startsWith("page before")).length).toBeGreaterThan(1);
    expect(useStore.getState().selectedSubagent).toBe("tu_order");
  });

  it("reads nothing older where its launch is in the lead's newest page, though the lead holds older turns", async () => {
    const old = { ...scope, turnId: "turn_old" };
    const earlier: SessionEvent[] = [
      { type: "session.start", ...old, at: ago(60), prompt: "Plan the marathon", model: "claude-opus-5-5" },
      ...Array.from({ length: 700 }, (_, i): SessionEvent => ({ type: "session.delta", ...old, at: ago(59), kind: "text", text: `Earlier line ${i}.`, messageId: `e${i}` })),
    ];
    const reads: string[] = [];
    openAt(`#w/${WS}/t/${LEAD}/a/tu_map`, pagedApi([...earlier, ...HISTORY].map((e, i) => ({ ...e, pos: i + 1 })), reads));
    await waitFor(() => expect(shownText()).toContain("34 open. Reading each one for the files it names."), { timeout: 8000 });
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 1000)));
    expect([...reads].sort()).toEqual(["head", "page"]);
  });
});
