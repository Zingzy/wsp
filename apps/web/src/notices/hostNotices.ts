// SPDX-License-Identifier: AGPL-3.0-only
// The host's events that become notices, one rule per event type. A notice is
// for what happened away from where the person is looking: an event whose home
// is on screen (that thread open, that computer's row showing, that sheet
// open) is the panel's to show and says nothing here. A wait (a build's need,
// a thread's prompt) is keyed and stands until the event that closes it. The
// need, the prompt and a machine that came up also go out on the shell's own
// road, which speaks only while the app is not in front of the person.
import { CLOUD_SETUP_WORDS, GET_THE_APP_WORD, NOTIFY_ME, askingLine, foldThreads, initJobBuilding, initNeedsYouLine, threadKeyOf, titleWithNeed, workspaceAwakeLine, type InitNeedsYou, type ReleaseView, type TurnResult } from "@wsp/protocol";
import { useCallback, useEffect, useRef } from "react";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { placeName } from "../settings/places.js";
import { useSettingsStore } from "../settings/settingsStore.js";
import { needsYouRoad, type NeedsYouRoad } from "../shell/needsYou.js";
import { releaseAhead, shellVersions } from "../shell/shellVersion.js";
import { addNotice, useNotices, type NoticeAction } from "./store.js";

/** How long a computer stays quiet before it is said: a box that relinks inside this was a blip, not news. */
export const ABSENT_NOTICE_MS = 30_000;

export const HOST_NOTICE_WORDS = {
  open: "Open",
  notAdded: (said: string): string => `Computer not added: ${said}`,
  joined: (name: string): string => `${name} joined`,
  notSetUp: (name: string, said: string): string => `${name} not set up: ${said}`,
  setUp: (name: string): string => `${name} is set up`,
  away: (name: string): string => `${name} stopped answering`,
  aThread: "A thread",
  threadStopped: (title: string, said: string | undefined): string => `${title} stopped before it replied${said === undefined ? "" : `: ${said}`}`,
  gone: (name: string, reason: string): string => `${name} is gone: ${reason}`,
  imageNotBuilt: (said: string | undefined): string => (said === undefined ? "The image was not built" : `The image was not built: ${said}`),
  imageSealed: (version: number | undefined): string => (version === undefined ? "Image sealed" : `Image v${version} sealed`),
  released: (version: string): string => `wsp ${version} is out`,
};

const NEED_KEY = "needs-you";
const askKey = (workspaceId: string, threadId: string | undefined, askId: string): string => `${askPrefix(workspaceId, threadId)}${askId}`;
const askPrefix = (workspaceId: string, threadId: string | undefined): string => `ask:${workspaceId}:${threadId ?? workspaceId}:`;

const workspaceNamed = (id: string): string | undefined => useStore.getState().workspaces.find(w => w.id === id)?.name;

function threadTitle(workspaceId: string, threadId: string | undefined): string {
  const threads = foldThreads(useStore.getState().sessions[workspaceId] ?? []);
  return threads.find(t => t.id === threadId)?.title ?? HOST_NOTICE_WORDS.aThread;
}

function threadOnScreen(workspaceId: string, threadId: string | undefined): boolean {
  const s = useStore.getState();
  if (s.settingsOpen || s.freshThread || s.selectedId !== workspaceId) return false;
  const latest = s.sessions[workspaceId]?.at(-1);
  // With no thread picked the centre reads the workspace's latest one.
  const shown = s.selectedThreadId ?? (latest === undefined ? undefined : threadKeyOf(latest));
  return threadId === undefined || shown === undefined || shown === threadId;
}

const workspaceOnScreen = (workspaceId: string): boolean => !useStore.getState().settingsOpen && useStore.getState().selectedId === workspaceId;

const setupOnScreen = (): boolean => useStore.getState().settingsOpen && useStore.getState().setupOpen;

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
const openSetup: NoticeAction = { word: CLOUD_SETUP_WORDS.needsYou.open, run: () => useStore.getState().openSetup() };
const openComputer = (placeId: string | undefined): NoticeAction => ({
  word: HOST_NOTICE_WORDS.open,
  run: () => {
    useSettingsStore.getState().go(placeId === undefined ? { kind: "group", group: "computers" } : { kind: "computer", id: placeId });
    useStore.getState().openSettings();
  },
});

interface Absence {
  said?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** What the rules keep between events, for one mounted effect. */
interface Held {
  road: NeedsYouRoad | null;
  /** What a click on the last thing the shell's road said opens: the road hands a click back for whatever it showed last. */
  opens: () => void;
  /** The need the keyed notice stands for. */
  need: string | undefined;
  /** Computers gone quiet, by place id, until they come back: a said one stays with no timer so the same absence is said once. */
  absences: Map<string, Absence>;
  /** The jobs whose end has been said. */
  jobsEnded: Set<string>;
  /** The release versions said. */
  released: Set<string>;
  /** Each running turn's result, by turn id, from its session.done until the session.end that always follows it. */
  results: Map<string, TurnResult>;
}

function sayOutside(held: Held, opens: () => void, need: InitNeedsYou): void {
  held.opens = opens;
  held.road?.say(need);
}

function sayAbsence(placeId: string, said: string | undefined): void {
  const place = useStore.getState().places.find(p => p.id === placeId);
  if (place === undefined || place.present || computerOnScreen(placeId)) return;
  const name = placeName(place);
  addNotice({ kind: "error", text: said ?? HOST_NOTICE_WORDS.away(name), where: name, action: openComputer(placeId) });
}

function forgetAbsence(held: Held, placeId: string): void {
  const absence = held.absences.get(placeId);
  if (absence?.timer !== undefined) clearTimeout(absence.timer);
  held.absences.delete(placeId);
}

function endAsks(workspaceId: string, threadId: string | undefined): void {
  const prefix = askPrefix(workspaceId, threadId);
  const notices = useNotices.getState();
  for (const key of new Set(notices.notices.map(n => n.key).filter((k): k is string => k?.startsWith(prefix) === true))) notices.end(key);
}

function sayRelease(held: Held, release: ReleaseView | null): void {
  const ahead = releaseAhead(release, shellVersions());
  if (ahead === undefined || held.released.has(ahead.version)) return;
  held.released.add(ahead.version);
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
    addNotice({ kind: "done", text: e.step === "join" ? HOST_NOTICE_WORDS.joined(name) : HOST_NOTICE_WORDS.setUp(name), ...where, action: openComputer(e.placeId) });
  },
  "place.absent": (e, held) => {
    const standing = held.absences.get(e.placeId);
    if (standing !== undefined) {
      if (e.said !== undefined) standing.said = e.said;
      return;
    }
    const absence: Absence = e.said === undefined ? {} : { said: e.said };
    absence.timer = setTimeout(() => {
      delete absence.timer;
      sayAbsence(e.placeId, absence.said);
    }, ABSENT_NOTICE_MS);
    held.absences.set(e.placeId, absence);
  },
  "place.present": (e, held) => forgetAbsence(held, e.placeId),
  "session.done": (e, held) => {
    if (e.turnId !== undefined) held.results.set(e.turnId, e.result);
  },
  "session.end": (e, held) => {
    endAsks(e.workspaceId, e.threadId);
    const result = e.turnId === undefined ? undefined : held.results.get(e.turnId);
    if (e.turnId !== undefined) held.results.delete(e.turnId);
    // A reason means the runtime ended it (a pause, a delete, the machine gone, which is its own notice), and an
    // interrupted turn is one somebody stopped: neither is a failure to say.
    if (e.exitCode === 0 || e.sawResult || e.reason !== undefined || result?.status === "interrupted" || threadOnScreen(e.workspaceId, e.threadId)) return;
    const where = workspaceNamed(e.workspaceId);
    const said = result?.error ?? (e.exitCode === null ? undefined : `exit ${e.exitCode}`);
    addNotice({ kind: "error", text: HOST_NOTICE_WORDS.threadStopped(threadTitle(e.workspaceId, e.threadId), said), ...(where === undefined ? {} : { where }), action: openThread(e.workspaceId, e.threadId) });
  },
  "session.permission": (e, held) => {
    const { workspaceId, threadId } = e;
    sayOutside(held, () => useStore.getState().select(workspaceId, threadId ?? null), { what: askingLine(e), since: Date.now() });
    if (threadOnScreen(workspaceId, threadId)) return;
    const where = workspaceNamed(workspaceId);
    addNotice({ kind: "waiting", key: askKey(workspaceId, threadId, e.askId), text: askingLine(e), ...(where === undefined ? {} : { where }), action: openThread(workspaceId, threadId) });
  },
  "session.permission.closed": e => useNotices.getState().end(askKey(e.workspaceId, e.threadId, e.askId)),
  "session.notify": e => {
    if (e.notify !== NOTIFY_ME || threadOnScreen(e.workspaceId, e.threadId)) return;
    const where = workspaceNamed(e.workspaceId);
    addNotice({ kind: "note", text: e.text, ...(where === undefined ? {} : { where }), action: openThread(e.workspaceId, e.threadId) });
  },
  "job.needs-you": (e, held) => {
    sayOutside(held, () => useStore.getState().openSetup(), e.needsYou);
    if (setupOnScreen()) return;
    held.need = e.needsYou.what;
    addNotice({ kind: "waiting", key: NEED_KEY, text: initNeedsYouLine(e.needsYou.what), action: openSetup });
  },
  "init.job": (e, held) => {
    // A build already running when this page loaded never saw the press that asks for the browser's leave.
    if (initJobBuilding(e.job.phase)) held.road?.ready();
    const { id, phase } = e.job;
    if ((phase !== "done" && phase !== "failed") || held.jobsEnded.has(id)) return;
    held.jobsEnded.add(id);
    if (setupOnScreen()) return;
    if (phase === "failed") addNotice({ kind: "error", text: HOST_NOTICE_WORDS.imageNotBuilt(e.job.error), action: openSetup });
    else addNotice({ kind: "done", text: HOST_NOTICE_WORDS.imageSealed(e.job.golden?.version) });
  },
  "workspace.gone": e => {
    const name = workspaceNamed(e.workspaceId);
    if (name === undefined || workspaceOnScreen(e.workspaceId)) return;
    addNotice({ kind: "error", text: HOST_NOTICE_WORDS.gone(name, e.reason), where: name, action: openThread(e.workspaceId, undefined) });
  },
  "workspace.woken": (e, held) => {
    const name = workspaceNamed(e.workspaceId);
    if (name !== undefined) sayOutside(held, () => useStore.getState().select(e.workspaceId), { what: workspaceAwakeLine(name), since: Date.now() });
  },
};

/** Mounted once under the store: every rule above on the host's events, the window's title carrying the mark while
 * a need or a prompt stands, and a keyed need ended by any read of the job that no longer carries it. */
export function useHostNotices(): void {
  // A build waiting on a sign-in and a thread stopped on a permission prompt are the same fact to a person looking
  // somewhere else, so the window's own title carries the mark for either.
  const needed = useStore(s => s.initJob?.needsYou !== undefined || Object.values(s.sessions).some(rows => rows.some(row => row.asking !== undefined)));
  const held = useRef<Held>({ road: null, opens: () => useStore.getState().openSetup(), need: undefined, absences: new Map(), jobsEnded: new Set(), released: new Set(), results: new Map() });
  useEffect(() => {
    const h = held.current;
    const built = needsYouRoad(() => h.opens());
    h.road = built;
    return () => {
      built.close();
      h.road = null;
      for (const absence of h.absences.values()) if (absence.timer !== undefined) clearTimeout(absence.timer);
      h.absences.clear();
    };
  }, []);
  useEffect(() => {
    document.title = titleWithNeed(document.title, needed);
  }, [needed]);
  useEffect(() => {
    const h = held.current;
    sayRelease(h, useStore.getState().release);
    return useStore.subscribe((s, prev) => {
      if (s.release !== prev.release) sayRelease(h, s.release);
      if (s.initJob !== prev.initJob && h.need !== undefined && s.initJob?.needsYou?.what !== h.need) {
        h.need = undefined;
        useNotices.getState().end(NEED_KEY);
      }
    });
  }, []);
  const onEvent = useCallback((e: ProtocolEvent) => {
    (RULES[e.type] as ((e: ProtocolEvent, held: Held) => void) | undefined)?.(e, held.current);
  }, []);
  useProtocolEvents(onEvent);
}
