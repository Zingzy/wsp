// SPDX-License-Identifier: AGPL-3.0-only
// A browser tab's guest runs on its own partition, sandboxed and isolated with no preload, made only by the app's own
// host's page; its new windows become tabs and a link to another app asks first.
import { BROWSER_PARTITION, type GuestOpen } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { attachGuest, guardGuestSession, guestGuards, guestWindow, type GuestContents, type GuestPreferences, type GuestSession, type GuestShell } from "../src/guests.js";

const APP_PAGE = "http://127.0.0.1:4400/";

function fakeShell(answer = false): GuestShell & { tabs: GuestOpen[]; asked: string[]; opened: string[] } {
  const tabs: GuestOpen[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  return {
    tabs,
    asked,
    opened,
    mayHold: url => url === APP_PAGE,
    newTab: open => tabs.push(open),
    ask: async url => {
      asked.push(url);
      return answer;
    },
    openOutside: url => opened.push(url),
  };
}

/** A window on a page, with the guards set on it: whether an attach went through, and a guest's new-window handler. */
function fakeWindow(shell: GuestShell, pageUrl = APP_PAGE): { attach(prefs: GuestPreferences, at?: string): boolean; attached(id: number): (url: string) => { action: string } } {
  let page = pageUrl;
  const guards = guestGuards({ getURL: () => page }, shell);
  return {
    attach(prefs, at = pageUrl) {
      page = at;
      let refused = false;
      guards.willAttach({ preventDefault: () => (refused = true) }, prefs);
      return !refused;
    },
    attached(id) {
      let handler: ((details: { url: string }) => { action: "deny" }) | undefined;
      const guest: GuestContents = { id, setWindowOpenHandler: h => (handler = h) };
      guards.didAttach({}, guest);
      return url => handler!({ url });
    },
  };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe("a guest's attach", () => {
  it("runs on the browser partition sandboxed and isolated, with the preload and node a page asked for stripped", () => {
    const prefs: GuestPreferences = { partition: BROWSER_PARTITION, preload: "/tmp/evil.js", sandbox: false, contextIsolation: false, nodeIntegration: true, nodeIntegrationInSubFrames: true, webSecurity: false };
    expect(attachGuest(prefs)).toBe(true);
    expect(prefs).toEqual({ partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true });
  });

  it("refuses the window's own session, another partition and one named through webpreferences", () => {
    expect(attachGuest({})).toBe(false);
    expect(attachGuest({ partition: "" })).toBe(false);
    expect(attachGuest({ partition: "persist:other" })).toBe(false);
    expect(attachGuest({ partition: BROWSER_PARTITION.replace("persist:", "") })).toBe(false);
  });

  it("is refused for any page but the one that may hold guests, whatever partition it names", () => {
    const win = fakeWindow(fakeShell());
    expect(win.attach({ partition: BROWSER_PARTITION })).toBe(true);
    expect(win.attach({ partition: "persist:other" })).toBe(false);
    expect(win.attach({ partition: BROWSER_PARTITION }, "https://box.example/")).toBe(false);
    expect(win.attach({ partition: BROWSER_PARTITION }, "file:///app/onboarding.html")).toBe(false);
  });
});

describe("a guest's new window", () => {
  it("opens a web page as a new tab of the page holding the guest, naming the guest", () => {
    const shell = fakeShell();
    const open = fakeWindow(shell).attached(7);
    expect(open("https://example.org/")).toEqual({ action: "deny" });
    expect(open("http://localhost:3000/a")).toEqual({ action: "deny" });
    expect(shell.tabs).toEqual([
      { guest: 7, url: "https://example.org/" },
      { guest: 7, url: "http://localhost:3000/a" },
    ]);
    expect(shell.asked).toEqual([]);
  });

  it("asks before another app's link leaves, and opens it only on yes", async () => {
    const no = fakeShell(false);
    fakeWindow(no).attached(1)("slack://open?team=T1");
    await settle();
    expect(no.asked).toEqual(["slack://open?team=T1"]);
    expect(no.opened).toEqual([]);

    const yes = fakeShell(true);
    fakeWindow(yes).attached(1)("zoommtg://zoom.us/join?confno=1");
    await settle();
    expect(yes.opened).toEqual(["zoommtg://zoom.us/join?confno=1"]);
    expect(yes.tabs).toEqual([]);
  });

  it("sends this computer's files, script and the browser's own pages nowhere", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "not a url"]) expect(guestWindow(url), url).toBe("drop");
    expect(guestWindow("mailto:a@example.com")).toBe("ask");
  });
});

describe("the guest session", () => {
  function fakeSession(): GuestSession & { request(permission: string, details?: { externalURL?: string }): Promise<boolean>; check(permission: string): boolean } {
    let onRequest: Parameters<GuestSession["setPermissionRequestHandler"]>[0] | undefined;
    let onCheck: Parameters<GuestSession["setPermissionCheckHandler"]>[0] | undefined;
    return {
      setPermissionRequestHandler: h => (onRequest = h),
      setPermissionCheckHandler: h => (onCheck = h),
      request: (permission, details = {}) => new Promise(resolve => onRequest!({}, permission, resolve, details)),
      check: permission => onCheck!({}, permission),
    };
  }

  it("asks before a navigation to another app's scheme leaves, which Chromium hands over as openExternal", async () => {
    const shell = fakeShell(false);
    const session = fakeSession();
    guardGuestSession(session, shell);
    expect(await session.request("openExternal", { externalURL: "slack://open" })).toBe(false);
    expect(shell.asked).toEqual(["slack://open"]);
    const willing = fakeShell(true);
    guardGuestSession(session, willing);
    expect(await session.request("openExternal", { externalURL: "zoommtg://zoom.us/join" })).toBe(true);
  });

  it("grants no camera, microphone, location or notifications", async () => {
    const session = fakeSession();
    guardGuestSession(session, fakeShell());
    for (const permission of ["media", "geolocation", "notifications", "midi", "clipboard-read"]) {
      expect(await session.request(permission), permission).toBe(false);
      expect(session.check(permission), permission).toBe(false);
    }
    expect(await session.request("fullscreen")).toBe(true);
  });
});
