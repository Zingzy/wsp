// SPDX-License-Identifier: AGPL-3.0-only
// The lead and its children the prototype draws, as the host would list them: a coordinator thread on the wsp
// project that opened 77 threads in one day, 8 of them live, 60 finished and 9 settled, the size the owner's own
// marathon reached, three of them with threads of their own, and subagents of the lead's own agent and of one child.
// ?lead=small is a lead with three children, the common case. CHILD_FACTS holds what a child's row reads that the
// thread row does not carry yet: its reply's last line, why it failed, the thread a restart replaced, and for a
// subagent its prompt, summary and model. The build adds the first three to the row (the host already has the last
// line for `threads wait`) and reads a subagent off its lead's `subagents`; here a subagent rides a session row of
// its own so the page can draw its lines through the real ChatView, and CHILD_FACTS marks it with `subagentOf`.
import type { PlaceView, ProjectView, SessionView, WorkspaceView } from "@wsp/protocol";

export const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0" } };
export const HETZNER: PlaceView = { id: "hetzner", kind: "computer", name: "hetzner", label: "hetzner", default: false, present: true, shape: { cpu: 2, memMb: 7782 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0" } } as PlaceView;
export const PROJECT: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/zingzy/wsp" }, path: "/Users/zingzy/wsp", remote: "github.com/wsp-labs/wsp", defaultBranch: "main", memoryKey: "pr_wsp", memoryDir: "/m" } as ProjectView;
export const MAC: WorkspaceView = { id: "ws_m", name: "wsp", kind: "local", machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-08T03:00:00Z", place: "here" } as WorkspaceView;
export const BOX: WorkspaceView = { id: "ws_h", name: "wsp-review", kind: "local", machineId: "hetzner", project: { id: PROJECT.id, name: PROJECT.name, path: "/root/wsp", computer: "hetzner" }, phase: "running", golden: "", createdAt: "2026-10-08T09:00:00Z", place: "hetzner", parentThreadId: "thr_lead" } as WorkspaceView;

export const LEAD = "thr_lead";
const NOW = Date.now();
export const ago = (m: number): number => NOW - m * 60_000;

/** What a child's row reads beyond the thread row: its reply's last line, why it failed, and the restart link. */
export interface ChildFacts {
  readonly lastLine?: string;
  readonly why?: string;
  /** The thread this one was started again in place of. */
  readonly replaces?: string;
  /** The restart that took this one's place. */
  readonly replacedBy?: string;
  /** Set on a subagent: the thread whose agent runs it, and what it carries on its hover card and its page. */
  readonly subagentOf?: string;
  readonly prompt?: string;
  readonly summary?: string;
  readonly model?: string;
  /** A subagent of a turn of its lead that is over, however its lead stands now. */
  readonly earlierTurn?: boolean;
}
export const CHILD_FACTS: Record<string, ChildFacts> = {};

interface Child {
  key: string;
  title: string;
  status: SessionView["status"];
  started: number;
  ended?: number;
  read?: boolean;
  settled?: boolean;
  harness?: string;
  asking?: string;
  capped?: SessionView["capped"];
  on?: WorkspaceView;
  facts?: ChildFacts;
  /** The thread that opened it, the lead when absent. */
  parent?: string;
}

const child = (c: Child): SessionView => {
  if (c.facts !== undefined) CHILD_FACTS[`thr_${c.key}`] = c.facts;
  const ended = c.ended === undefined ? undefined : ago(c.ended);
  return {
    id: `s_${c.key}`,
    threadId: `thr_${c.key}`,
    workspaceId: (c.on ?? MAC).id,
    parentThreadId: c.parent ?? LEAD,
    rootThreadId: LEAD,
    harness: c.harness ?? "claude",
    status: c.status,
    prompt: c.title,
    harnessTitle: c.title,
    startedBy: "agent",
    startedAt: ago(c.started),
    ...(ended !== undefined ? { endedAt: ended } : {}),
    ...(c.read === true && ended !== undefined ? { readAt: ended + 30_000 } : {}),
    ...(c.settled === true && ended !== undefined ? { settledAt: ended + 60_000 } : {}),
    ...(c.asking !== undefined ? { asking: c.asking } : {}),
    ...(c.capped !== undefined ? { capped: c.capped } : {}),
  } as SessionView;
};

const CAP = { placeId: "here", place: "zingzy's MacBook Pro", running: 6, atOnce: 6 };

const LIVE: Child[] = [
  { key: "c_ask", title: "Build: box thread in the project folder (#1615 step 1)", status: "running", started: 23, asking: "Run pnpm install --frozen-lockfile in /Users/zingzy/wsp" },
  { key: "c_fail", title: "Fix: main's desktop smoke is red (#1827)", status: "failed", started: 31, ended: 4, facts: { why: "pnpm test exited 1: 3 tests failed in apps/desktop/test/smoke.test.ts" } },
  { key: "c_sec2", title: "Landing fix: security fixes (#1805)", status: "running", started: 7, facts: { replaces: "thr_c_sec1" } },
  { key: "c_sheet", title: "Fix round: the add sheet (#1815)", status: "running", started: 12 },
  { key: "c_ssh", title: "Landing fix: ssh same-computer check (#1811)", status: "running", started: 3 },
  { key: "c_rev", title: "Review 1822: the worktree carry", status: "running", started: 9, harness: "codex", on: BOX },
  { key: "c_cap1", title: "Build: lead threads design (#1830)", status: "running", started: 2, capped: CAP },
  { key: "c_cap2", title: "Rebase: fix/1866-has-rules onto main", status: "running", started: 1, capped: CAP },
];

/** The tickets the day's builders, reviewers, fix rounds and rebases were opened for, newest first. */
const TICKETS: ReadonlyArray<readonly [number, string, string]> = [
  [1866, "whole-page restyles on typing", "has-rules"],
  [1858, "a lead's steer is held while it waits", "lead-steer-hold"],
  [1856, "the stop line after a held reply", "held-stop-line"],
  [1849, "a box lists the server its launches carry", "box-servers"],
  [1845, "threads at once waits and says so", "thread-cap"],
  [1841, "the Usage page's reset words", "usage-resets"],
  [1838, "sign-in prepare on a fresh box", "signin-prepare"],
  [1834, "the palette finds a settled thread", "palette-settled"],
  [1829, "a lead's children on a cloud", "lead-children-cloud"],
  [1826, "the composer's focus after a dock", "composer-focus"],
  [1822, "the worktree carry", "worktree-carry"],
  [1819, "skills search refuses an empty query", "skills-empty"],
  [1815, "the running sheet", "running-sheet"],
  [1812, "the recipe moves one project folder", "recipe-move"],
  [1808, "the pty tests through one helper", "pty-helper"],
  [1804, "every install road names its sum", "install-sums"],
  [1801, "a tag from main's line", "release-tag"],
  [1797, "hooks from outside the tree", "outside-hooks"],
  [1793, "the switcher pictures and an old theme", "switcher-theme"],
  [1790, "panels on a box thread read the box", "box-panels"],
];

const KINDS: ReadonlyArray<readonly [string, (n: number, slug: string, i: number) => string]> = [
  ["Build", (n, slug, i) => `Pushed ticket/${n}-${slug}, ${3 + (i % 6)} files, gate green.`],
  ["Review", (n, _slug, i) => (i % 3 === 0 ? `Approved PR #${n - 700}, no findings.` : `Posted on PR #${n - 700}: ${1 + (i % 3)} findings, none blocking.`)],
  ["Fix round", (_n, _slug, i) => `${1 + (i % 2) === 1 ? "The finding is" : "Both findings are"} fixed and pushed, gate green.`],
];

const titleOf = (kind: string, n: number, name: string): string => (kind === "Review" ? `Review ${n}: ${name}` : `${kind}: ${name} (#${n})`);

/** 60 finished children, newest first: the five newest nobody has opened, three stopped mid-work, the rest read. */
const FINISHED: Child[] = TICKETS.flatMap(([n, name, slug], t) =>
  KINDS.map(([kind, line], k): Child => {
    const i = t * KINDS.length + k;
    const ended = 6 + i * 9;
    const stopped = i === 7 || i === 22 || i === 41;
    return {
      key: `f${i}`,
      title: titleOf(kind, n, name),
      status: stopped ? "interrupted" : "completed",
      started: ended + 14 + (i % 5) * 6,
      ended,
      read: i >= 5,
      facts: { lastLine: stopped ? `Reading apps/web/src/sidebar/threadTree.ts for the ${slug} change` : line(n, slug, i) },
    };
  }),
);

const SETTLED: Child[] = [
  { key: "c_sec1", title: "Landing fix: security fixes (#1805)", status: "interrupted", started: 30, ended: 8, read: true, settled: true, facts: { lastLine: "Running the gate on the CSP change", replacedBy: "thr_c_sec2" } },
  ...["Rebase: fix/1780-held-send onto main", "Build: thread heads in one request (#1776)", "Review 1776: thread heads in one request", "Fix round: thread heads (#1776)", "Build: the cloud nudge waits for room (#1771)", "Review 1771: the cloud nudge", "Rebase: feat/1766-snooze onto main", "Build: settle by drag (#1762)"].map(
    (title, i): Child => ({ key: `s${i}`, title, status: "completed", started: 620 + i * 20, ended: 600 + i * 20, read: true, settled: true, facts: { lastLine: "Pushed and merged, gate green." } }),
  ),
];

/** Threads two of the children opened themselves: a builder's reviewer and its rebase, and a reviewer's probe. */
const NESTED: Child[] = [
  { key: "g_rev", parent: "thr_c_ssh", title: "Review 1811: ssh same-computer check", status: "running", started: 2, harness: "codex" },
  { key: "g_rebase", parent: "thr_c_ssh", title: "Rebase: ticket/1811-ssh-check onto main", status: "completed", started: 3, ended: 2, facts: { lastLine: "Rebased onto main at 4c5d84d, no conflicts." } },
  { key: "g_probe", parent: "thr_c_rev", title: "Probe: the worktree carry on a box", status: "failed", started: 8, ended: 5, harness: "codex", on: BOX, facts: { why: "git worktree add exited 128: /root/wsp is not a git repository" } },
];

/** An agent's own subagents: two of the add sheet's fix round, one running and one done; the lead's own running
 * one; and two of the lead's earlier turn, which have folded away with that turn. */
const subagent = (key: string, of: string, title: string, state: "running" | "done" | "failed" | "stopped", started: number, facts: Omit<ChildFacts, "subagentOf">, ended?: number): Child => ({
  key,
  parent: of,
  title,
  status: state === "running" ? "running" : state === "done" ? "completed" : state === "failed" ? "failed" : "interrupted",
  started,
  ...(ended !== undefined ? { ended, read: true } : {}),
  facts: { ...facts, subagentOf: of },
});
const SUBAGENTS: Child[] = [
  subagent("sa_steps", "thr_c_sheet", "Find where the add sheet reads its steps", "running", 4, { model: "Haiku 4.5", prompt: "Find every place the add sheet reads its list of steps: the component, the logic file and any test that pins the order. Report the files and lines, and nothing else." }),
  subagent("sa_order", "thr_c_sheet", "Check the sheet's tests for the step order", "done", 9, { model: "Haiku 4.5", prompt: "Read the add sheet's tests and say whether any of them pins the order of the steps.", summary: "add-sheet.test.tsx:41 pins the order in three cases, all green.", lastLine: "add-sheet.test.tsx:41 pins the order in three cases, all green." }, 6),
  subagent("sa_map", LEAD, "Read the open tickets on the map", "running", 1, { model: "Opus 5.5", prompt: "Read every open ticket on wsp-labs/wsp-map with no branch yet, and list them with the files each one names." }),
  subagent("sa_prs", LEAD, "List the open pull requests", "done", 60, { model: "Haiku 4.5", earlierTurn: true, prompt: "List the open pull requests on wsp-labs/wsp with their review state.", summary: "11 open, 4 approved, 7 waiting on a reviewer.", lastLine: "11 open, 4 approved, 7 waiting on a reviewer." }, 58),
  subagent("sa_gate", LEAD, "Check main's gate", "done", 62, { model: "Haiku 4.5", earlierTurn: true, prompt: "Run the gate on main and report what fails.", summary: "Main is green at 4c5d84d.", lastLine: "Main is green at 4c5d84d." }, 57),
];

const SMALL: Child[] = [
  { key: "m_work", title: "Build: the reset words on the Usage page (#1841)", status: "running", started: 6 },
  { key: "m_ask", title: "Review 1841: the reset words", status: "running", started: 4, harness: "codex", asking: "Run gh pr view 1153 --comments" },
  { key: "m_done", title: "Rebase: feat/1841-usage-resets onto main", status: "completed", started: 9, ended: 3, facts: { lastLine: "Rebased onto main at 4c5d84d, no conflicts, gate green." } },
];

export type LeadSize = "marathon" | "small";

/** Every child of the lead at that size, as the host lists them. */
export const childrenOf = (size: LeadSize): SessionView[] => (size === "small" ? SMALL : [...LIVE, ...NESTED, ...SUBAGENTS, ...FINISHED, ...SETTLED]).map(child);

/** The lead itself. The marathon's turn is still going, held by its own subagent; the small lead's is over, waiting on
 * its children's finished lines. */
export const leadSession = (size: LeadSize): SessionView =>
  ({
    id: "s_lead",
    threadId: LEAD,
    workspaceId: MAC.id,
    harness: "claude",
    status: size === "small" ? "completed" : "running",
    prompt: size === "small" ? "Land 1841" : "Coordinator: the marathon",
    harnessTitle: size === "small" ? "Land 1841" : "Coordinator: the marathon",
    startedBy: "person",
    startedAt: ago(size === "small" ? 12 : 2),
    ...(size === "small" ? { endedAt: ago(1), readAt: ago(0.5) } : {}),
  }) as SessionView;

/** The other trees in the sidebar, so the lead is drawn among the work it sits beside. */
export const OTHERS: SessionView[] = [
  { id: "s_o1", threadId: "thr_o1", workspaceId: MAC.id, harness: "claude", status: "running", prompt: "Probe: send latency on the relay", harnessTitle: "Probe: send latency on the relay", startedBy: "person", startedAt: ago(5), asking: "Fetch https://relay.wsp.dev/metrics" } as SessionView,
  { id: "s_o2", threadId: "thr_o2", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Questions with visual options", harnessTitle: "Questions with visual options", startedBy: "person", startedAt: ago(150), endedAt: ago(140), readAt: ago(130) } as SessionView,
];

export const LEAD_SAID = {
  ask: "Run the marathon: build, review and land every open ticket on the map, a builder per ticket, a reviewer per pull request, fix rounds until the reviewer passes it. Tell me when a thing needs me.",
  said: "Eight threads are out. 1805's builder hung on the CSP gate, so I stopped it and started it again; 1827 failed on the desktop smoke and I'll read its log next. 1615 is waiting on you to allow its install, and two builds are waiting for a slot on your MacBook. A subagent is reading the rest of the map's open tickets.\n\nI'll take each report as it lands.",
  small: "Started a builder and a reviewer for 1841; the rebase is done. I'll merge once the review passes.",
};
