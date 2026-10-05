// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road out of the app, against a stubbed Notification: a window
// the person is looking at says nothing, one they are not says the page's line
// as the line asks, shown, sounding, or a sound alone, and a click raises the window
// and tells its page to open what it was about. The dock's badge takes a count
// and nothing else.
import { NEEDS_YOU } from "@wsp/protocol";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { noticeWindowOf, sayOutside, showBadge, type Notifier, type ShellWindow, type SystemNotification } from "../src/needs-you.js";

// Process-wide: every test in this worker runs with gc exposed.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Runs the collector past the current job, which is what lets a WeakRef read empty. */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setImmediate(resolve));
    gc();
  }
}

const NEED = { title: NEEDS_YOU, body: "sign in to GitHub CLI login", show: true, sound: false };

/** A Notification that records what it was built with and what it did, and hands its click back to the test. */
function stub(supported = true) {
  const shown: { title: string; body: string; silent: boolean }[] = [];
  const clicks: (() => void)[] = [];
  let displayed = 0;
  let beeps = 0;
  const notifier: Notifier = {
    supported: () => supported,
    beep: () => {
      beeps += 1;
    },
    refused: () => {},
    make: o => {
      shown.push(o);
      const note: SystemNotification = {
        show: () => {
          displayed += 1;
        },
        on: (event: string, listener: (...args: never[]) => void) => {
          if (event === "click") clicks.push(listener as () => void);
          return note;
        },
      };
      return note;
    },
  };
  return { notifier, shown, clicks, displayed: () => displayed, beeps: () => beeps };
}

function fakeWindow(focused: boolean) {
  const did: string[] = [];
  return { did, win: { focused: () => focused, raise: () => did.push("raise"), open: (id?: string) => did.push(id === undefined ? "open" : `open ${id}`) } };
}

describe("the shell's system notification for something the person should hear about", () => {
  it("says the line's title and body with no sound, once the window has lost focus", () => {
    const { notifier, shown, displayed } = stub();
    const { win } = fakeWindow(false);
    expect(sayOutside(NEED, win, notifier)).toBe(true);
    expect(shown).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: true }]);
    expect(displayed()).toBe(1);
  });

  it("says nothing while the window is the one the person is looking at: the row, the toast and the title already do", () => {
    const { notifier, shown, displayed } = stub();
    const { win, did } = fakeWindow(true);
    expect(sayOutside(NEED, win, notifier)).toBe(false);
    expect(shown).toEqual([]);
    expect(displayed()).toBe(0);
    expect(did).toEqual([]);
  });

  it("a line the person chose to hear and not see plays the system's alert and shows nothing, and none while the window has focus", () => {
    const { notifier, shown, beeps } = stub();
    expect(sayOutside({ ...NEED, show: false, sound: true }, fakeWindow(false).win, notifier)).toBe(true);
    expect(beeps()).toBe(1);
    expect(shown).toEqual([]);
    expect(sayOutside({ ...NEED, show: false, sound: true }, fakeWindow(true).win, notifier)).toBe(false);
    expect(sayOutside({ ...NEED, show: false, sound: false }, fakeWindow(false).win, notifier)).toBe(false);
    expect(beeps()).toBe(1);
  });

  it("a click raises the window and tells its page to open the build screen", () => {
    const { notifier, clicks } = stub();
    const { win, did } = fakeWindow(false);
    sayOutside(NEED, win, notifier);
    expect(clicks).toHaveLength(1);
    expect(did).toEqual([]);
    clicks[0]!();
    expect(did).toEqual(["raise", "open"]);
  });

  it("a click hands the page back the id it put on that line, so the page opens what that line was about", () => {
    const { notifier, clicks } = stub();
    const { win, did } = fakeWindow(false);
    sayOutside({ ...NEED, id: "7" }, win, notifier);
    sayOutside({ ...NEED, id: "8" }, win, notifier);
    clicks[0]!();
    expect(did).toEqual(["raise", "open 7"]);
  });

  it("holds a shown notification until it is clicked, since Electron collects one nothing holds and its click goes nowhere", async () => {
    let made: WeakRef<object> | undefined;
    const notifier: Notifier = {
      supported: () => true,
      beep: () => {},
      refused: () => {},
      make: () => {
        const note: SystemNotification = { show: () => {}, on: () => note };
        made = new WeakRef(note);
        return note;
      },
    };
    sayOutside(NEED, fakeWindow(false).win, notifier);
    await collect();
    expect(made!.deref()).toBeDefined();
  });

  it("a line the system refused to show is logged and still reaches the person by the dock and, where it asked for one, the sound", () => {
    const failed: ((event: unknown, error: string) => void)[] = [];
    const refused: string[] = [];
    let beeps = 0;
    const notifier: Notifier = {
      supported: () => true,
      beep: () => void (beeps += 1),
      refused: error => void refused.push(error),
      make: () => {
        const note: SystemNotification = {
          show: () => {},
          on: (event: string, listener: (...args: never[]) => void) => {
            if (event === "failed") failed.push(listener as (event: unknown, error: string) => void);
            return note;
          },
        };
        return note;
      },
    };
    sayOutside({ ...NEED, sound: true }, fakeWindow(false).win, notifier);
    failed.forEach(f => f({}, "Notifications are not allowed for this application"));
    expect(refused).toEqual(["Notifications are not allowed for this application"]);
    expect(beeps).toBe(1);
  });

  it("a click after its window closed opens the app's window again and tells the gone page nothing, as Electron throws on a destroyed one", () => {
    const { notifier, clicks } = stub();
    let closed = false;
    const gone = (): never => {
      throw new Error("Object has been destroyed");
    };
    const sent: unknown[] = [];
    const win: ShellWindow & { isMinimized(): boolean } = {
      isDestroyed: () => closed,
      isFocused: () => (closed ? gone() : false),
      isMinimized: () => (closed ? gone() : false),
      webContents: { send: (...args: unknown[]) => (closed ? gone() : void sent.push(args)) },
    };
    let reopened = 0;
    sayOutside({ ...NEED, id: "a:1" }, noticeWindowOf(win, w => void w.isMinimized(), () => void (reopened += 1)), notifier);
    closed = true;
    expect(() => clicks[0]!()).not.toThrow();
    expect(reopened).toBe(1);
    expect(sent).toEqual([]);
  });

  it("a computer that shows no notifications is told nothing and builds none", () => {
    const { notifier, shown } = stub(false);
    const { win } = fakeWindow(false);
    expect(sayOutside(NEED, win, notifier)).toBe(false);
    expect(shown).toEqual([]);
  });

  it("a line that asks for a sound makes one, and one that does not stays silent", () => {
    const { notifier, shown } = stub();
    const { win } = fakeWindow(false);
    sayOutside({ title: "Fix the redirect finished", body: "spoo-landing", show: true, sound: true }, win, notifier);
    sayOutside({ ...NEED, sound: false }, win, notifier);
    expect(shown.map(o => o.silent)).toEqual([false, true]);
    expect(shown[0]).toEqual({ title: "Fix the redirect finished", body: "spoo-landing", silent: false });
  });
});

describe("the dock's badge", () => {
  it("shows the count the page hands over, zero clears it, and anything but a whole count is dropped", () => {
    const counts: number[] = [];
    const dock = { setBadgeCount: (n: number) => void counts.push(n) };
    showBadge(3, dock);
    showBadge(0, dock);
    for (const bad of [-1, 1.5, "2", null, Number.NaN]) showBadge(bad, dock);
    expect(counts).toEqual([3, 0]);
  });
});
