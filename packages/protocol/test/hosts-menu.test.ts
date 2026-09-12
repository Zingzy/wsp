// SPDX-License-Identifier: AGPL-3.0-only
// The Hosts menu as both halves of the desktop draw it from one list: the
// app's own computer first, every saved host with the current one marked, the
// connect row, and the disconnect row for the host the window is on.
import { describe, expect, it } from "vitest";
import { HOST_WORDS, absentComputer, awayMsOf, hereWord, hostMenuAction, hostsMenuItems, placeWorkspacesCell, shellVersionNotice, type HostsView, type PlaceView } from "../src/index.js";

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

describe("the two rows a computer that joined another wsp adds", () => {
  const joined: HostsView = { ...VIEW, place: { hostName: "zingzy-mbp", awake: true } };

  it("appends the awake row checked from the standing and the leave row as a destructive one", () => {
    const rows = hostsMenuItems(joined);
    expect(rows.slice(-2).map(r => [r.label, r.checked ?? null, r.destructive ?? false])).toEqual([
      [HOST_WORDS.place.awakeRow, true, false],
      ["Leave zingzy-mbp's wsp", null, true],
    ]);
  });

  it("carries on the awake row what the hold does not reach, so the row says it on hover", () => {
    const awake = hostsMenuItems(joined).at(-2)!;
    // A hold that lasts while the lid is open and the power is in is not what the label says, and the row can run,
    // so the words ride the hover slot a dimmed row would carry its reason in.
    expect(awake.hint).toBe(HOST_WORDS.place.awakeWhy);
    expect(awake.refusal).toBeUndefined();
    expect(hostsMenuItems(joined).at(-1)!.hint).toBeUndefined();
  });

  it("reads both rows back, and the awake row asks for the state it is not in", () => {
    const held = hostsMenuItems(joined).slice(-2);
    expect(held.map(r => hostMenuAction(r.id))).toEqual([{ kind: "awake", on: false }, { kind: "leave" }]);
    const loose = hostsMenuItems({ ...VIEW, place: { hostName: "zingzy-mbp", awake: false } }).slice(-2);
    expect(hostMenuAction(loose[0]!.id)).toEqual({ kind: "awake", on: true });
    expect(loose[0]!.checked).toBe(false);
  });

  it("leaves the list of a computer that joined nothing exactly as it was", () => {
    expect(hostsMenuItems({ ...VIEW })).toEqual(hostsMenuItems(VIEW));
    expect(hostsMenuItems(VIEW)).toHaveLength(5);
  });
});

describe("what the Where agents run table says about a computer", () => {
  const view = (over: Partial<PlaceView> = {}): PlaceView => ({ id: "p_1", kind: "computer", name: "old-macbook", default: false, present: true, docker: true, takesForks: true, workspaceId: "ws_1", ...over });
  const now = Date.parse("2026-09-12T12:00:00.000Z");

  it("holds one word for the silence in the table's own slot, and dates it only where there is room", () => {
    const reading = (over: Partial<PlaceView>) => absentComputer("old-macbook", awayMsOf(view(over), now));
    // The slot stands beside three fact columns, so it takes the word alone; the figure is on the row's title,
    // in the detail's Answered row, and on the sidebar row's third line, which has room for it.
    for (const over of [{ lastSeenAt: "2026-09-12T10:00:00.000Z" }, { lastSeenAt: "2026-09-12T11:48:00.000Z" }, {}]) {
      expect(reading(over).away).toBe("no answer");
    }
    expect(reading({ lastSeenAt: "2026-09-12T10:00:00.000Z" }).line).toBe("no answer 2 h · is it on?");
    expect(reading({ lastSeenAt: "2026-09-12T11:48:00.000Z" }).line).toBe("no answer 12 min · is it on?");
    expect(reading({}).line).toBe("no answer · is it on?");
  });

  it("says the count it is given and names the one thing that changes what may go there, never a second word for the silence", () => {
    expect(placeWorkspacesCell(view(), 1)).toBe("1");
    expect(placeWorkspacesCell(view({ docker: false }), 1)).toBe("1 · agents only");
    expect(placeWorkspacesCell(view({ present: false }), 1)).toBe("1");
    expect(placeWorkspacesCell(view({ present: false, docker: false }), 1)).toBe("1 · agents only");
    expect(placeWorkspacesCell(view({ docker: false }), 0)).toBe("0 · agents only");
  });

  it("reads the count off the list it is handed, never off the workspace a join recorded on the row", () => {
    // This computer's own workspace and a provider's forks are on no row, so a cell read off the row said 0 for
    // both: the count is the caller's and the row only says what kind of place it is about.
    expect(placeWorkspacesCell({ id: "here", kind: "computer", name: "here", default: true, docker: true }, 1)).toBe("1");
    expect(placeWorkspacesCell({ id: "box", kind: "provider", name: "box", default: false }, 2)).toBe("2");
    expect(placeWorkspacesCell(view({ workspaceId: undefined }), 1)).toBe("1");
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
