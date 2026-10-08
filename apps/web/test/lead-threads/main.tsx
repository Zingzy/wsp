// SPDX-License-Identifier: AGPL-3.0-only
// The lead threads prototype: the app shell over a fake host, open on a coordinator thread whose tree (the threads
// it started, theirs, and its agents' subagents) LeadThreads draws in its transcript and under its tile in the
// sidebar. Served by its own vite (see vite.config.ts beside this file), in either theme (?theme=light).
// ?lead=small is a lead with three children; ?quiet=2h folds children by the quiet rule the sidebar settles by,
// where the default draws all 60 finished; ?after=settle is the marathon after Settle all; ?finished=1, ?settled=1
// and ?nested=1 open those folds; ?shut=1 shuts the Threads block, ?shut-shape=peek2 or line draws it shut another
// way; ?rail=guide draws the connector with no elbows; ?acts=<thread> shows that row's acts as its hover does;
// ?send=<thread> opens its message field; ?dock=subagent, subagent-done, question or tasks shows the bar in the
// composer's place in each use; ?renders=1 stamps each transcript row with how many times it drew; ?bar=0 hides the
// state bar for a shot.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type SessionEvent, type SessionView, type SettleAfter } from "@wsp/protocol";
import { ChatComposer } from "../../src/components/chat/ChatComposer";
import { ChatView } from "../../src/components/chat/ChatView";
import { Button } from "../../src/components/ui/button";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api, StartSessionOptions } from "../../src/protocol/client";
import { useSettingsOpen, useSidebarProjects, useStore } from "../../src/protocol/store";
import { SettingsPage } from "../../src/settings/SettingsPage";
import type { StepLine } from "../../src/settings/add/setup";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { AppShell } from "../../src/shell/AppShell";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { applyTheme } from "../../src/settings/theme";
import { statusOf } from "../workspace-status";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";
import { ACCESS_MODES } from "../fixtures/access-modes";
import "../../src/index.css";
import "../../src/themes/index";
import { SubagentDock, TaskDock } from "./Dock";
import { BOX, CHILD_FACTS, HERE, HETZNER, LEAD, LEAD_SAID, MAC, OTHERS, PROJECT, childrenOf, leadSession, type LeadSize } from "./fixtures";
import { useLeadShut, useLeadUi } from "./LeadThreads";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
const size: LeadSize = params.get("lead") === "small" ? "small" : "marathon";
const settleAfter = (params.get("quiet") ?? "never") as SettleAfter;
const dock = params.get("dock");

const children = childrenOf(size);
if (params.get("after") === "settle") {
  const now = Date.now();
  for (const row of children) if ((row.status === "completed" || row.status === "interrupted") && row.settledAt === undefined && CHILD_FACTS[row.threadId!]?.subagentOf === undefined) row.settledAt = now;
}
const QUESTION = "Which ticket should the next free builder take?";
const lead = leadSession(size);
if (dock === "question") lead.asking = QUESTION;
const sessions: SessionView[] = [lead, ...OTHERS, ...children];
const workspaces = [MAC, BOX];

type Scope = { workspaceId: string; sessionId: string; turnId: string; threadId: string };
const scopeOf = (row: SessionView, turn = `turn_${row.id}`): Scope => ({ workspaceId: row.workspaceId, sessionId: row.id, turnId: turn, threadId: row.threadId! });
const said = (scope: Scope, text: string, parentToolUseId?: string): SessionEvent => ({ type: "session.delta", ...scope, kind: "text", text, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) }) as SessionEvent;
const call = (scope: Scope, toolUseId: string, toolName: string, input: object, result?: string, parentToolUseId?: string): SessionEvent[] => [
  { type: "session.delta", ...scope, kind: "tool_use", toolName, toolUseId, text: JSON.stringify(input), ...(parentToolUseId === undefined ? {} : { parentToolUseId }) } as SessionEvent,
  ...(result === undefined ? [] : [{ type: "session.delta", ...scope, kind: "tool_result", toolUseId, text: result, ...(parentToolUseId === undefined ? {} : { parentToolUseId }) } as SessionEvent]),
];
const ended = (scope: Scope, row: SessionView): SessionEvent[] =>
  row.status === "running"
    ? []
    : [
        { type: "session.done", ...scope, result: { status: row.status === "failed" ? "error" : row.status === "interrupted" ? "interrupted" : "completed", durationMs: (row.endedAt ?? 0) - (row.startedAt ?? 0), costUsd: 0.4 } } as SessionEvent,
        { type: "session.end", ...scope, exitCode: row.status === "failed" ? 1 : 0, sawResult: true } as SessionEvent,
      ];
const launch = (scope: Scope, toolUseId: string, sub: string): SessionEvent[] => call(scope, toolUseId, "Agent", { description: sessions.find(r => r.threadId === sub)?.prompt ?? "", prompt: CHILD_FACTS[sub]?.prompt ?? "", subagent_type: "Explore" });

/** What each subagent did, as its own lines: what the page of one shows, and what its fold in its lead's
 * timeline holds. */
const SUBAGENT_WORK: Record<string, ReadonlyArray<{ say?: string; tool?: string; input?: object; result?: string }>> = {
  thr_sa_steps: [
    { say: "I'll find where the add sheet builds its list of steps." },
    { tool: "Grep", input: { pattern: "SETUP_ROWS", path: "apps/web/src/settings/add" }, result: "setup.ts:41\nAddComputerDialog.tsx:88\nStepDialog.tsx:12" },
    { tool: "Read", input: { file_path: "/Users/zingzy/wsp/apps/web/src/settings/add/setup.ts" }, result: "212 lines" },
    { say: "SETUP_ROWS in setup.ts holds the order and AddComputerDialog maps over it. Checking the tests next." },
    { tool: "Grep", input: { pattern: "SETUP_ROWS", path: "apps/web/test" } },
  ],
  thr_sa_order: [
    { say: "Reading the add sheet's tests for anything that pins the order." },
    { tool: "Read", input: { file_path: "/Users/zingzy/wsp/apps/web/test/add-sheet.test.tsx" }, result: "164 lines" },
    { say: "add-sheet.test.tsx:41 pins the order in three cases, all green." },
  ],
  thr_sa_map: [
    { say: "Listing the open tickets with no branch yet." },
    { tool: "Bash", input: { command: "gh issue list -R wsp-labs/wsp-map --state open --limit 200 --json number,title,body", description: "List the map's open tickets" }, result: "34 issues" },
    { say: "34 open. Reading each one for the files it names." },
    { tool: "Bash", input: { command: "gh issue view 1830 -R wsp-labs/wsp-map --json body", description: "Read ticket 1830" } },
  ],
  thr_sa_prs: [{ say: "11 open, 4 approved, 7 waiting on a reviewer." }],
  thr_sa_gate: [{ say: "Main is green at 4c5d84d." }],
};
const workOf = (sub: string, scope: Scope, parent?: string): SessionEvent[] =>
  (SUBAGENT_WORK[sub] ?? []).flatMap((step, i) => (step.say !== undefined ? [said(scope, step.say, parent)] : call(scope, `${sub}_t${i}`, step.tool!, step.input ?? {}, step.result, parent)));
const subagentsOf = (threadId: string): SessionView[] => sessions.filter(row => CHILD_FACTS[row.threadId!]?.subagentOf === threadId);

/** The lead's transcript: an earlier turn that ran two subagents, then this turn, held by its own running subagent,
 * with the question it asks or its task list where the page shows those. */
function leadHistory(): SessionEvent[] {
  if (size === "small") {
    const scope = scopeOf(lead, "turn_lead");
    return [{ type: "session.start", ...scope, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: "Land 1841: build, review, merge." } as SessionEvent, said(scope, LEAD_SAID.small), ...ended(scope, { ...lead, status: "completed" })];
  }
  const before = scopeOf(lead, "turn_lead0");
  const now = scopeOf(lead, "turn_lead");
  const earlier = subagentsOf(LEAD).filter(row => CHILD_FACTS[row.threadId!]?.earlierTurn === true);
  const current = subagentsOf(LEAD).filter(row => CHILD_FACTS[row.threadId!]?.earlierTurn !== true);
  return [
    { type: "session.start", ...before, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: "Check the pull requests and main's gate before we start." } as SessionEvent,
    ...earlier.flatMap(row => [...launch(before, `launch_${row.threadId}`, row.threadId!), ...workOf(row.threadId!, before, `launch_${row.threadId}`), { type: "session.delta", ...before, kind: "tool_result", toolUseId: `launch_${row.threadId}`, text: CHILD_FACTS[row.threadId!]?.summary ?? "" } as SessionEvent]),
    said(before, "11 pull requests are open and main is green, so the builders can start from main."),
    { type: "session.done", ...before, result: { status: "completed", durationMs: 96_000, costUsd: 0.6 } } as SessionEvent,
    { type: "session.end", ...before, exitCode: 0, sawResult: true } as SessionEvent,
    { type: "session.start", ...now, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: LEAD_SAID.ask } as SessionEvent,
    said(now, LEAD_SAID.said),
    ...(dock === "tasks" ? [{ type: "session.plan", ...now, steps: TASKS.map(step => ({ text: step.name, state: step.state === "done" ? "done" : step.state === "working" ? "working" : "pending" })) } as SessionEvent] : []),
    ...current.flatMap(row => [...launch(now, `launch_${row.threadId}`, row.threadId!), ...workOf(row.threadId!, now, `launch_${row.threadId}`)]),
    ...(dock === "question"
      ? [
          {
            type: "session.permission",
            ...now,
            askId: "ask_next",
            toolName: "AskUserQuestion",
            toolUseId: "toolu_next",
            input: JSON.stringify({ questions: [{ question: QUESTION, header: "Next", multiSelect: false, options: [{ label: "Lead threads (#1830)", description: "The design the owner is judging now." }, { label: "Whole-page restyles (#1866)", description: "Typing is slow on long threads." }, { label: "Box thread (#1615)", description: "Step 2 of the box thread in the project folder." }] }] }),
            detail: "",
            options: [0, 1, 2].map(i => ({ id: `q0:o${i}`, label: ["Lead threads (#1830)", "Whole-page restyles (#1866)", "Box thread (#1615)"][i]!, effect: "answer" as const })),
          } as SessionEvent,
        ]
      : []),
  ];
}

/** Every other thread's transcript: its ask, its subagents' launches and lines, what it said last, how it ended. A
 * subagent's own page reads its lines alone, with no ask of its own: its prompt stands in its bar. */
function historyOf(row: SessionView): SessionEvent[] {
  const scope = scopeOf(row);
  const facts = CHILD_FACTS[row.threadId!] ?? {};
  if (facts.subagentOf !== undefined) return [{ type: "session.start", ...scope, agent: row.harness, model: "claude-haiku-4-5", cwd: "/Users/zingzy/wsp", prompt: "" } as SessionEvent, ...workOf(row.threadId!, scope), ...ended(scope, row)];
  const subs = subagentsOf(row.threadId!);
  return [
    { type: "session.start", ...scope, agent: row.harness, model: row.harness === "codex" ? "gpt-5.5" : "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: row.prompt ?? "" } as SessionEvent,
    said(scope, facts.lastLine ?? facts.why ?? "On it."),
    ...subs.flatMap(sub => [...launch(scope, `launch_${sub.threadId}`, sub.threadId!), ...workOf(sub.threadId!, scope, `launch_${sub.threadId}`)]),
    ...ended(scope, row),
  ];
}
const historyFor = (workspaceId: string): SessionEvent[] => [...(workspaceId === MAC.id ? leadHistory() : []), ...sessions.filter(row => row.workspaceId === workspaceId && row.threadId !== LEAD).flatMap(historyOf)];

/** The lead's task list as the agent last wrote it. */
const TASKS: StepLine[] = [
  { id: "t1", name: "Read the open tickets on the map", state: "done", ms: 74_000 },
  { id: "t2", name: "Start a builder per ticket", state: "done", ms: 31_000 },
  { id: "t3", name: "Start a reviewer per pull request", state: "working", ms: 12_000, ticking: true },
  { id: "t4", name: "Run fix rounds until each review passes", state: "waiting" },
  { id: "t5", name: "Merge what passed into main", state: "waiting" },
  { id: "t6", name: "Report what needs the person", state: "waiting" },
];

const catalogs: HarnessCatalog[] = [
  {
    harness: "claude",
    label: "Claude Code",
    source: "harness",
    version: "2.1.286",
    models: [{ value: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, contextWindows: [] }],
    efforts: [{ value: "high", label: "High", isDefault: true }],
    contextWindows: [],
    permissionModes: ACCESS_MODES,
    steers: true,
    renames: true,
    images: true,
    movesAccess: true,
    access: { ask: "default", "auto-edit": "acceptEdits", full: "bypassPermissions" },
    bypassMode: "bypassPermissions",
  },
  { harness: "codex", label: "Codex", source: "table", version: "0.47.0", models: [{ value: "gpt-5.5", label: "GPT-5.5", isDefault: true }], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false },
];

/** A change the host made to some threads, then the list read again where they live, as a host event would ask. */
function hostChanged(keys: ReadonlyArray<string>, change: (row: SessionView) => void): void {
  const touched = new Set<string>();
  for (const row of sessions) {
    if (!keys.includes(row.threadId ?? row.id)) continue;
    change(row);
    touched.add(row.workspaceId);
  }
  for (const id of touched) void useStore.getState().reloadSessions(id);
}
const endTurn = (row: SessionView, status: SessionView["status"]): void => {
  row.status = status;
  row.endedAt = Date.now();
  delete row.asking;
  delete row.capped;
};

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id) ?? MAC,
  createWorkspace: async () => MAC,
  watchStatuses: async () => workspaces.map(w => statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 26.1", uptimeMs: 3 * 86_400_000, folder: w.project.path } })),
  forget: async () => {},
  nap: async () => MAC,
  wake: async () => MAC,
  capabilities: async () => caps(),
  startSession: async (opts: StartSessionOptions) => {
    hostChanged([opts.thread ?? ""], row => {
      row.status = "running";
      row.startedAt = Date.now();
      delete row.endedAt;
      delete row.readAt;
      delete row.settledAt;
    });
    return sessions.find(row => row.threadId === opts.thread) ?? lead;
  },
  interruptSession: async sessionId => {
    const row = sessions.find(s => s.id === sessionId);
    if (row !== undefined) hostChanged([row.threadId!], r => endTurn(r, "interrupted"));
    return { outcome: "accepted" };
  },
  settleThreads: async keys => hostChanged(keys, row => void (row.settledAt = Date.now())),
  restoreThreads: async keys => hostChanged(keys, row => void delete row.settledAt),
  readThread: async key => hostChanged([key], row => void (row.readAt = Date.now())),
  markThreads: async () => {},
  answerPermission: async () => "answered",
  portReach: async (_id, port) => ({ url: `http://127.0.0.1:${port}`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async id => historyFor(id),
  setSessionAccess: async () => "set",
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async id => (id === undefined ? sessions : sessions.filter(row => row.workspaceId === id)).map(row => ({ ...row })),
  renameSession: async () => ({ outcome: "renamed" }),
  renameWorkspace: async () => MAC,
  setWorkspaceLook: async () => MAC,
  listHarnesses: async () => catalogs,
  subscribe: () => () => {},
  getGolden: async () => undefined,
  listProjectGoldens: async () => [],
} as Api;

useStore.setState({
  conn: "live",
  selectedId: MAC.id,
  places: [HERE, HETZNER],
  placesRead: true,
  projects: [PROJECT],
  projectsRead: true,
  preferences: { ...DEFAULT_PREFERENCES, theme, ...picks, settleAfter, labs: false, projectLook: { pr_wsp: { icon: "terminal" as const, hue: "amber" as const } } },
});
useStore.getState().bind(api);
useStore.getState().select(MAC.id, dock === "subagent" ? "thr_sa_steps" : dock === "subagent-done" ? "thr_sa_order" : LEAD);
useRightPanelStore.setState({ byWorkspaceId: {} });
useRightPanelStore.getState().close(MAC.id);

const folds = ["finished", "settled"].filter(part => params.get(part) === "1");
useLeadUi.setState({
  open: Object.fromEntries([
    ...folds.flatMap(part => [[`transcript:${LEAD}:${part}`, true], [`sidebar:${LEAD}:${part}`, true]]),
    ...(params.get("nested") === "1" ? [["transcript:thr_c_ssh:finished", true], ["sidebar:thr_c_ssh:finished", true], ["sidebar:thr_c_sheet:finished", true], ["transcript:thr_c_sheet:finished", true]] : []),
  ]),
  sending: params.get("send"),
  shown: params.get("acts"),
});
if (params.has("shut")) useLeadShut.setState(s => ({ shut: { ...s.shut, [LEAD]: params.get("shut") === "1" } }));

/** Every state the page draws, by the query a shot takes. */
const STATES: ReadonlyArray<readonly [string, string]> = [
  ["Marathon", ""],
  ["Threads shut: one row fading (pick)", "shut=1"],
  ["Threads shut: two rows fading", "shut=1&shut-shape=peek2"],
  ["Threads shut: head alone", "shut=1&shut-shape=line"],
  ["Connector: guide, no elbows", "rail=guide"],
  ["Finished open", "finished=1"],
  ["Nested folds open", "nested=1"],
  ["Settled open", "settled=1"],
  ["A row's acts", "acts=thr_c_sheet"],
  ["A subagent's acts", "acts=thr_sa_steps"],
  ["Send a message", "send=thr_c_sheet"],
  ["Bar: a subagent's page", "dock=subagent"],
  ["Bar: a subagent that ended", "dock=subagent-done"],
  ["Bar: a question", "dock=question"],
  ["Bar: the task list", "dock=tasks"],
  ["After Settle all", "after=settle"],
  ["Quiet rule at 2h", "quiet=2h"],
  ["Small lead", "lead=small"],
];
const norm = (q: string) => {
  const p = new URLSearchParams(q);
  for (const k of ["theme", "renders", "bar"]) p.delete(k);
  return p.toString();
};
const here = norm(location.search);
const picked = STATES.find(([, q]) => norm(q) === here)?.[1];
const go = (q: string, t: "light" | "dark") => {
  location.search = [q, `theme=${t}`].filter(Boolean).join("&");
};
const finishOne = () => {
  CHILD_FACTS["thr_c_cap2"] = { lastLine: "Rebased fix/1866-has-rules onto main, no conflicts." };
  hostChanged(["thr_c_cap2"], row => endTurn(row, "completed"));
};
const startOne = () =>
  hostChanged(["thr_c_cap1"], row => {
    delete row.capped;
    row.startedAt = Date.now();
  });
const showBar = params.get("bar") !== "0";
function StateBar() {
  return (
    <div data-state-bar className="fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border/60 bg-popover/95 p-1 shadow-lg backdrop-blur-sm">
      <select aria-label="State" value={picked ?? "custom"} onChange={event => go(event.target.value, theme)} className="h-6 rounded-md border border-border/60 bg-transparent px-2 text-xs text-foreground outline-none">
        {picked === undefined ? <option value="custom">{here}</option> : null}
        {STATES.map(([label, q]) => (
          <option key={label} value={q}>
            {label}
          </option>
        ))}
      </select>
      {size === "marathon" ? (
        <>
          <Button size="xs" variant="outline" onClick={startOne}>
            Start one
          </Button>
          <Button size="xs" variant="outline" onClick={finishOne}>
            Finish one
          </Button>
        </>
      ) : null}
      <Button size="xs" variant="outline" onClick={() => go(here, theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? "Light" : "Dark"}
      </Button>
    </div>
  );
}

/** A subagent's page: its own lines through the real ChatView, its bar in the composer's place. */
function SubagentPage({ workspaceId, threadId, leadKey }: { workspaceId: string; threadId: string; leadKey: string }) {
  const threads = useSidebarProjects().flatMap(project => project.threads);
  const me = threads.find(t => (t.threadId ?? t.id) === threadId);
  const leadThread = threads.find(t => (t.threadId ?? t.id) === leadKey);
  return <ChatView workspaceId={workspaceId} threadId={threadId}>{() => (me === undefined ? null : <SubagentDock subagent={me} lead={leadThread} />)}</ChatView>;
}

/** The lead with its task list opened from the composer's drawer into the composer's place, and back. */
function TasksPage({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(true);
  return <ChatView workspaceId={workspaceId} threadId={LEAD}>{thread => (open ? <TaskDock steps={TASKS} onWrite={() => setOpen(false)} /> : <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />)}</ChatView>;
}

/** The thread the person opened, the lead until they open one of its children or subagents; Settings while it is
 * open, so the lists can be judged beside a Settings page in the same theme, as App's own centre does. */
function Center() {
  const settingsOpen = useSettingsOpen();
  const workspaceId = useStore(s => s.selectedId) ?? MAC.id;
  const threadId = useStore(s => s.selectedThreadId) ?? LEAD;
  if (settingsOpen) return <SettingsPage />;
  const of = CHILD_FACTS[threadId]?.subagentOf;
  if (of !== undefined) return <SubagentPage key={threadId} workspaceId={workspaceId} threadId={threadId} leadKey={of} />;
  if (dock === "tasks" && threadId === LEAD) return <TasksPage key={threadId} workspaceId={workspaceId} />;
  return <WorkspaceThread key={threadId} workspaceId={workspaceId} threadId={threadId} />;
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {showBar ? <StateBar /> : null}
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <Center />
      </div>
    </AppShell>
  </TooltipProvider>,
);
