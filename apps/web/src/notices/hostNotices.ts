// SPDX-License-Identifier: AGPL-3.0-only
// The host's events that become notices, one rule per event type. A notice is
// for what happened away from where the person is looking: an event whose home
// is on screen (that thread open, that computer's row showing, that build's
// rows drawn) is the panel's to show and says nothing here. A computer going
// quiet is the machine's life and never a notice: the thread on screen and the
// computer's row say it where it matters. A wait (a build's
// need, a thread's prompt) is keyed and stands until the event that closes it,
// and a build's need is said when its rows leave the screen with it standing.
// The need, the prompt, a machine that came up and a finished turn also go out
// on the shell's own road, which speaks only while the app is not in front of
// the person; the prompt and the finish make a sound unless the person turned
// it off. The dock's badge counts the threads waiting on the person.
import { GET_THE_APP_WORD, NEEDS_YOU, NOTIFY_ME, askingLine, exitLine, foldThreads, initJobBuilding, initNeedsYouLine, needsYouCount, oneLine, threadFinishedLine, threadKeyOf, threadStoppedLine, titleWithNeed, workspaceAwakeLine, type OutsideLine, type ReleaseView, type TurnResult } from "@wsp/protocol";
import { useCallback, useEffect, useRef } from "react";
import type { ProtocolEvent } from "../protocol/client.js";
import { threadRows, useProtocolEvents, useStore } from "../protocol/store.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { placeName } from "../settings/places.js";
import { useSettingsStore } from "../settings/settingsStore.js";
import { needsYouRoad, type NeedsYouRoad } from "../shell/needsYou.js";
import { releaseAhead, shellVersions } from "../shell/shellVersion.js";
import { copyName } from "../sidebar/workspaceRows.js";
import { addNotice, useNotices, type NoticeAction } from "./store.js";

/** Where this page's storage keeps the last release version the update notice has said, so a reload says it no more. */
export const RELEASE_SAID_KEY = "wsp:release-said";
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A turn whose session.end never arrived (a socket gap) is not held past this many later turns. */
const RESULTS_HELD = 64;

export const HOST_NOTICE_WORDS = {
  open: "Open",
  notAdded: (said: string): string => `Computer not added: ${said}`,
  joined: (name: string): string => `${name} joined`,
  notSetUp: (name: string, said: string): string => `${name} not set up: ${said}`,
  setUp: (name: string): string => `${name} is set up`,
  rowsFailed: (name: string, failed: number): string => `${name}: ${failed === 1 ? "1 row" : `${failed} rows`} of the recipe failed`,
  aThread: "A thread",
  threadStopped: (title: string, said: string | undefined): string => `${title} stopped before it replied${said === undefined ? "" : `: ${said}`}`,
  threadFinished: threadFinishedLine,
  threadFailed: threadStoppedLine,
  gone: (name: string, reason: string): string => `${name} is gone: ${reason}`,
  imageNotBuilt: (said: string | undefined): string => (said === undefined ? "The image was not built" : `The image was not built: ${said}`),
  imageSealed: (version: number | undefined): string => (version === undefined ? "Image sealed" : `Image v${version} sealed`),
  released: (version: string): string => `wsp ${version} is out`,
};

const NEED_KEY = "needs-you";
const askKey = (workspaceId: string, threadId: string | undefined, askId: string): string => `${askPrefix(workspaceId, threadId)}${askId}`;
const askPrefix = (workspaceId: string, threadId: string | undefined): string => `ask:${workspaceId}:${threadId ?? workspaceId}:`;

function workspaceNamed(id: string): string | undefined {
  const { workspaces, statuses, places } = useStore.getState();
  const workspace = workspaces.find(w => w.id === id);
  return workspace === undefined ? undefined : copyName(places, { workspace, status: statuses[id] ?? null, displayName: workspace.name });
}

function threadTitle(workspaceId: string, threadId: string | undefined): string {
  return threadOf(workspaceId, threadId)?.title ?? HOST_NOTICE_WORDS.aThread;
}

const threadOf = (workspaceId: string, threadId: string | undefined) => foldThreads(useStore.getState().sessions[workspaceId] ?? []).find(t => t.id === threadId);

/** A line said outside the app for a thread's own moment, sounding unless the person turned the sound off. */
const threadLine = (title: string, body: string): OutsideLine => ({ title, body, sound: useStore.getState().preferences.notifySound });

/** A need or a machine up, said outside the app with no sound: neither is an alarm. */
const quietLine = (body: string): OutsideLine => ({ title: NEEDS_YOU, body, sound: false });

function threadOnScreen(e: { workspaceId: string; sessionId: string; threadId?: string | undefined }): boolean {
  const s = useStore.getState();
  if (s.settingsOpen || s.freshThread || s.selectedId !== e.workspaceId) return false;
  const shown = threadRows(s.sessions[e.workspaceId] ?? [], e.workspaceId, s.selectedThreadId ?? e.workspaceId).at(-1);
  return shown === undefined ? s.selectedThreadId === null || s.selectedThreadId === e.threadId : threadKeyOf(shown) === (e.threadId ?? e.sessionId);
}

const workspaceOnScreen = (workspaceId: string): boolean => !useStore.getState().settingsOpen && useStore.getState().selectedId === workspaceId;

/** Whether a build's own rows are in front of the person: the Image card of the computer it runs on drawing it. The
 * Computers list shows no sign-in, so it is not the build's home. */
function buildOnScreen(placeId: string | undefined): boolean {
  return placeId !== undefined && useStore.getState().settingsOpen && useSettingsStore.getState().buildShown === placeId;
}

function computerOnScreen(placeId: string | undefined): boolean {
  const s = useStore.getState();
  if (!s.settingsOpen) return false;
  const at = useSettingsStore.getState().at;
  return s.addComputerOpen || (at.kind === "group" && at.group === "computers") || (at.kind === "computer" && at.id === placeId);
}

const aboutOnScreen = (): boolean => {
  const at = useSettingsStore.getState().at;
  return useStore.getState().settingsOpen && at.kind === "group" && at.group === "about";
};

const openThread = (workspaceId: string, threadId: string | undefined): NoticeAction => ({ word: HOST_NOTICE_WORDS.open, run: () => useStore.getState().select(workspaceId, threadId ?? null) });
const openComputer = (placeId: string | undefined): NoticeAction => ({
  word: HOST_NOTICE_WORDS.open,
  run: () => {
    useSettingsStore.getState().go(placeId === undefined ? { kind: "group", group: "computers" } : { kind: "computer", id: placeId });
    useStore.getState().openSettings();
  },
});

/** What the rules keep between events, for one mounted effect. */
interface Held {
  road: NeedsYouRoad | null;
  /** What a click on the last thing the shell's road said opens: the road hands a click back for whatever it showed last. */
  opens: () => void;
  /** The need the keyed notice stands for. */
  need: string | undefined;
  /** Whether the build's rows were in front of the person at the last change, so leaving them with a need standing
   * says it and coming back to them ends it. */
  shown: boolean;
  /** The jobs whose end has been said. */
  jobsEnded: Set<string>;
  /** The last release version said, read from this page's storage on mount. */
  released: string | undefined;
  /** Each running turn's result, by turn id, from its session.done until the session.end that always follows it. */
  results: Map<string, TurnResult>;
}

function sayOutside(held: Held, opens: () => void, line: OutsideLine): void {
  held.opens = opens;
  held.road?.say(line);
}

function sayNeed(held: Held, what: string, placeId: string | undefined): void {
  held.need = what;
  addNotice({ kind: "waiting", key: NEED_KEY, text: initNeedsYouLine(what), action: openComputer(placeId) });
}

/** The build's rows came into view or left it: a need they carried is said once they are gone, and ended once they
 * are back. */
function settleShown(held: Held): void {
  const job = useStore.getState().initJob;
  const shown = buildOnScreen(job?.place?.id);
  if (shown === held.shown) return;
  held.shown = shown;
  if (shown) {
    if (held.need === undefined) return;
    held.need = undefined;
    useNotices.getState().end(NEED_KEY);
  } else if (job?.needsYou !== undefined && held.need === undefined) sayNeed(held, job.needsYou.what, job.place?.id);
}

function endAsks(workspaceId: string, threadId: string | undefined): void {
  const prefix = askPrefix(workspaceId, threadId);
  const notices = useNotices.getState();
  for (const key of new Set(notices.notices.map(n => n.key).filter((k): k is string => k?.startsWith(prefix) === true))) notices.end(key);
}

function releaseSaid(): string | undefined {
  try {
    const stored = window.localStorage.getItem(RELEASE_SAID_KEY);
    return stored !== null && VERSION_SHAPE.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function sayRelease(held: Held, release: ReleaseView | null): void {
  const ahead = releaseAhead(release, shellVersions());
  if (ahead === undefined || held.released === ahead.version) return;
  held.released = ahead.version;
  try {
    window.localStorage.setItem(RELEASE_SAID_KEY, ahead.version);
  } catch {
    // A storage that refuses only means the next page says it again.
  }
  if (aboutOnScreen()) return;
  addNotice({ kind: "note", text: HOST_NOTICE_WORDS.released(ahead.version), action: { word: GET_THE_APP_WORD, run: () => void window.open(ahead.url, "_blank", "noopener,noreferrer") } });
}

type Rule<T extends ProtocolEvent["type"]> = (e: Extract<ProtocolEvent, { type: T }>, held: Held) => void;

/** One rule per event type that says anything; a type with no rule is noise. */
const RULES: { [T in ProtocolEvent["type"]]?: Rule<T> } = {
  "place.stage": e => {
    if (e.state === "running" || (e.state === "done" && e.step !== "join" && e.step !== "provision")) return;
    if (computerOnScreen(e.placeId)) return;
    const place = e.placeId === undefined ? undefined : useStore.getState().places.find(p => p.id === e.placeId);
    const name = place === undefined ? undefined : placeName(place);
    const where = name === undefined ? {} : { where: name };
    if (e.state === "failed") {
      const said = e.note ?? e.step;
      addNotice({ kind: "error", text: e.step === "provision" && name !== undefined ? HOST_NOTICE_WORDS.notSetUp(name, said) : HOST_NOTICE_WORDS.notAdded(said), ...where, action: openComputer(e.placeId) });
      return;
    }
    if (name === undefined) return;
    if (e.failed !== undefined && e.failed > 0) {
      addNotice({ kind: "error", text: HOST_NOTICE_WORDS.rowsFailed(name, e.failed), ...where, action: openComputer(e.placeId) });
      return;
    }
    addNotice({ kind: "done", text: e.step === "join" ? HOST_NOTICE_WORDS.joined(name) : HOST_NOTICE_WORDS.setUp(name), ...where, action: openComputer(e.placeId) });
  },
  "session.done": (e, held) => {
    if (e.turnId === undefined) return;
    held.results.set(e.turnId, e.result);
    if (held.results.size > RESULTS_HELD) held.results.delete(held.results.keys().next().value!);
  },
  "session.end": (e, held) => {
    endAsks(e.workspaceId, e.threadId);
    const result = e.turnId === undefined ? undefined : held.results.get(e.turnId);
    if (e.turnId !== undefined) held.results.delete(e.turnId);
    // A finish is said for a thread a person or the command line opened: an agent's own threads report to it.
    const thread = threadOf(e.workspaceId, e.threadId);
    if (result?.status === "completed" && e.reason === undefined && thread !== undefined && thread.startedBy !== "agent") {
      const { workspaceId, threadId } = e;
      sayOutside(held, () => useStore.getState().select(workspaceId, threadId ?? null), threadLine(HOST_NOTICE_WORDS.threadFinished(thread.title), workspaceNamed(workspaceId) ?? ""));
    }
    // A failure is said the same way, with its error on the line under it. A reason means the runtime ended it (a
    // pause, a delete, the machine gone, which is its own notice), and an interrupted turn is one somebody stopped:
    // neither is a failure to say.
    if (result?.status === "failed" && e.reason === undefined && thread !== undefined && thread.startedBy !== "agent") {
      const { workspaceId, threadId } = e;
      const error = result.error ?? exitLine(e.exitCode);
      sayOutside(held, () => useStore.getState().select(workspaceId, threadId ?? null), threadLine(HOST_NOTICE_WORDS.threadFailed(thread.title), error === undefined ? (workspaceNamed(workspaceId) ?? "") : oneLine(error)));
    }
    if (e.exitCode === 0 || e.sawResult || e.reason !== undefined || result?.status === "interrupted" || threadOnScreen(e)) return;
    const where = workspaceNamed(e.workspaceId);
    const said = result?.error ?? exitLine(e.exitCode);
    addNotice({ kind: "error", text: HOST_NOTICE_WORDS.threadStopped(threadTitle(e.workspaceId, e.threadId), said), ...(where === undefined ? {} : { where }), action: openThread(e.workspaceId, e.threadId) });
  },
  "session.permission": (e, held) => {
    const { workspaceId, threadId } = e;
    sayOutside(held, () => useStore.getState().select(workspaceId, threadId ?? null), threadLine(NEEDS_YOU, askingLine(e)));
    if (threadOnScreen(e)) return;
    const where = workspaceNamed(workspaceId);
    addNotice({ kind: "waiting", key: askKey(workspaceId, threadId, e.askId), text: askingLine(e), ...(where === undefined ? {} : { where }), action: openThread(workspaceId, threadId) });
  },
  "session.permission.closed": e => useNotices.getState().end(askKey(e.workspaceId, e.threadId, e.askId)),
  "session.notify": e => {
    if (e.notify !== NOTIFY_ME || threadOnScreen(e)) return;
    const where = workspaceNamed(e.workspaceId);
    addNotice({ kind: "note", text: e.text, ...(where === undefined ? {} : { where }), action: openThread(e.workspaceId, e.threadId) });
  },
  "job.needs-you": (e, held) => {
    const at = useStore.getState().initJob?.place?.id;
    sayOutside(held, () => openComputer(at).run(), quietLine(e.needsYou.what));
    if (buildOnScreen(at)) return;
    sayNeed(held, e.needsYou.what, at);
  },
  "init.job": (e, held) => {
    // A build already running when this page loaded never saw the press that asks for the browser's leave.
    if (initJobBuilding(e.job.phase)) held.road?.ready();
    const { id, phase } = e.job;
    if ((phase !== "done" && phase !== "failed") || held.jobsEnded.has(id)) return;
    held.jobsEnded.add(id);
    const at = e.job.place?.id;
    if (buildOnScreen(at)) return;
    if (phase === "failed") addNotice({ kind: "error", text: HOST_NOTICE_WORDS.imageNotBuilt(e.job.error), action: openComputer(at) });
    else addNotice({ kind: "done", text: HOST_NOTICE_WORDS.imageSealed(e.job.golden?.version) });
  },
  "workspace.gone": e => {
    const name = workspaceNamed(e.workspaceId);
    if (name === undefined || workspaceOnScreen(e.workspaceId)) return;
    addNotice({ kind: "error", text: HOST_NOTICE_WORDS.gone(name, e.reason), where: name, action: openThread(e.workspaceId, undefined) });
  },
  "workspace.woken": (e, held) => {
    const name = workspaceNamed(e.workspaceId);
    if (name !== undefined) sayOutside(held, () => useStore.getState().select(e.workspaceId), quietLine(workspaceAwakeLine(name)));
  },
};

/** Mounted once under the store: every rule above on the host's events, the window's title carrying the mark while
 * a need or a prompt stands, and a keyed need ended by any read of the job that no longer carries it. */
export function useHostNotices(): void {
  // A build waiting on a sign-in and a thread stopped on a permission prompt are the same fact to a person looking
  // somewhere else, so the window's own title carries the mark for either.
  const needed = useStore(s => s.initJob?.needsYou !== undefined || Object.values(s.sessions).some(rows => rows.some(row => row.asking !== undefined)));
  // Counted where the rows land, so a window showing a thread, which moves its read stamp, takes it off the dock.
  const waiting = useStore(s => needsYouCount(Object.values(s.sessions).flat()));
  const held = useRef<Held>({ road: null, opens: () => openComputer(undefined).run(), need: undefined, shown: false, jobsEnded: new Set(), released: undefined, results: new Map() });
  useEffect(() => {
    const h = held.current;
    const built = needsYouRoad(() => h.opens());
    h.road = built;
    return () => {
      built.close();
      h.road = null;
    };
  }, []);
  useEffect(() => {
    document.title = titleWithNeed(document.title, needed);
  }, [needed]);
  useEffect(() => {
    desktopBridge()?.setBadge?.(waiting);
  }, [waiting]);
  useEffect(() => {
    const h = held.current;
    h.released = releaseSaid();
    sayRelease(h, useStore.getState().release);
    h.shown = buildOnScreen(useStore.getState().initJob?.place?.id);
    const offStore = useStore.subscribe((s, prev) => {
      if (s.release !== prev.release) sayRelease(h, s.release);
      if (s.initJob !== prev.initJob && h.need !== undefined && s.initJob?.needsYou?.what !== h.need) {
        h.need = undefined;
        useNotices.getState().end(NEED_KEY);
      }
      settleShown(h);
    });
    const offSettings = useSettingsStore.subscribe(() => settleShown(h));
    return () => {
      offStore();
      offSettings();
    };
  }, []);
  const onEvent = useCallback((e: ProtocolEvent) => {
    (RULES[e.type] as ((e: ProtocolEvent, held: Held) => void) | undefined)?.(e, held.current);
  }, []);
  useProtocolEvents(onEvent);
}
