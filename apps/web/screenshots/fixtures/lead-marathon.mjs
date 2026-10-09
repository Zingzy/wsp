// SPDX-License-Identifier: AGPL-3.0-only
// The coordinator thread every lead-thread shot is taken on, ported from the prototype's fixtures.ts and main.tsx: the
// same children, titles, second lines and times, so a shot lines up with its frozen one.
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { AT, ago, HERE_LABEL, place, project, projectDest, runCall, sessionId, store, subagentLines, THIS_COMPUTER, threadId, turnId, uuidFor, workspace } from "../fixture-kit.mjs";

const LEAD = "lead";
const MAC = "ws_wsp";
const BOX = "ws_hetzner";
const FOLDER = { [MAC]: () => projectDest("wsp"), [BOX]: () => "/root/wsp" };
const PROJECT = { [MAC]: "wsp", [BOX]: "pr_wsp-hetzner" };
const MODEL = { claude: "claude-opus-5-5", codex: "gpt-5.5" };

/** What a child's thread stood on when its start was held: this computer running as many threads as it takes. */
const CAP = { placeId: HERE, place: HERE_LABEL, running: 6, atOnce: 6 };

/** The question the lead's turn is stopped on, as its AskUserQuestion call asks it. */
const QUESTION = "Which ticket should the next free builder take?";
const PICKS = [
  ["Lead threads (#1830)", "The design the owner is judging now."],
  ["Whole-page restyles (#1866)", "Typing is slow on long threads."],
  ["Box thread (#1615)", "Step 2 of the box thread in the project folder."],
];
const ASK_INPUT = JSON.stringify({ questions: [{ question: QUESTION, header: "Next", multiSelect: false, options: PICKS.map(([label, description]) => ({ label, description })) }] });

/** The install the first builder waits on the person to allow. */
const install = () => JSON.stringify({ command: "pnpm install --frozen-lockfile", description: `Run pnpm install --frozen-lockfile in ${projectDest("wsp")}` });

const LIVE = [
  { id: "c-ask", title: "Build: box thread in the project folder (#1615 step 1)", status: "running", started: 23, asking: "install" },
  { id: "c-fail", title: "Fix: main's desktop smoke is red (#1827)", status: "failed", started: 31, ended: 4, failure: "pnpm test exited 1: 3 tests failed in apps/desktop/test/smoke.test.ts" },
  { id: "c-sec2", title: "Landing fix: security fixes (#1805)", status: "running", started: 7 },
  { id: "c-sheet", title: "Fix round: the add sheet (#1815)", status: "running", started: 12 },
  { id: "c-ssh", title: "Landing fix: ssh same-computer check (#1811)", status: "running", started: 3 },
  { id: "c-rev", title: "Review 1822: the worktree carry", status: "running", started: 9, agent: "codex", on: BOX },
  { id: "c-cap1", title: "Build: lead threads design (#1830)", status: "running", started: 2, capped: CAP },
  { id: "c-cap2", title: "Rebase: fix/1866-has-rules onto main", status: "running", started: 1, capped: CAP },
];

/** The tickets the day's builders, reviewers, fix rounds and rebases were opened for, newest first. */
const TICKETS = [
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

const KINDS = [
  ["Build", (n, slug, i) => `Pushed ticket/${n}-${slug}, ${3 + (i % 6)} files, gate green.`],
  ["Review", (n, _slug, i) => (i % 3 === 0 ? `Approved PR #${n - 700}, no findings.` : `Posted on PR #${n - 700}: ${1 + (i % 3)} findings, none blocking.`)],
  ["Fix round", (_n, _slug, i) => `${1 + (i % 2) === 1 ? "The finding is" : "Both findings are"} fixed and pushed, gate green.`],
];

const titleOf = (kind, n, name) => (kind === "Review" ? `Review ${n}: ${name}` : `${kind}: ${name} (#${n})`);

/** 60 finished children, newest first: the five newest nobody has opened, three stopped mid-work, the rest read. */
const FINISHED = TICKETS.flatMap(([n, name, slug], t) =>
  KINDS.map(([kind, line], k) => {
    const i = t * KINDS.length + k;
    const ended = 6 + i * 9;
    const stopped = i === 7 || i === 22 || i === 41;
    return {
      id: `f${i}`,
      title: titleOf(kind, n, name),
      status: stopped ? "interrupted" : "completed",
      started: ended + 14 + (i % 5) * 6,
      ended,
      read: i >= 5,
      lastLine: stopped ? `Reading apps/web/src/sidebar/threadTree.ts for the ${slug} change` : line(n, slug, i),
    };
  }),
);

const SETTLED = [
  { id: "c-sec1", title: "Landing fix: security fixes (#1805)", status: "interrupted", started: 30, ended: 8, read: true, settled: true, lastLine: "Running the gate on the CSP change" },
  ...["Rebase: fix/1780-held-send onto main", "Build: thread heads in one request (#1776)", "Review 1776: thread heads in one request", "Fix round: thread heads (#1776)", "Build: the cloud nudge waits for room (#1771)", "Review 1771: the cloud nudge", "Rebase: feat/1766-snooze onto main", "Build: settle by drag (#1762)"].map(
    (title, i) => ({ id: `s${i}`, title, status: "completed", started: 620 + i * 20, ended: 600 + i * 20, read: true, settled: true, lastLine: "Pushed and merged, gate green." }),
  ),
];

/** Threads two of the children opened themselves: a builder's reviewer and its rebase, and a reviewer's probe. */
const NESTED = [
  { id: "g-rev", parent: "c-ssh", title: "Review 1811: ssh same-computer check", status: "running", started: 2, agent: "codex" },
  { id: "g-rebase", parent: "c-ssh", title: "Rebase: ticket/1811-ssh-check onto main", status: "completed", started: 3, ended: 2, lastLine: "Rebased onto main at 4c5d84d, no conflicts." },
  { id: "g-probe", parent: "c-rev", title: "Probe: the worktree carry on a box", status: "failed", started: 8, ended: 5, agent: "codex", on: BOX, failure: "git worktree add exited 128: /root/wsp is not a git repository" },
  { id: "gg-ssh", parent: "g-rev", title: "Probe: the same-computer check from hetzner", status: "running", started: 1, on: BOX },
];

/** The agents' own subagents, by the thread whose turn runs them: two of the add sheet's fix round, one running and
 * one done; the lead's own running one and one that failed; one stopped under the security restart; and two of the
 * lead's earlier turn. */
const SUBAGENTS = {
  "c-sheet": [
    {
      id: "sa-steps",
      title: "Find where the add sheet reads its steps",
      state: "running",
      started: 4,
      model: "claude-haiku-4-5",
      prompt: "Find every place the add sheet reads its list of steps: the component, the logic file and any test that pins the order. Report the files and lines, and nothing else.",
      work: [
        { say: "I'll find where the add sheet builds its list of steps, then every test that pins their order." },
        { tool: "Grep", input: { pattern: "SETUP_ROWS", path: "apps/web/src/settings/add" }, result: "setup.ts:41\nAddComputerDialog.tsx:88\nStepDialog.tsx:12" },
        { tool: "Read", input: { file_path: "apps/web/src/settings/add/setup.ts" }, result: "212 lines" },
        { say: "SETUP_ROWS in setup.ts:41 is the one list: eight rows, each with an id, its words and the state it starts in. The sheet never reorders it; it only filters out the rows a computer of that kind skips." },
        { tool: "Read", input: { file_path: "apps/web/src/settings/add/AddComputerDialog.tsx" }, result: "318 lines" },
        { say: "AddComputerDialog.tsx:88 maps SETUP_ROWS straight into StepRow, so the order on screen is the order in setup.ts. StepDialog.tsx:12 only frames them." },
        { tool: "Grep", input: { pattern: "skipFor|skips", path: "apps/web/src/settings/add" }, result: "setup.ts:63\nsetup.ts:71" },
        { tool: "Read", input: { file_path: "apps/web/src/settings/add/setup.ts", offset: 60, limit: 20 }, result: "20 lines" },
        { say: "The filter at setup.ts:63 drops the sign-in rows for a box that already has the image; it keeps the order of what is left. Now the tests." },
        { tool: "Glob", input: { pattern: "apps/web/test/**/add*.test.tsx" }, result: "apps/web/test/add-sheet.test.tsx\napps/web/test/add-computer-dialog.test.tsx" },
        { tool: "Grep", input: { pattern: "SETUP_ROWS", path: "apps/web/test" } },
      ],
    },
    {
      id: "sa-order",
      title: "Check the sheet's tests for the step order",
      state: "done",
      started: 9,
      ended: 6,
      model: "claude-haiku-4-5",
      prompt: "Read the add sheet's tests and say whether any of them pins the order of the steps.",
      summary: "add-sheet.test.tsx:41 pins the order in three cases, all green.",
      work: [
        { say: "Reading the add sheet's tests for anything that pins the order." },
        { tool: "Glob", input: { pattern: "apps/web/test/**/add*.test.tsx" }, result: "apps/web/test/add-sheet.test.tsx\napps/web/test/add-computer-dialog.test.tsx" },
        { tool: "Read", input: { file_path: "apps/web/test/add-sheet.test.tsx" }, result: "164 lines" },
        { say: "add-sheet.test.tsx:41 lists the rows' ids in order for a laptop, a box and a cloud, and compares the sheet against each list." },
        { tool: "Read", input: { file_path: "apps/web/test/add-computer-dialog.test.tsx" }, result: "231 lines" },
        { say: "add-computer-dialog.test.tsx only checks which step a row opens on. It never looks at the order." },
        { tool: "Bash", input: { command: "pnpm exec vitest run apps/web/test/add-sheet.test.tsx", description: "Run the add sheet's tests" }, result: "3 passed" },
        { say: "add-sheet.test.tsx:41 pins the order in three cases, all green." },
      ],
    },
  ],
  [LEAD]: [
    {
      id: "sa-map",
      title: "Read the open tickets on the map",
      state: "running",
      started: 1,
      model: "claude-opus-5-5",
      prompt: "Read every open ticket on acme/lab-map with no branch yet, and list them with the files each one names.",
      work: [
        { say: "Listing the open tickets with no branch yet, then reading each for the files it names." },
        { tool: "Bash", input: { command: "gh issue list -R acme/lab-map --state open --limit 200 --json number,title,body", description: "List the map's open tickets" }, result: "34 issues" },
        { tool: "Bash", input: { command: "git branch -r --list 'origin/*' --format '%(refname:short)'", description: "List the remote branches" }, result: "61 branches" },
        { say: "34 open, 12 of them with a branch already. That leaves 22 to read." },
        { tool: "Bash", input: { command: "gh issue view 1858 -R acme/lab-map --json body", description: "Read ticket 1858" }, result: "names packages/runtime/src/runtime.ts and apps/web/src/components/chat/ComposerQueue.tsx" },
        { tool: "Bash", input: { command: "gh issue view 1849 -R acme/lab-map --json body", description: "Read ticket 1849" }, result: "names packages/host/src/verbs.ts" },
        { tool: "Bash", input: { command: "gh issue view 1845 -R acme/lab-map --json body", description: "Read ticket 1845" }, result: "names packages/runtime/src/runtime.ts" },
        { say: "1858 and 1845 both touch runtime.ts, so their builders should not run at the same time. Noting that for the lead." },
        { tool: "Bash", input: { command: "gh issue view 1841 -R acme/lab-map --json body", description: "Read ticket 1841" }, result: "names apps/web/src/settings/usage.tsx" },
        { tool: "Bash", input: { command: "gh issue view 1830 -R acme/lab-map --json body", description: "Read ticket 1830" } },
      ],
    },
    {
      id: "sa-hdr",
      title: "Check the landing's CSP headers",
      state: "failed",
      started: 3,
      ended: 2,
      model: "claude-haiku-4-5",
      prompt: "Fetch the landing page and list its Content-Security-Policy header, directive by directive.",
      failure: "WebFetch could not reach https://acme.dev: connect ETIMEDOUT",
      work: [
        { say: "Fetching the landing page to read its headers." },
        { tool: "WebFetch", input: { url: "https://acme.dev", prompt: "List the Content-Security-Policy header" }, result: "connect ETIMEDOUT" },
        { say: "The fetch timed out. Trying the www address before I give up." },
        { tool: "WebFetch", input: { url: "https://www.acme.dev", prompt: "List the Content-Security-Policy header" }, result: "connect ETIMEDOUT" },
        { tool: "Bash", input: { command: "curl -sI --max-time 10 https://acme.dev", description: "Read the landing's headers" }, result: "curl: (28) Connection timed out after 10001 milliseconds" },
        { say: "Neither address answers from here, so I can't read the header. The site is down or this network can't reach it." },
      ],
    },
  ],
  "c-sec2": [
    {
      id: "sa-csp",
      title: "Rerun the CSP gate",
      state: "stopped",
      started: 6,
      ended: 4,
      model: "claude-haiku-4-5",
      prompt: "Run pnpm gate:csp and report each failing rule with its file.",
      work: [
        { say: "The gate builds the landing first, so I'll build it and then run the gate." },
        { tool: "Bash", input: { command: "pnpm --filter landing build", description: "Build the landing" }, result: "built in 41s" },
        { say: "Built. Running the CSP gate." },
        { tool: "Bash", input: { command: "pnpm gate:csp", description: "Run the CSP gate" } },
      ],
    },
  ],
};

/** The lead's earlier turn, which checked the pull requests and main's gate with two subagents before the marathon. */
const EARLIER = {
  prompt: "Check the pull requests and main's gate before we start.",
  started: 64,
  ended: 56,
  said: "11 pull requests are open and main is green, so the builders can start from main.",
  subagents: [
    { id: "sa-prs", title: "List the open pull requests", state: "done", started: 60, ended: 58, model: "claude-haiku-4-5", prompt: "List the open pull requests on acme/lab with their review state.", summary: "11 open, 4 approved, 7 waiting on a reviewer.", work: [{ say: "11 open, 4 approved, 7 waiting on a reviewer." }] },
    { id: "sa-gate", title: "Check main's gate", state: "done", started: 62, ended: 57, model: "claude-haiku-4-5", prompt: "Run the gate on main and report what fails.", summary: "Main is green at 4c5d84d.", work: [{ say: "Main is green at 4c5d84d." }] },
  ],
};

const LEAD_SAID = {
  ask: "Run the marathon: build, review and land every open ticket on the map, a builder per ticket, a reviewer per pull request, fix rounds until the reviewer passes it. Tell me when a thing needs me.",
  said: "Eight threads are out. 1805's builder hung on the CSP gate, so I stopped it and started it again; 1827 failed on the desktop smoke and I'll read its log next. 1615 is waiting on you to allow its install, and two builds are waiting for a slot on your MacBook. A subagent is reading the rest of the map's open tickets.\n\nI'll take each report as it lands.",
};

/** The lead's task list as its agent wrote it, one list per change and seconds ago: the first step took 74 s, the
 * second 31 s, and the third has been working for 12. A step's time is read off the list that first shows it working
 * and the one that shows it done, so one list alone would time nothing. */
const LEAD_TASKS = ["Read the open tickets on the map", "Start a builder per ticket", "Start a reviewer per pull request", "Run fix rounds until each review passes", "Merge what passed into main", "Report what needs the person"];
const LEAD_PLANS = [
  [117, 0],
  [43, 1],
  [12, 2],
];
const planLines = () =>
  LEAD_PLANS.map(([seconds, working]) => ({ type: "session.plan", at: AT - seconds * 1000, steps: LEAD_TASKS.map((text, i) => ({ text, state: i < working ? "done" : i === working ? "working" : "pending" })) }));

/** The other threads in the project, so the lead is drawn among the work it sits beside. */
const OTHERS = [
  { id: "o-relay", title: "Probe: send latency on the relay", status: "running", started: 5, startedBy: "person", asking: "fetch" },
  { id: "o-options", title: "Questions with visual options", status: "completed", started: 150, ended: 140, startedBy: "person", read: true },
];

/** The permission prompt each asking thread is stopped on, as its agent raised it. */
const PROMPTS = {
  install: () => ({ askId: "ask_install", toolName: "Bash", toolUseId: "tu_install", input: install(), options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }] }),
  fetch: () => ({ askId: "ask_fetch", toolName: "WebFetch", toolUseId: "tu_fetch", input: JSON.stringify({ url: "https://relay.acme.dev/metrics", prompt: "Read the send latency" }), options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }] }),
  review: () => ({ askId: "ask_review", toolName: "Bash", toolUseId: "tu_review", input: JSON.stringify({ command: "gh pr view 1153 --comments", description: "Read the pull request's comments" }), options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }] }),
  question: () => ({ askId: "ask_next", toolName: "AskUserQuestion", toolUseId: "tu_next", input: ASK_INPUT, detail: "", options: PICKS.map(([label], i) => ({ id: `q0:o${i}`, label, effect: "answer" })) }),
};

/** What each asking thread's row says it waits on: the prototype's words, so the second line matches its shot. */
const ASKING = {
  install: () => `Run pnpm install --frozen-lockfile in ${projectDest("wsp")}`,
  fetch: () => "Fetch https://relay.acme.dev/metrics",
  review: () => "Run gh pr view 1153 --comments",
  question: () => QUESTION,
};

/** One turn's row: a person's or a child an agent started, running on a run the stand-in never answers for, so a
 * re-attach leaves it as it was, as `tiles()` holds its working tiles. */
const row = (c, { workspaceId, key = c.id, claude }) => {
  const agent = c.agent ?? "claude";
  return {
    id: sessionId(key),
    workspaceId,
    harness: agent,
    status: c.status,
    startedBy: c.startedBy ?? "agent",
    threadId: threadId(c.id),
    turnId: turnId(key),
    prompt: c.prompt ?? c.title,
    harnessTitle: c.title,
    titleSource: "harness",
    startedAt: ago(c.started),
    ...(c.ended === undefined ? { run: `run_${key}` } : { endedAt: ago(c.ended) }),
    ...(c.asking === undefined ? {} : { asking: ASKING[c.asking]() }),
    ...(c.capped === undefined ? {} : { capped: c.capped }),
    ...(claude === undefined ? {} : { claudeSessionId: claude }),
    cwd: FOLDER[workspaceId](),
    model: MODEL[agent],
    permissionMode: "default",
    ...(c.lastLine === undefined ? {} : { lastLine: c.lastLine }),
    ...(c.failure === undefined ? {} : { failure: c.failure }),
    ...(c.startedBy === "person" ? {} : { parentThreadId: threadId(c.parent ?? LEAD), rootThreadId: threadId(LEAD) }),
  };
};

const scoped = (r, lines) => lines.map(line => ({ workspaceId: r.workspaceId, sessionId: r.id, threadId: r.threadId, turnId: r.turnId, ...line }));

/** How a turn that is over closed, as its transcript's last two lines say it. */
const closed = (c, said) => {
  if (c.ended === undefined) return [];
  return [
    { type: "session.done", at: ago(c.ended), result: { status: c.status, durationMs: (c.started - c.ended) * 60_000, costUsd: 0.4, ...(said === undefined ? {} : { text: said }), ...(c.failure === undefined ? {} : { error: c.failure }) } },
    { type: "session.end", at: ago(c.ended), exitCode: c.status === "failed" ? 1 : 0, sawResult: true },
  ];
};

/** A child's transcript: its ask, the threads it started and its subagents, what it said last, its open prompt, and
 * how it ended. */
const childLines = (c, children, workspaceOf) => {
  const said = c.lastLine ?? (c.status === "running" ? "On it." : undefined);
  return [
    { type: "session.start", at: ago(c.started), prompt: c.title, model: MODEL[c.agent ?? "claude"], cwd: FOLDER[workspaceOf(c)]() },
    ...(said === undefined ? [] : [{ type: "session.delta", at: ago(c.ended ?? c.started), kind: "text", text: said }]),
    ...children.filter(k => k.parent === c.id).flatMap(k => runCall(k, { project: PROJECT[workspaceOf(k)], workspaceId: workspaceOf(k), at: ago(k.started) })),
    ...(SUBAGENTS[c.id] ?? []).flatMap(subagentLines),
    ...(c.asking === undefined ? [] : [{ type: "session.permission", at: ago(c.started), ...PROMPTS[c.asking]() }]),
    ...closed(c, said),
  ];
};

/** The marathon's lead: an earlier turn that ran two subagents, then this turn, which started the eight live
 * children, said where they stand, keeps a task list of six, runs its own subagent and is stopped on a question. */
const leadLines = (earlier, now) => [
  ...scoped(earlier, [
    { type: "session.start", at: ago(EARLIER.started), prompt: EARLIER.prompt, model: MODEL.claude, cwd: FOLDER[MAC]() },
    ...EARLIER.subagents.flatMap(subagentLines),
    { type: "session.delta", at: ago(EARLIER.ended), kind: "text", text: EARLIER.said },
    ...closed({ status: "completed", started: EARLIER.started, ended: EARLIER.ended }, EARLIER.said),
  ]),
  ...scoped(now, [
    { type: "session.start", at: ago(2), prompt: LEAD_SAID.ask, model: MODEL.claude, cwd: FOLDER[MAC]() },
    ...LIVE.flatMap(c => runCall(c, { project: PROJECT[c.on ?? MAC], workspaceId: c.on ?? MAC, at: ago(2), capped: c.capped })),
    { type: "session.delta", at: ago(2), kind: "text", text: LEAD_SAID.said },
    ...planLines(),
    ...SUBAGENTS[LEAD].flatMap(subagentLines),
    { type: "session.permission", at: ago(0), ...PROMPTS.question() },
  ]),
];

/** The small lead's one turn, over: it started three children and waits on their finished lines. */
const SMALL = [
  { id: "m-work", title: "Build: the reset words on the Usage page (#1841)", status: "running", started: 6 },
  { id: "m-ask", title: "Review 1841: the reset words", status: "running", started: 4, agent: "codex", asking: "review" },
  { id: "m-done", title: "Rebase: feat/1841-usage-resets onto main", status: "completed", started: 9, ended: 3, lastLine: "Rebased onto main at 4c5d84d, no conflicts, gate green." },
];

/** The project folder on hetzner, as the host records the folder a thread on a computer the person joined runs in:
 * the folder itself, never a machine made there. */
const BOX_FOLDER = () => ({
  id: BOX,
  name: "wsp",
  kind: "place",
  place: "p_hetzner",
  machineId: "p_hetzner",
  phase: "running",
  project: "pr_wsp-hetzner",
  golden: "",
  createdAt: new Date(ago(60 * 20)).toISOString(),
  spec: {},
  size: { cpu: 2, memMb: 7782 },
  firstLife: false,
  idleWindowMs: null,
});

/** A thread's read and settle marks, as the host keeps them on its record. */
const marks = rows =>
  Object.fromEntries(
    rows.filter(([c]) => c.read === true || c.settled === true).map(([c, r]) => [r.threadId, { harness: r.harness, readAt: r.endedAt + 30_000, ...(c.settled === true ? { settledAt: r.endedAt + 60_000 } : {}) }]),
  );

/** A lead on the wsp project here, its children here and on the box hetzner, and the project's other threads. */
export const leadFixture = size => {
  const children = size === "small" ? SMALL : [...LIVE, ...NESTED, ...FINISHED, ...SETTLED];
  const workspaceOf = c => c.on ?? MAC;
  const claude = uuidFor(`claude:${LEAD}`);
  const lead =
    size === "small"
      ? { id: LEAD, title: "Land 1841", prompt: "Land 1841: build, review, merge.", status: "completed", started: 12, ended: 1, startedBy: "person", read: true, lastLine: "Started a builder and a reviewer for 1841; the rebase is done. I'll merge once the review passes." }
      : { id: LEAD, title: "Coordinator: the marathon", prompt: LEAD_SAID.ask, status: "running", started: 2, startedBy: "person", asking: "question" };
  const leadRow = row(lead, { workspaceId: MAC, claude });
  const earlierRow = size === "small" ? undefined : row({ ...lead, prompt: EARLIER.prompt, status: "completed", started: EARLIER.started, ended: EARLIER.ended, asking: undefined, lastLine: EARLIER.said }, { workspaceId: MAC, key: `${LEAD}-earlier`, claude });
  const others = size === "small" ? [] : OTHERS;
  const held = [...children, ...others].map(c => [c, row(c, { workspaceId: workspaceOf(c) })]);
  const on = workspaceId => held.filter(([c]) => workspaceOf(c) === workspaceId);
  const sorted = pairs => pairs.toSorted(([, a], [, b]) => a.startedAt - b.startedAt);
  const here = sorted([...(earlierRow === undefined ? [] : [[{}, earlierRow]]), [lead, leadRow], ...on(MAC)]);
  const box = sorted(on(BOX));
  const linesOf = pairs => pairs.flatMap(([c, r]) => (c === lead || r === earlierRow ? [] : scoped(r, childLines(c, children, workspaceOf))));
  const leadTranscript =
    earlierRow === undefined
      ? scoped(leadRow, [
          { type: "session.start", at: ago(lead.started), prompt: lead.prompt, model: MODEL.claude, cwd: FOLDER[MAC]() },
          ...children.flatMap(c => runCall(c, { project: PROJECT[MAC], workspaceId: MAC, at: ago(c.started) })),
          { type: "session.delta", at: ago(lead.ended), kind: "text", text: lead.lastLine },
          ...closed(lead, lead.lastLine),
        ])
      : leadLines(earlierRow, leadRow);
  return store({
    projects: [project("wsp", HERE, 60 * 30), { ...project("wsp", "p_hetzner", 60 * 30), id: "pr_wsp-hetzner" }],
    workspaces: [workspace(MAC, THIS_COMPUTER, { project: "pr_wsp" }), ...(box.length === 0 ? [] : [BOX_FOLDER()])],
    sessions: {
      [MAC]: { workspaceId: MAC, sessions: here.map(([, r]) => r), threads: marks([[lead, leadRow], ...on(MAC)]) },
      ...(box.length === 0 ? {} : { [BOX]: { workspaceId: BOX, sessions: box.map(([, r]) => r), threads: marks(on(BOX)) } }),
    },
    transcripts: {
      [MAC]: { workspaceId: MAC, events: [...leadTranscript, ...linesOf(here)] },
      ...(box.length === 0 ? {} : { [BOX]: { workspaceId: BOX, events: linesOf(box) } }),
    },
    // Every turn here ended after the host began keeping read stamps, so one nobody opened reads Done.
    readsSince: 60 * 24,
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 7782 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true),
    },
    preferences: { projectLook: { pr_wsp: { icon: "terminal", hue: "amber" }, "pr_wsp-hetzner": { icon: "terminal", hue: "amber" } } },
  });
};

/** Where the composer keeps its queues, copied from `STORAGE_KEY` in `src/components/chat/composerDraftStore.ts`,
 * since this file is plain node beside the app and cannot import it: a rename there is a rename here. */
const COMPOSER_STORE = "wsp:composer-drafts:v1";

/** The two messages the person queued on the lead while its turn runs. */
const QUEUED = ["When 1811 lands, rebase 1866 onto it before its review.", "Skip 1830's build until the owner locks the design."];

export default {
  build: () => leadFixture("marathon"),
  // The frozen shots were taken the moment every stamp hangs off, so a time reads as its shot does: 12m where it shows 12m.
  clock: () => AT,
  storage: () => ({ [COMPOSER_STORE]: JSON.stringify({ state: { drafts: {}, queues: { [threadId(LEAD)]: QUEUED.map((prompt, i) => ({ id: `queued-${i}`, prompt })) } }, version: 1 }) }),
};
