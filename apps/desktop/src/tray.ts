// SPDX-License-Identifier: AGPL-3.0-only
// The menu bar's icon and menu, as data: how many threads work, whether one
// waits on the person, and a row per live thread with what can be done from
// there. The words are the sidebar's (threadState, the computer names the
// tiles use), so the menu and the tiles never disagree. Nothing here touches
// Electron; main.ts draws what this returns.
import {
  NEEDS_YOU,
  askingLine,
  foldThreads,
  needsYouCount,
  threadFinishedLine,
  threadState,
  threadStateWord,
  workspaceComputerName,
  type OutsideLine,
  type PermissionOption,
  type PlaceView,
  type SessionPermissionEvent,
  type SessionView,
  type ThreadView,
  type TurnResult,
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

function threadActions(thread: ThreadView, asks: ReadonlyMap<string, OpenAsk>): { label: string; act: TrayAct }[] {
  const ask = thread.asking === undefined ? undefined : asks.get(thread.sessionId);
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

const TAIL: TrayRow[] = [{ kind: "separator" }, { kind: "line", label: TRAY_WORDS.openApp, act: { kind: "openApp" } }, { kind: "line", label: QUIT_WORD, act: { kind: "quit" } }];

export function trayModel(input: TrayInput): TrayModel {
  const { host } = input;
  if (host.lost) {
    const said: TrayRow[] = host.remote ? [{ kind: "line", label: TRAY_WORDS.unreached(host.label) }] : [{ kind: "line", label: TRAY_WORDS.notRunning }, { kind: "line", label: TRAY_WORDS.start, act: { kind: "start" } }];
    return { title: host.remote ? host.label : "", needsYou: false, badge: 0, rows: [...said, ...TAIL] };
  }
  const live = foldThreads(input.sessions)
    .map(thread => ({ thread, state: threadState(thread) }))
    .filter(t => LIVE.has(t.state))
    .sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || (b.thread.startedAt ?? 0) - (a.thread.startedAt ?? 0));
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
    sublabel: TRAY_WORDS.where(threadStateWord(state), computerOf(input, thread.workspaceId)),
    actions: threadActions(thread, input.asks),
  }));
  return {
    title: host.remote ? [host.label, count].filter(w => w !== "").join(" ") : count,
    needsYou: waiting > 0,
    badge: needsYouCount(input.sessions),
    rows: [...head, ...threads, ...TAIL],
  };
}

type SessionDone = { type: "session.done"; workspaceId: string; sessionId: string; threadId?: string; result: Pick<TurnResult, "status"> };

/** What the menu bar says over the system while no window is open to say it: a thread a person or a line opened
 * that finished, and a prompt. An agent's own thread reports to that agent. Nothing for anything else. */
export function trayNotice(event: SessionDone | SessionPermissionEvent, rows: Pick<TrayInput, "sessions" | "workspaces" | "places">, sound: boolean): OutsideLine | undefined {
  const thread = foldThreads(rows.sessions).find(t => t.id === (event.threadId ?? event.sessionId));
  if (event.type === "session.permission") return { title: NEEDS_YOU, body: askingLine(event), sound };
  if (event.result.status !== "completed" || thread === undefined || thread.startedBy === "agent") return undefined;
  return { title: threadFinishedLine(thread.title), body: computerOf(rows, event.workspaceId), sound };
}
