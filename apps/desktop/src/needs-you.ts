// SPDX-License-Identifier: AGPL-3.0-only
// The system notification the shell shows when something the person should
// hear about happens (a build waiting, a machine up, a permission prompt, a
// finished turn) and this window is not the one they are looking at. The page
// cannot read its own window's focus, so it hands the line over and the
// decision is made here: a focused window says nothing, since the sidebar's
// row, the toast and the title already do. A click raises the window and tells
// the page to open whatever was spoken about. The page says which lines show
// and which sound, each as the person chose for that kind of moment; a line
// that only sounds plays the system's own alert. The dock's badge is the count
// of threads waiting on the person.
import type { OutsideLine, OutsideOpen } from "@wsp/protocol";

/** The part of Electron's Notification this needs; a fake stands in for it under test. */
export interface SystemNotification {
  show(): void;
  on(event: "click", listener: () => void): void;
}

/** What the shell builds one from, and whether this computer can show one at all. */
export interface Notifier {
  supported(): boolean;
  make(o: { title: string; body: string; silent: boolean }): SystemNotification;
  /** The system's alert sound with nothing shown, for a moment the person chose to hear and not see. */
  beep(): void;
}

/** The window a need is spoken for: whether the person is looking at it, how it is raised, and how the page on it is
 * told a click landed so it opens the build. */
export interface NoticeWindow {
  focused(): boolean;
  raise(): void;
  /** Tells the page a click landed, with what the line opens where it names something: a setup's computer. */
  open(at?: OutsideOpen): void;
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
  shown.on("click", () => {
    win.raise();
    win.open(line.open);
  });
  shown.show();
  return true;
}

/** The part of Electron's app the badge needs. */
export interface Dock {
  setBadgeCount(count: number): void;
}

/** Puts the page's count on the dock; zero clears it, and anything but a whole count is dropped. */
export function showBadge(count: unknown, dock: Dock): void {
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) dock.setBadgeCount(count);
}
