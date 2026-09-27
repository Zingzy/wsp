// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road out of the app, against a stubbed Notification: a window
// the person is looking at says nothing, one they are not says the page's line
// with a sound only where the line asks for one, and a click raises the window
// and tells its page to open what it was about. The dock's badge takes a count
// and nothing else.
import { NEEDS_YOU } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { sayOutside, showBadge, type Notifier, type SystemNotification } from "../src/needs-you.js";

const NEED = { title: NEEDS_YOU, body: "sign in to GitHub CLI login", sound: false };

/** A Notification that records what it was built with and what it did, and hands its click back to the test. */
function stub(supported = true) {
  const shown: { title: string; body: string; silent: boolean }[] = [];
  const clicks: (() => void)[] = [];
  let displayed = 0;
  const notifier: Notifier = {
    supported: () => supported,
    make: o => {
      shown.push(o);
      const note: SystemNotification = {
        show: () => {
          displayed += 1;
        },
        on: (_event, listener) => clicks.push(listener),
      };
      return note;
    },
  };
  return { notifier, shown, clicks, displayed: () => displayed };
}

function fakeWindow(focused: boolean) {
  const did: string[] = [];
  return { did, win: { focused: () => focused, raise: () => did.push("raise"), open: () => did.push("open") } };
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

  it("a click raises the window and tells its page to open the build screen", () => {
    const { notifier, clicks } = stub();
    const { win, did } = fakeWindow(false);
    sayOutside(NEED, win, notifier);
    expect(clicks).toHaveLength(1);
    expect(did).toEqual([]);
    clicks[0]!();
    expect(did).toEqual(["raise", "open"]);
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
    sayOutside({ title: "Fix the redirect finished", body: "spoo-landing", sound: true }, win, notifier);
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
