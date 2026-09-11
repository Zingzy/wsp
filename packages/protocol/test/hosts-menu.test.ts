// SPDX-License-Identifier: AGPL-3.0-only
// The Hosts menu as both halves of the desktop draw it from one list: the
// app's own computer first, every saved host with the current one marked, the
// connect row, and the disconnect row for the host the window is on.
import { describe, expect, it } from "vitest";
import { HOST_WORDS, hereWord, hostMenuAction, hostsMenuItems, shellVersionNotice, type HostsView } from "../src/index.js";

const VIEW: HostsView = {
  here: "This Mac",
  current: "box",
  hosts: [
    { alias: "attic", label: "attic.example", url: "https://attic.example", road: "direct" },
    { alias: "box", label: "maya@box", url: "http://127.0.0.1:52001", road: "ssh" },
  ],
};

describe("hostsMenuItems", () => {
  it("puts this computer first, marks the current host alone, and offers connect and a disconnect of the current one", () => {
    const rows = hostsMenuItems(VIEW);
    expect(rows.map(r => [r.label, r.checked ?? null, r.enabled])).toEqual([
      ["This Mac", false, true],
      ["attic.example", false, true],
      ["maya@box", true, true],
      [HOST_WORDS.connectMenu, null, true],
      ["Disconnect maya@box", null, true],
    ]);
    // Three groups: the hosts, the connect row and the disconnect row part with separators.
    expect(new Set(rows.map(r => r.group)).size).toBe(3);
    expect(rows.at(-1)?.destructive).toBe(true);
  });

  it("on this computer the disconnect row stands dimmed with why, and this computer is the one marked", () => {
    const rows = hostsMenuItems({ ...VIEW, current: null });
    expect(rows[0]).toMatchObject({ checked: true });
    expect(rows.filter(r => r.checked === true)).toHaveLength(1);
    const forget = rows.at(-1)!;
    expect(forget.enabled).toBe(false);
    expect(forget.refusal).toBe(HOST_WORDS.hereStays("This Mac"));
  });

  it("names each row's action back from its id, and nothing for an id it never minted", () => {
    const rows = hostsMenuItems(VIEW);
    expect(rows.map(r => hostMenuAction(r.id))).toEqual([
      { kind: "switch", alias: null },
      { kind: "switch", alias: "attic" },
      { kind: "switch", alias: "box" },
      { kind: "connect" },
      { kind: "disconnect", alias: "box" },
    ]);
    expect(hostMenuAction("open-terminal")).toBeUndefined();
    expect(hostMenuAction("disconnect:")).toBeUndefined();
  });
});

describe("hereWord", () => {
  it("says This Mac on a Mac and this computer anywhere else", () => {
    expect(hereWord(true)).toBe("This Mac");
    expect(hereWord(false)).toBe("This computer");
  });
});

describe("the version notice across hosts", () => {
  it("names the host by its label when the window is on one somewhere else, and as today on this computer", () => {
    expect(shellVersionNotice("0.2.0", "0.3.0", "maya@box")?.line).toBe("this app is 0.2.0, the host maya@box is 0.3.0: get the new app");
    expect(shellVersionNotice("0.3.0", "0.2.0", "maya@box")?.line).toBe("this app is 0.3.0, the host maya@box is 0.2.0: run the app's own host");
    expect(shellVersionNotice("0.2.0", "0.3.0")?.line).toBe("this app is 0.2.0, the host is 0.3.0: get the new app");
    expect(shellVersionNotice("0.2.0", "0.2.0", "maya@box")).toBeUndefined();
  });
});
