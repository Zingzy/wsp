// SPDX-License-Identifier: AGPL-3.0-only
// What the app does with the job's one needsYou field beyond the sidebar's
// row: the window or tab title leads with the mark while a need stands, and
// each need's arrival is said once outside the app. A machine that came up
// takes the same road, so a wake and a build speak in one voice. Which road
// that takes belongs to the shell, so there is one road per shell and the app
// picks by which one holds: the desktop shell owns its window's focus, so the
// page hands it the sentence and it decides whether to show anything; a
// browser tab has the browser's own notifications, asked for on the press that
// opens the setup and spoken only while the tab is hidden. Nothing is said
// while the app is in front of the person, and nothing makes a sound.
import { NEEDS_YOU, askingLine, initJobBuilding, titleWithNeed, workspaceAwakeLine, type InitNeedsYou } from "@wsp/protocol";
import { useCallback, useEffect, useRef } from "react";
import { desktopBridge } from "../lib/desktopShell.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import type { ProtocolEvent } from "../protocol/client.js";

/** Whether the shell holding this page owns its own notifications: the one reading of which road speaks, so the
 * browser's own leave is neither asked for nor needed there. */
const shellOwnsNotices = (): boolean => desktopBridge()?.needsYou !== undefined;

/** Leave to notify, asked at most once a page and only where the browser owns the notifications. It rides a press
 * rather than an event on purpose: Safari ignores a request made outside a gesture and the others quieten it to a
 * prompt most people never see, so the ask goes on the one press every road to a build passes through, the sidebar's
 * own keycap. A shell with its own notifications needs no leave. */
let asked = false;
export function askToNotify(): void {
  if (asked || shellOwnsNotices() || typeof Notification === "undefined" || Notification.permission !== "default") return;
  asked = true;
  void Notification.requestPermission();
}

/** Test isolation: forget that this page has asked. */
export function resetAskedToNotify(): void {
  asked = false;
}

/** How one shell tells the person outside the app. */
export interface NeedsYouRoad {
  /** Asks for whatever the road needs before it can speak; nothing on a shell that needs no leave. */
  ready(): void;
  /** Says the need outside the app, or nothing while the app already has the person's eyes. */
  say(need: InitNeedsYou): void;
  /** Drops the listener for a click on whatever this road showed, and anything it left standing. */
  close(): void;
}

/** The desktop shell's road: the need goes over the bridge and the shell decides on its own window's focus, since a
 * page cannot read it. A click there raises the window and the page opens the build. */
function desktopRoad(onOpen: () => void): NeedsYouRoad {
  const bridge = desktopBridge()!;
  const off = bridge.onNeedsYouOpen?.(onOpen);
  return {
    ready: () => {},
    say: need => bridge.needsYou?.(need),
    close: () => off?.(),
  };
}

/** A browser tab's road: the browser's own notifications, asked for once and spoken only while the tab is hidden. */
function browserRoad(onOpen: () => void): NeedsYouRoad {
  const standing = new Set<Notification>();
  const has = (): boolean => typeof Notification !== "undefined";
  return {
    ready: askToNotify,
    say: need => {
      if (!has() || Notification.permission !== "granted" || !document.hidden) return;
      const shown = new Notification(NEEDS_YOU, { body: need.what, silent: true });
      standing.add(shown);
      shown.onclick = () => {
        window.focus();
        shown.close();
        standing.delete(shown);
        onOpen();
      };
    },
    close: () => {
      for (const shown of standing) shown.close();
      standing.clear();
    },
  };
}

/** One entry per shell: which one holds this page, and the road it gives. Adding a shell adds a row here and its
 * road above, and nothing else reads which shell is running. */
const ROADS: readonly { holds(): boolean; road(onOpen: () => void): NeedsYouRoad }[] = [
  { holds: shellOwnsNotices, road: desktopRoad },
  { holds: () => true, road: browserRoad },
];

export const needsYouRoad = (onOpen: () => void): NeedsYouRoad => ROADS.find(r => r.holds())!.road(onOpen);

/** Mounted once under the store: the title carries the mark for as long as the job's need stands, and each need's
 * arrival, which is its own event and so already one per need, is said once on this shell's road. */
export function useNeedsYouEffect(): void {
  // A build waiting on a sign-in and a thread stopped on a permission prompt are the same fact to a person who is
  // looking somewhere else, so the window's own title carries the mark for either.
  const needed = useStore(s => s.initJob?.needsYou !== undefined || Object.values(s.sessions).some(rows => rows.some(row => row.asking !== undefined)));
  const road = useRef<NeedsYouRoad | null>(null);
  /** What a click on the last thing said opens: the build for a need, the workspace for a machine that came up. One
   * ref rather than one road per kind, since a shell hands a click back for whatever it showed last. */
  const opens = useRef<() => void>(() => useStore.getState().openSetup());
  useEffect(() => {
    const built = needsYouRoad(() => opens.current());
    road.current = built;
    return () => {
      built.close();
      road.current = null;
    };
  }, []);
  useEffect(() => {
    document.title = titleWithNeed(document.title, needed);
  }, [needed]);
  const onEvent = useCallback((e: ProtocolEvent) => {
    // A build already running when this page loaded never saw the press that asks, so it asks here too; the flag
    // above keeps it to one ask, and a browser that wants a gesture has already had the better road.
    if (e.type === "init.job" && initJobBuilding(e.job.phase)) road.current?.ready();
    if (e.type === "job.needs-you") {
      opens.current = () => useStore.getState().openSetup();
      road.current?.say(e.needsYou);
    }
    // A prompt rides the same road: the thread is stopped until somebody picks, and nothing else outside the
    // thread's own pane says so. Said once, on the event that opens it, as a build's need is.
    if (e.type === "session.permission") {
      const { workspaceId, threadId } = e;
      opens.current = () => useStore.getState().select(workspaceId, threadId);
      road.current?.say({ what: askingLine(e), since: Date.now() });
    }
    // A machine that came up rides the same road: a wake the provider took minutes to accept lands with the person
    // looking somewhere else, and the road itself is what stays quiet while they are looking at the app.
    if (e.type === "workspace.woken") {
      const woken = useStore.getState().workspaces.find(w => w.id === e.workspaceId);
      if (woken === undefined) return;
      opens.current = () => useStore.getState().select(woken.id);
      road.current?.say({ what: workspaceAwakeLine(woken.name), since: Date.now() });
    }
  }, []);
  useProtocolEvents(onEvent);
}
