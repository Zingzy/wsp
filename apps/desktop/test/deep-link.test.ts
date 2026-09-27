// SPDX-License-Identifier: AGPL-3.0-only
// A wsp:// link the system hands the shell: held until the window's first page
// and carried there as its hash, sent to a page already up, and never handed
// to a page a host somewhere else serves, whose window is moved home first.
import { describe, expect, it, vi } from "vitest";
import type { LinkTarget } from "@wsp/protocol";
import { deepLinks, linkInArgv } from "../src/deep-link.js";

function shell(page?: { remote: boolean }) {
  const sent: LinkTarget[] = [];
  const moved: string[] = [];
  const raise = vi.fn();
  let current = page;
  const links = deepLinks({
    page: () => current,
    send: target => sent.push(target),
    moveHome: async hash => void moved.push(hash),
    raise,
  });
  return { links, sent, moved, raise, up: (next: { remote: boolean }) => (current = next) };
}

describe("a wsp:// link", () => {
  it("before the window has a page is held, and the first page opens at its hash, once", () => {
    const { links, sent, raise } = shell();
    links.open("wsp://thread/th_9f3a");
    expect(sent).toEqual([]);
    expect(raise).not.toHaveBeenCalled();
    expect(links.take()).toBe("#open/thread/th_9f3a");
    expect(links.take()).toBe("");
  });

  it("the last of several links taken before the page is the one it opens on", () => {
    const { links } = shell();
    links.open("wsp://thread/th_1");
    links.open("wsp://settings/keybindings");
    expect(links.take()).toBe("#open/settings/keybindings");
  });

  it("to a window already up raises it and sends the page what the link names", () => {
    const { links, sent, raise, moved } = shell({ remote: false });
    links.open("wsp://workspace/ws_a1b2");
    expect(raise).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ kind: "workspace", id: "ws_a1b2" }]);
    expect(moved).toEqual([]);
  });

  it("a link that arrived while the first page loaded is sent once it is up", () => {
    const { links, sent, up } = shell();
    expect(links.take()).toBe("");
    links.open("wsp://thread/th_late");
    up({ remote: false });
    links.ready();
    expect(sent).toEqual([{ kind: "thread", id: "th_late" }]);
    links.ready();
    expect(sent).toHaveLength(1);
  });

  it("is never sent to a page a host somewhere else serves: the window goes home at the link's hash", () => {
    const { links, sent, moved } = shell({ remote: true });
    links.open("wsp://thread/th_9f3a");
    expect(sent).toEqual([]);
    expect(moved).toEqual(["#open/thread/th_9f3a"]);
  });

  it("names nothing and moves nothing for a link that is not one of ours", () => {
    const { links, sent, moved, raise } = shell({ remote: false });
    for (const url of ["wsp://send/th_1", "wsp://thread/th_1?text=hi", "https://evil.example/", "wsp://thread/../etc"]) links.open(url);
    expect([sent, moved]).toEqual([[], []]);
    expect(raise).not.toHaveBeenCalled();
  });

  it("finds the link among the arguments a second launch was started with, as Linux and Windows hand it over", () => {
    expect(linkInArgv(["/opt/wsp/wsp", "--no-sandbox", "wsp://thread/th_1"])).toBe("wsp://thread/th_1");
    expect(linkInArgv(["/opt/wsp/wsp", "WSP://settings/about"])).toBe("WSP://settings/about");
    expect(linkInArgv(["/opt/wsp/wsp"])).toBeUndefined();
  });
});
