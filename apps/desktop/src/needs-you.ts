// SPDX-License-Identifier: AGPL-3.0-only
// The system notification the shell shows when something the person should
// hear about happens (a build waiting, a machine up, a permission prompt, a
// finished turn) and this window is not the one they are looking at. The page
// cannot read its own window's focus, so it hands the line over and the
// decision is made here: a focused window says nothing, since the sidebar's
// row, the toast and the title already do. A click raises the window and tells
// the page to open whatever was spoken about, by the id the page put on the
// line. The page says which lines show and which sound, each as the person
// chose for that kind of moment; a line that only sounds plays the system's own
// alert. The dock's badge is the count of threads waiting on the person, with
// a mark beside it while an account's plan alert stands.
import { DEFAULT_PREFERENCES, OUTSIDE_HELD, UsageAlertEvent, type OutsideLine } from "@wsp/protocol";

/** The part of Electron's Notification this needs; a fake stands in for it under test. */
export interface SystemNotification {
  show(): void;
  on(event: "click" | "close", listener: () => void): this;
  on(event: "failed", listener: (event: unknown, error: string) => void): this;
}

/** What the shell builds one from, and whether this computer can show one at all. */
export interface Notifier {
  supported(): boolean;
  make(o: { title: string; body: string; silent: boolean }): SystemNotification;
  /** The system's alert sound with nothing shown, for a moment the person chose to hear and not see. */
  beep(): void;
  /** A line the system would not show, as macOS answers an app with no Developer ID signature: said where it can be
   * read, and the person still drawn to the app. */
  refused(error: string): void;
}

/** The window a need is spoken for: whether the person is looking at it, how it is raised, and how the page on it is
 * told a click landed so it opens the build. */
export interface NoticeWindow {
  focused(): boolean;
  raise(): void;
  /** Tells the page a click landed, with the id the page put on the line. */
  open(id?: string): void;
}

/** The part of Electron's BrowserWindow a line said for it needs. */
export interface ShellWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/** The window a page's line was said for. A held notification outlives a window closed on a Mac, and Electron throws
 * on any call into a destroyed one, so a click then opens the app's window again and tells the gone page nothing. */
export function noticeWindowOf<W extends ShellWindow>(win: W, raise: (win: W) => void, reopen: () => void): NoticeWindow {
  return {
    focused: () => !win.isDestroyed() && win.isFocused(),
    raise: () => (win.isDestroyed() ? reopen() : raise(win)),
    open: id => {
      if (!win.isDestroyed()) win.webContents.send("needs-you:open", id);
    },
  };
}

/** Shows the line over the system, or sounds it alone where it shows nothing, or says nothing when the person is
 * already looking at the window it belongs to or this computer shows no notifications. True where anything was said,
 * which is what a test reads. */
export function sayOutside(line: OutsideLine, win: NoticeWindow, notifier: Notifier): boolean {
  if (win.focused() || (!line.show && !line.sound)) return false;
  if (!line.show) {
    notifier.beep();
    return true;
  }
  if (!notifier.supported()) return false;
  const shown = notifier.make({ title: line.title, body: line.body, silent: !line.sound });
  hold(shown);
  shown
    .on("click", () => {
      standing.delete(shown);
      win.raise();
      win.open(line.id);
    })
    .on("close", () => standing.delete(shown))
    .on("failed", (_event, error) => {
      standing.delete(shown);
      notifier.refused(error);
      if (line.sound) notifier.beep();
    });
  shown.show();
  return true;
}

/** Electron collects a notification nothing holds, which takes it out of Notification Center and its click with it.
 * Each is held until it is clicked or closed; macOS does not always say a close, so past the cap the oldest goes. */
const standing = new Set<SystemNotification>();

function hold(shown: SystemNotification): void {
  standing.add(shown);
  if (standing.size > OUTSIDE_HELD) standing.delete(standing.values().next().value!);
}

/** The part of Electron's app the badge needs: a count, and on a Mac the dock's own badge, which takes words. */
export interface Dock {
  setBadgeCount(count: number): void;
  dock?: { setBadge(text: string): void } | undefined;
}

/** What the badge says beside the count while an account's plan alert stands. */
export const PLAN_BADGE_MARK = "!";

/** Puts the page's count on the dock, and a standing plan alert beside it: on a Mac as the mark after the count,
 * elsewhere, where the badge is a count alone, as one more. Nothing to show clears it, and anything but a whole
 * count is dropped. */
export function showBadge(count: unknown, dock: Dock, planAlert = false): void {
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return;
  if (dock.dock === undefined) return dock.setBadgeCount(count + (planAlert ? 1 : 0));
  dock.dock.setBadge([...(count > 0 ? [String(count)] : []), ...(planAlert ? [PLAN_BADGE_MARK] : [])].join(" "));
}

export interface DockBadge {
  /** The count of threads waiting on the person, from the page or, with no window, the menu bar. */
  count(count: unknown): void;
  /** An event the host sent: a window run low or a block marks its account, and the account back takes it off. */
  heard(event: { type: string }): void;
  /** The person opened Usage, or the window moved to another host's accounts: every mark goes. */
  seen(): void;
  /** The plan alerts switch in Settings > General; off, the badge carries no mark. */
  alerts(on: boolean): void;
}

/** The dock's badge, painted again whenever what it shows moved. */
export function dockBadge(dock: Dock): DockBadge {
  let waiting: unknown = 0;
  let on = DEFAULT_PREFERENCES.planAlerts;
  const standing = new Set<string>();
  const paint = (): void => showBadge(waiting, dock, on && standing.size > 0);
  return {
    count: count => {
      waiting = count;
      paint();
    },
    heard: event => {
      const alert = UsageAlertEvent.safeParse(event);
      if (!alert.success) return;
      if (alert.data.alert.kind === "back") standing.delete(alert.data.key);
      else standing.add(alert.data.key);
      paint();
    },
    seen: () => {
      if (standing.size === 0) return;
      standing.clear();
      paint();
    },
    alerts: next => {
      if (next === on) return;
      on = next;
      paint();
    },
  };
}
