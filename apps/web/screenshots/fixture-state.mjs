// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway state a screenshot run serves: four workspaces on this
// computer, folders imported into three of them, and two threads with the
// transcript each one replays, so no surface is photographed empty; the fourth
// holds a thread its own agent opened, so the spawned row's grammar is in the
// shot. Every workspace is the local kind: a host with no provider key refuses
// to serve a state that holds a workspace on a provider at all, so a paused or
// waking row cannot be photographed here. No golden is sealed, which is what
// puts the cloud setup button in the sidebar's foot. Nothing here is a real
// computer, a real key or a real folder.

/** Every stamp hangs off the hour this run started in rather than a date written here: the app words a
 * thread's time as a distance from now, and a fixed date would drift into the future and read "now" on
 * every row. Rounded to the hour so two runs in one hour are byte for byte the same. */
const AT = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const ago = minutes => AT - minutes * 60_000;

const workspace = (id, name, extra = {}) => ({
  id,
  name,
  machineId: "local",
  phase: "running",
  kind: "local",
  golden: "",
  createdAt: new Date(ago(60 * 26)).toISOString(),
  home: "/Users/dev",
  folder: "/Users/dev",
  ...extra,
});

const project = (name, size, minutes) => ({ name, dest: `/Users/dev/${name}`, importedAt: new Date(ago(minutes)).toISOString(), size });

const turn = (thread, minutes, workspaceId = "ws_api") => ({
  id: `s_${thread.id}`,
  workspaceId,
  harness: "claude",
  status: "completed",
  startedBy: "person",
  threadId: `th_${thread.id}`,
  turnId: `turn_${thread.id}`,
  prompt: thread.prompt,
  harnessTitle: thread.title,
  titleSource: "harness",
  startedAt: ago(minutes),
  endedAt: ago(minutes - 3),
  cwd: "/Users/dev/spoo",
  model: "opus",
  permissionMode: "default",
});

const event = (thread, rest) => ({ workspaceId: "ws_api", sessionId: `s_${thread.id}`, threadId: `th_${thread.id}`, turnId: `turn_${thread.id}`, ...rest });

/** A whole turn as the transcript holds it: the person's words, a thought, one tool call and its result,
 * the reply, and the two events that close it. */
const replay = (thread, minutes) => [
  event(thread, { type: "session.start", at: ago(minutes), prompt: thread.prompt, model: "opus", cwd: "/Users/dev/spoo" }),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "thinking", text: thread.thought }),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "tool_use", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.input }),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "tool_result", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.result }),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "text", text: thread.reply }),
  event(thread, { type: "session.done", at: ago(minutes - 3), result: { status: "completed", durationMs: 178_000, costUsd: thread.costUsd, text: thread.reply } }),
  event(thread, { type: "session.end", at: ago(minutes - 3), exitCode: 0, sawResult: true }),
];

const REDIRECT = {
  id: "redirect",
  prompt: "the short links are 302ing twice, find out why",
  title: "Double redirect on short links",
  thought: "Both forms of the path answer, so the rewrite and the canonical host check are probably fighting each other. Read the middleware order before anything else.",
  tool: { name: "Grep", input: '{"pattern":"canonicalHost","path":"apps/api/src"}', result: "apps/api/src/redirect.ts:31\napps/api/src/middleware.ts:12" },
  reply: [
    "The redirect loop came from the canonical host check running before the trailing-slash rewrite, so every request to `/r/abc/` bounced once through `/r/abc` and back.",
    "",
    "I moved the rewrite ahead of the check and pinned the order with a test:",
    "",
    "- `apps/api/src/redirect.ts:48` rewrites first now",
    "- `apps/api/test/redirect.test.ts` covers the slash and the bare form",
    "",
    "Both forms answer 302 once.",
  ].join("\n"),
  costUsd: 0.42,
};

const CHART = {
  id: "chart",
  prompt: "swap the bar chart on the dashboard for a line",
  title: "Dashboard chart is a line now",
  thought: "The series is daily clicks over ninety days, so a line is the right mark. Keep the axis and the tooltip as they are.",
  tool: { name: "Read", input: '{"file_path":"apps/web/src/dashboard/ClicksChart.tsx"}', result: "export function ClicksChart({ points }: Props) {\n  return <BarChart data={points} />;\n}" },
  reply: ["The dashboard chart is a line now, same axis and same tooltip.", "", "`apps/web/src/dashboard/ClicksChart.tsx` draws `LineChart`, and the story file renders both the ninety-day series and the empty one."].join("\n"),
  costUsd: 0.18,
};

/** A lead thread and the one its own agent opened under it, so a shot carries the spawned row's grammar: the
 * workspace dropped where it is the row above's, then where that workspace runs, and no opener word. */
const SPAWNED = { id: "migration", prompt: "write the migration for the click index", title: "Write the migration" };
const LEAD = { id: "search", prompt: "ship the search rewrite", title: "Ship the search rewrite" };

const spawned = (thread, minutes, workspaceId, parent) => ({
  ...turn(thread, minutes, workspaceId),
  status: "running",
  startedBy: "agent",
  endedAt: undefined,
  parentThreadId: parent,
  rootThreadId: parent,
});

/** The whole store as the JSON file holds it: one object per collection, keyed the way the runtime keys it. */
export function fixtureState() {
  return {
    workspaces: {
      ws_api: workspace("ws_api", "api", { projects: [project("spoo", 48_200_000, 60 * 20), project("wsp", 133_000_000, 60 * 5)] }),
      ws_web: workspace("ws_web", "web", { projects: [project("landing", 9_400_000, 60 * 9)] }),
      ws_notes: workspace("ws_notes", "notes"),
      ws_fix: workspace("ws_fix", "spoo-fix", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
    },
    sessions: {
      // Oldest first, the order the runtime writes them in: the app opens the last row's thread when a
      // person has picked none, and the centre replays the last turn of the transcript, so a thread out of
      // order here would head the page with one title and fill it with another turn's words.
      ws_api: { workspaceId: "ws_api", sessions: [turn(CHART, 300), turn(REDIRECT, 45)] },
      ws_fix: { workspaceId: "ws_fix", sessions: [{ ...turn(LEAD, 12, "ws_fix"), status: "running", endedAt: undefined }, spawned(SPAWNED, 9, "ws_fix", "th_search")] },
    },
    transcripts: {
      ws_api: { workspaceId: "ws_api", events: [...replay(CHART, 300), ...replay(REDIRECT, 45)] },
    },
  };
}
