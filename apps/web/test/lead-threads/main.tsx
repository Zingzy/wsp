// SPDX-License-Identifier: AGPL-3.0-only
// The lead threads prototype: the app shell over a fake host, open on a coordinator thread whose children are
// drawn by LeadThreads in its transcript and under its tile in the sidebar. Served by its own vite (see
// vite.config.ts beside this file), in either theme (?theme=light). ?lead=small is a lead with three children;
// ?quiet=2h folds children by the quiet rule the sidebar settles by, where the default draws all 60 finished;
// ?after=settle is the marathon after Settle all; ?finished=1 and ?settled=1 open those folds in both places;
// ?acts=<thread> shows that row's acts as its hover does; ?send=<thread> opens its message field; ?renders=1 stamps
// each transcript row with how many times it drew, so a status change can be seen to draw its row alone; ?bar=0
// hides the state bar for a shot.
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type SessionEvent, type SessionView, type SettleAfter } from "@wsp/protocol";
import { Button } from "../../src/components/ui/button";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api, StartSessionOptions } from "../../src/protocol/client";
import { useSettingsOpen, useStore } from "../../src/protocol/store";
import { SettingsPage } from "../../src/settings/SettingsPage";
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
import { BOX, CHILD_FACTS, HERE, HETZNER, LEAD, LEAD_SAID, MAC, OTHERS, PROJECT, childrenOf, leadSession, type LeadSize } from "./fixtures";
import { useLeadUi } from "./LeadThreads";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
const size: LeadSize = params.get("lead") === "small" ? "small" : "marathon";
const settleAfter = (params.get("quiet") ?? "never") as SettleAfter;

const children = childrenOf(size);
if (params.get("after") === "settle") {
  const now = Date.now();
  for (const row of children) if ((row.status === "completed" || row.status === "interrupted") && row.settledAt === undefined) row.settledAt = now;
}
const sessions: SessionView[] = [leadSession(size), ...OTHERS, ...children];
const workspaces = [MAC, BOX];

/** Each thread's transcript as the host keeps it: its ask, what it said last, and how its turn ended. */
function historyOf(row: SessionView, said: string): SessionEvent[] {
  const scope = { workspaceId: row.workspaceId, sessionId: row.id, turnId: `turn_${row.id}`, threadId: row.threadId! };
  const over = row.status !== "running";
  return [
    { type: "session.start", ...scope, agent: row.harness, model: row.harness === "codex" ? "gpt-5.5" : "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: row.prompt ?? "" },
    { type: "session.delta", ...scope, kind: "text", text: said },
    ...(over
      ? ([
          { type: "session.done", ...scope, result: { status: row.status === "failed" ? "error" : row.status === "interrupted" ? "interrupted" : "completed", durationMs: (row.endedAt ?? 0) - (row.startedAt ?? 0), costUsd: 0.4 } },
          { type: "session.end", ...scope, exitCode: row.status === "failed" ? 1 : 0, sawResult: true },
        ] as SessionEvent[])
      : []),
  ] as SessionEvent[];
}
const lead = sessions[0]!;
const leadHistory: SessionEvent[] = [
  { type: "session.start", workspaceId: MAC.id, sessionId: lead.id, turnId: "turn_lead", threadId: LEAD, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: size === "small" ? "Land 1841: build, review, merge." : LEAD_SAID.ask },
  { type: "session.delta", workspaceId: MAC.id, sessionId: lead.id, turnId: "turn_lead", threadId: LEAD, kind: "text", text: size === "small" ? LEAD_SAID.small : LEAD_SAID.said },
  { type: "session.done", workspaceId: MAC.id, sessionId: lead.id, turnId: "turn_lead", threadId: LEAD, result: { status: "completed", durationMs: 412_000, costUsd: 3.1 } },
  { type: "session.end", workspaceId: MAC.id, sessionId: lead.id, turnId: "turn_lead", threadId: LEAD, exitCode: 0, sawResult: true },
] as SessionEvent[];
const historyFor = (workspaceId: string): SessionEvent[] => [
  ...(workspaceId === MAC.id ? leadHistory : []),
  ...sessions
    .filter(row => row.workspaceId === workspaceId && row.threadId !== LEAD)
    .flatMap(row => historyOf(row, CHILD_FACTS[row.threadId!]?.lastLine ?? CHILD_FACTS[row.threadId!]?.why ?? "On it.")),
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
useStore.getState().select(MAC.id, LEAD);
useRightPanelStore.setState({ byWorkspaceId: {} });
useRightPanelStore.getState().close(MAC.id);

const folds = ["finished", "settled"].filter(part => params.get(part) === "1");
useLeadUi.setState({
  open: Object.fromEntries(folds.flatMap(part => [[`transcript:${LEAD}:${part}`, true], [`sidebar:${LEAD}:${part}`, true]])),
  sending: params.get("send"),
  shown: params.get("acts"),
});

/** Every state the page draws, by the query a shot takes; the bar is for a person and hides from a driven browser. */
const STATES: ReadonlyArray<readonly [string, string]> = [
  ["Marathon, 60 finished", ""],
  ["Finished open", "finished=1"],
  ["Settled open", "settled=1"],
  ["A row's acts", "acts=thr_c_sheet"],
  ["A failed row's acts", "acts=thr_c_fail"],
  ["Send a message", "send=thr_c_sheet"],
  ["After Settle all", "after=settle"],
  ["Quiet rule at 2h", "quiet=2h"],
  ["Small lead", "lead=small"],
  ["Small lead, Finished open", "lead=small&finished=1"],
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
  CHILD_FACTS["thr_c_ssh"] = { lastLine: "Pushed ticket/1811-ssh-check, 2 files, gate green." };
  hostChanged(["thr_c_ssh"], row => endTurn(row, "completed"));
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

/** The thread the person opened, the lead until they open one of its children; Settings while it is open, so the
 * lists can be judged beside a Settings page in the same theme, as App's own centre does. */
function Center() {
  const settingsOpen = useSettingsOpen();
  const workspaceId = useStore(s => s.selectedId) ?? MAC.id;
  const threadId = useStore(s => s.selectedThreadId) ?? LEAD;
  if (settingsOpen) return <SettingsPage />;
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
