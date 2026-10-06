// SPDX-License-Identifier: AGPL-3.0-only
// The menu bar's icon and menu, as data: how many threads work, whether one
// waits on the person, and a row per live thread with what can be done from
// there. The words are the sidebar's (threadState, the computer names the
// tiles use), so the menu and the tiles never disagree. Nothing here touches
// Electron; main.ts draws what this returns.
import {
  askingLine,
  foldThreads,
  needsYouCount,
  outsideLine,
  threadNeedsYou,
  threadState,
  threadStateWord,
  workspaceComputerName,
  type OutsideLine,
  type PermissionOption,
  type Preferences,
  type PlaceView,
  type SessionEvent,
  type SessionView,
  type ThreadView,
  type UsageAlertEvent,
  type WorkspaceView,
} from "@wsp/protocol";
import { QUIT_WORD } from "./quit.js";

export const TRAY_WORDS = {
  nothing: "No threads working",
  working: (working: number, waiting: number): string => [working > 0 ? `${working} working` : "", waiting > 0 ? `${waiting} waiting on you` : ""].filter(w => w !== "").join(", "),
  where: (state: string, computer: string): string => (computer === "" ? state : `${state} on ${computer}`),
  on: (host: string): string => `On ${host}`,
  notRunning: "wsp is not running",
  unreached: (host: string): string => `${host} is not answering`,
  start: "Start wsp",
  openApp: "Open wsp",
  open: "Open",
  allow: "Allow",
  deny: "Deny",
  stop: "Stop",
  refused: (said: string): string => `${said.charAt(0).toUpperCase()}${said.slice(1)}`,
};

/** A prompt the menu saw open, by the turn that asks it: what sessions.answer names it by and what it offers. */
export interface OpenAsk {
  askId: string;
  options: readonly Pick<PermissionOption, "id" | "effect">[];
}

export interface TrayHost {
  /** What the window and the menu call the host: this computer's own name, or the alias of one on the account. */
  label: string;
  remote: boolean;
  /** Nothing answers there right now. */
  lost: boolean;
}

export interface TrayInput {
  sessions: readonly SessionView[];
  asks: ReadonlyMap<string, OpenAsk>;
  /** A pick the host would not take, by the prompt it was made on. */
  refused: ReadonlyMap<string, string>;
  workspaces: readonly WorkspaceView[];
  places: readonly PlaceView[];
  host: TrayHost;
}

export type TrayAct =
  | { kind: "open"; threadId: string }
  | { kind: "answer"; sessionId: string; askId: string; optionId: string }
  | { kind: "stop"; sessionId: string }
  | { kind: "start" }
  | { kind: "openApp" }
  | { kind: "quit" };

export type TrayRow =
  | { kind: "separator" }
  | { kind: "line"; label: string; act?: TrayAct }
  | { kind: "thread"; threadId: string; label: string; sublabel: string; actions: { label: string; act: TrayAct }[] };

export interface TrayModel {
  /** Beside the icon: the threads working, and the host's name where the window is on one somewhere else. */
  title: string;
  /** Whether a thread waits on the person, which swaps the icon for the question mark. */
  needsYou: boolean;
  /** What the dock's badge reads while no window does: the same count the page puts there. */
  badge: number;
  rows: TrayRow[];
}

const LIVE = new Set(["waiting", "running"]);

/** A thread the menu lists: one that asks or works, and one that failed and nobody has opened since, which waits on
 * the person as a question does. */
const listed = (thread: ThreadView, state: string): boolean => LIVE.has(state) || (state === "failed" && threadNeedsYou(thread));

/** The prompt a thread's row stands on: a prompt carries the agent's own session id, which a Codex thread's row id is not. */
const openAskOf = (thread: ThreadView, asks: ReadonlyMap<string, OpenAsk>): OpenAsk | undefined =>
  thread.asking === undefined ? undefined : asks.get(thread.claudeSessionId ?? thread.sessionId);

function threadActions(thread: ThreadView, asks: ReadonlyMap<string, OpenAsk>): { label: string; act: TrayAct }[] {
  // A failure has nothing left to answer or stop: it is opened, and read there.
  if (thread.status === "failed") return [{ label: TRAY_WORDS.open, act: { kind: "open", threadId: thread.id } }];
  const ask = openAskOf(thread, asks);
  const pick = (effect: PermissionOption["effect"]) => ask?.options.find(o => o.effect === effect);
  const allow = pick("allow");
  const deny = pick("deny");
  return [
    { label: TRAY_WORDS.open, act: { kind: "open", threadId: thread.id } },
    ...(ask !== undefined && allow !== undefined ? [{ label: TRAY_WORDS.allow, act: { kind: "answer" as const, sessionId: thread.sessionId, askId: ask.askId, optionId: allow.id } }] : []),
    ...(ask !== undefined && deny !== undefined ? [{ label: TRAY_WORDS.deny, act: { kind: "answer" as const, sessionId: thread.sessionId, askId: ask.askId, optionId: deny.id } }] : []),
    { label: TRAY_WORDS.stop, act: { kind: "stop", sessionId: thread.sessionId } },
  ];
}

const computerOf = (input: Pick<TrayInput, "workspaces" | "places">, workspaceId: string): string => {
  const workspace = input.workspaces.find(w => w.id === workspaceId);
  return workspace === undefined ? "" : workspaceComputerName(input.places, workspace);
};

/** A pick the host refused on the prompt this row still stands on, said where the row says where it runs. */
const refusedOn = (thread: ThreadView, input: Pick<TrayInput, "asks" | "refused">): string | undefined => {
  const said = input.refused.get(openAskOf(thread, input.asks)?.askId ?? "");
  return said === undefined ? undefined : TRAY_WORDS.refused(said);
};

const TAIL: TrayRow[] = [{ kind: "separator" }, { kind: "line", label: TRAY_WORDS.openApp, act: { kind: "openApp" } }, { kind: "line", label: QUIT_WORD, act: { kind: "quit" } }];

export function trayModel(input: TrayInput): TrayModel {
  const { host } = input;
  if (host.lost) {
    const said: TrayRow[] = host.remote ? [{ kind: "line", label: TRAY_WORDS.unreached(host.label) }] : [{ kind: "line", label: TRAY_WORDS.notRunning }, { kind: "line", label: TRAY_WORDS.start, act: { kind: "start" } }];
    return { title: host.remote ? host.label : "", needsYou: false, badge: 0, rows: [...said, ...TAIL] };
  }
  const live = foldThreads(input.sessions)
    .map(thread => ({ thread, state: threadState(thread) }))
    .filter(t => listed(t.thread, t.state))
    .sort((a, b) => Number(b.state !== "running") - Number(a.state !== "running") || (b.thread.startedAt ?? 0) - (a.thread.startedAt ?? 0));
  const working = live.filter(t => t.state === "running").length;
  const waiting = live.length - working;
  const count = working > 0 ? String(working) : "";
  const head: TrayRow[] = [
    ...(host.remote ? [{ kind: "line" as const, label: TRAY_WORDS.on(host.label) }] : []),
    { kind: "line", label: live.length === 0 ? TRAY_WORDS.nothing : TRAY_WORDS.working(working, waiting) },
  ];
  const threads: TrayRow[] = live.map(({ thread, state }) => ({
    kind: "thread",
    threadId: thread.id,
    label: thread.title,
    sublabel: refusedOn(thread, input) ?? TRAY_WORDS.where(threadStateWord(state), computerOf(input, thread.workspaceId)),
    actions: threadActions(thread, input.asks),
  }));
  return {
    title: host.remote ? [host.label, count].filter(w => w !== "").join(" ") : count,
    needsYou: waiting > 0,
    badge: needsYouCount(input.sessions),
    rows: [...head, ...threads, ...TAIL],
  };
}

/** What the menu bar says over the system while no window is open to say it, by the protocol's one rule the page
 * reads too: a prompt, a thread a person or a line opened that finished or failed, and an account's plan alert. An
 * agent's own thread reports to that agent. Nothing for anything else. */
export function trayNotice(event: SessionEvent | UsageAlertEvent, rows: Pick<TrayInput, "sessions" | "workspaces" | "places">, choices: Pick<Preferences, "notifyNeeds" | "notifyDone" | "planAlerts">): OutsideLine | undefined {
  if (event.type === "usage.alert") return outsideLine({ kind: "plan", label: event.label, alert: event.alert }, choices);
  if (event.type === "session.permission") return outsideLine({ kind: "asks", line: askingLine(event) }, choices);
  // Every adapter sends a result before its process ends, a made-up one when the process died first, so the end
  // after it has nothing to add: a death is said once and a stop not at all.
  if (event.type !== "session.done") return undefined;
  const thread = foldThreads(rows.sessions).find(t => t.id === (event.threadId ?? event.sessionId));
  if (thread === undefined || thread.startedBy === "agent") return undefined;
  const where = computerOf(rows, event.workspaceId);
  if (event.result.status === "failed") return outsideLine({ kind: "failed", thread: thread.title, where, error: event.result.error }, choices);
  if (event.result.status !== "completed") return undefined;
  return outsideLine({ kind: "finished", thread: thread.title, where }, choices);
}
