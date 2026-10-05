// SPDX-License-Identifier: AGPL-3.0-only
// How a need, a prompt, a machine that came up or a finished turn is said
// outside the app. Which
// road that takes belongs to the shell, so there is one road per shell and the
// app picks by which one holds: the desktop shell owns its window's focus, so
// the page hands it the sentence and it decides whether to show anything; a
// browser tab has the browser's own notifications, asked for on the press that
// opens the setup and spoken only while the tab is hidden. Nothing is said
// while the app is in front of the person, and a line shows and sounds only
// where it says so; a line that only sounds plays a short tone.
import { OUTSIDE_HELD, type OutsideLine } from "@wsp/protocol";
import { desktopBridge } from "../lib/desktopShell.js";

/** Whether the shell holding this page owns its own notifications: the one reading of which road speaks, so the
 * browser's own leave is neither asked for nor needed there. */
const shellOwnsNotices = (): boolean => desktopBridge()?.sayOutside !== undefined;

/** Leave to notify, asked at most once a page and only where the browser owns the notifications. It rides a press
 * rather than an event on purpose: Safari ignores a request made outside a gesture and the others quieten it to a
 * prompt most people never see, so the ask goes out as a build starts, which a press on the Image card's Build began.
 * A shell with its own notifications needs no leave. */
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
  /** Says the line outside the app, or nothing while the app already has the person's eyes; a click on it runs opens. */
  say(line: OutsideLine, opens: () => void): void;
  /** Drops the listener for a click on whatever this road showed, and anything it left standing. */
  close(): void;
}

/** The desktop shell's road: the line goes over the bridge and the shell decides on its own window's focus, since a
 * page cannot read it. A click there raises the window and hands back the line's id, and the page opens what that
 * line was about. The shell holds a notification past a reload, so each road's ids carry a word of its own and a
 * click on a line an earlier page said opens nothing here. */
function desktopRoad(): NeedsYouRoad {
  const bridge = desktopBridge()!;
  const opens = new Map<string, () => void>();
  const page = crypto.randomUUID();
  let said = 0;
  const off = bridge.onNeedsYouOpen?.(id => (id === undefined ? undefined : opens.get(id))?.());
  return {
    ready: () => {},
    say: (line, open) => {
      const id = `${page}:${(said += 1)}`;
      opens.set(id, open);
      if (opens.size > OUTSIDE_HELD) opens.delete(opens.keys().next().value!);
      bridge.sayOutside?.({ ...line, id });
    },
    close: () => off?.(),
  };
}

/** A short tone for a line the person chose to hear and not see; a browser that will not play one says nothing. */
function chime(): void {
  if (typeof AudioContext === "undefined") return;
  try {
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.frequency.value = 880;
    level.gain.setValueAtTime(0.15, audio.currentTime);
    level.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
    tone.connect(level).connect(audio.destination);
    tone.onended = () => void audio.close();
    tone.start();
    tone.stop(audio.currentTime + 0.3);
  } catch {
    // A tab the browser holds no sound for stays quiet; the sidebar and the title still say it.
  }
}

/** A browser tab's road: the browser's own notifications, asked for once and spoken only while the tab is hidden. */
function browserRoad(): NeedsYouRoad {
  const standing = new Set<Notification>();
  const has = (): boolean => typeof Notification !== "undefined";
  return {
    ready: askToNotify,
    say: (line, open) => {
      if (!document.hidden) return;
      if (!line.show) {
        if (line.sound) chime();
        return;
      }
      if (!has() || Notification.permission !== "granted") return;
      const shown = new Notification(line.title, { body: line.body, silent: !line.sound });
      standing.add(shown);
      shown.onclose = () => standing.delete(shown);
      shown.onclick = () => {
        window.focus();
        shown.close();
        standing.delete(shown);
        open();
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
const ROADS: readonly { holds(): boolean; road(): NeedsYouRoad }[] = [
  { holds: shellOwnsNotices, road: desktopRoad },
  { holds: () => true, road: browserRoad },
];

export const needsYouRoad = (): NeedsYouRoad => ROADS.find(r => r.holds())!.road();
