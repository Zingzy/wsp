// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, absentComputer, placeDaemonBehind, type PlaceView, type SealedImageCopy, type WorkspaceView } from "@wsp/protocol";
import { copyOn } from "./image.js";
import { NOTHING_HELD, WHERE_PICK_WORDS, placeIsFull, placeName, placeOf, placeStateWord, placeWorkspaceCounts, removeSentence, removeTitle, whereCaption, whereSegments } from "./places.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const here: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, engine: "none", present: true, takesForks: false };
const hetzner: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "hetzner",
  default: true,
  shape: { cpu: 2, memMb: 4 * 1024 },
  diskFreeBytes: 38 * 1024 ** 3,
  engine: "docker",
  present: true,
  takesForks: true,
  joinedAt: ago(60 * 60 * 1000),
  lastSeenAt: ago(3_000),
};
const laptop: PlaceView = { ...hetzner, id: "p_2", name: "old-macbook", default: false, shape: { cpu: 4, memMb: 8 * 1024 }, diskFreeBytes: 91 * 1024 ** 3, engine: "none", present: false, lastSeenAt: ago(2 * 60 * 60 * 1000) };
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };

describe("what the section computes beyond the table's own cells", () => {
  it("reads a provider row under the name a person knows it by", () => {
    expect(placeName(ascii)).toBe("ASCII");
    expect(placeName(hetzner)).toBe("hetzner");
  });

  it("calls the computer the host runs on by what it is, not by its hostname", () => {
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local" }, true)).toBe("This Mac");
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local" })).toBe("zingzys-macbook-pro.local");
  });
});

describe("the remove sentence", () => {
  it("names what comes off a computer that holds workspaces, and what leaves this Mac", () => {
    expect(removeTitle(hetzner)).toBe("Remove hetzner?");
    expect(removeSentence(hetzner, { workspaces: [{ name: "spoo-fix", state: "Running", threads: 2 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp and its workspace come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The workspace's record and 2 threads leave this Mac.",
    );
  });

  it("says workspaces and records in the plural above one", () => {
    expect(removeSentence(hetzner, { workspaces: [{ name: "a", state: "Running", threads: 2 }, { name: "b", state: "Running", threads: 1 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp and its 2 workspaces come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The workspaces' records and 3 threads leave this Mac.",
    );
  });

  it("drops the second sentence for a computer that holds none", () => {
    expect(removeSentence(hetzner, NOTHING_HELD, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("leaves the size out where nothing has measured the image", () => {
    expect(removeSentence(hetzner, NOTHING_HELD)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image stays where it is.");
  });

  it("says what becomes of the copy of the image, since every computer that joined runs workspaces and holds one", () => {
    // What Remove promises about four gigabytes of somebody's disk is what the sweep does: it walks wsp's own
    // folder and the unit, and never the store the copy sits in, so the copy stays.
    expect(removeSentence(hetzner, NOTHING_HELD, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("says a provider's workspaces are deleted there and its key forgotten here", () => {
    expect(removeSentence(ascii, { workspaces: [{ name: "api", state: "Running", threads: 3 }, { name: "web", state: "Running", threads: 2 }] })).toBe(
      "Its 2 workspaces are deleted at ASCII and the key is forgotten on this Mac. Their records and 5 threads leave this Mac.",
    );
  });

  it("adds when an offline computer is swept", () => {
    expect(removeSentence(laptop, NOTHING_HELD)).toBe(
      "wsp comes off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. It is offline; what is on it is swept the next time it connects.",
    );
  });
});

describe("the rows the New workspace dialog offers, and what each says", () => {
  const copy = (place: string, version: number): SealedImageCopy => ({ place, version, snapshotId: `snap_${place}`, builtAt: ago(60_000) });

  it("offers every computer and provider that takes a workspace, never the computer the app runs on", () => {
    // This computer runs Docker here: it can hold copies of the image, and it is still never somewhere to put
    // another workspace, since its local mode is already the one it can be.
    expect(whereSegments([{ ...here, engine: "docker" }, hetzner, laptop, ascii]).map(p => p.id)).toEqual(["p_1", "p_2", "box"]);
  });

  it("offers nothing at all where this computer is the only row there is", () => {
    expect(whereSegments([{ ...here, engine: "docker" }])).toEqual([]);
  });

  it("says a box costs nothing, how much room it has, and that the image is built there first", () => {
    expect(whereCaption({ ...hetzner, forks: { running: 0, room: 3 } }, undefined)).toBe("free · room for 3 workspaces · builds your image there first, about 4 min");
  });

  it("drops the build clause once a copy stands there, and counts the room that copy left", () => {
    expect(whereCaption({ ...hetzner, forks: { running: 1, room: 2 } }, copy("hetzner", 1))).toBe("free · room for 2 workspaces · your image is there, v1");
  });

  it("says a full computer is full and what to do about it, and holds the pick", () => {
    const full = { ...hetzner, forks: { running: 3, room: 0 } };
    expect(whereCaption(full, copy("hetzner", 1))).toBe("free · 3 of 3 workspaces · pause or delete one there");
    expect(placeIsFull(full)).toBe(true);
    expect(placeIsFull({ ...hetzner, forks: { running: 1, room: 2 } })).toBe(false);
    expect(placeIsFull(hetzner)).toBe(false);
  });

  it("says a provider's rate, that it naps to nothing, and which image is there", () => {
    expect(whereCaption(ascii, copy("box", 1))).toBe("$0.018/hr while awake · naps to $0 · your image is there, v1");
    expect(whereCaption(ascii, undefined)).toBe("$0.018/hr while awake · naps to $0 · builds your image there first, about 4 min");
  });

  it("quotes the rate it is given, which is the picked size's, and the row's own when it is given none", () => {
    expect(whereCaption(ascii, copy("box", 1), 0.08)).toBe("$0.08/hr while awake · naps to $0 · your image is there, v1");
    expect(whereCaption(ascii, copy("box", 1), undefined)).toBe("$0.018/hr while awake · naps to $0 · your image is there, v1");
  });

  it("says why this computer is not a row to pick, and what to do about it", () => {
    expect(WHERE_PICK_WORDS.nowhereYet).toBe("this Mac is already a workspace, the only one it can be");
    expect(WHERE_PICK_WORDS.addOne).toBe("Add a computer you own or connect a provider, and workspaces can be created there.");
  });

  it("reads a copy by the word it names its place with, the id or the name alike", () => {
    expect(copyOn([copy("p_1", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("hetzner", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("old-macbook", 2)], hetzner)).toBeUndefined();
  });
});

describe("which row a workspace stands on", () => {
  const on = (id: string, kind: WorkspaceView["kind"], machineId: string, place?: string): WorkspaceView => ({ id, name: id, kind, machineId, phase: "running", golden: "", createdAt: ago(0), ...(place === undefined ? {} : { place }) });

  it("puts a fork on a joined computer on that computer's row", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_a", "cloud", "ctr_1", "p_1"))?.id).toBe("p_1");
  });

  it("puts what runs here on the first row, and a fork at the provider", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_b", "local", "local"))?.id).toBe("here");
    expect(placeOf([here, hetzner, ascii], on("ws_c", "cloud", "fk_1"))?.id).toBe("box");
  });

  it("places nothing where the list holds no row for it", () => {
    expect(placeOf([here], on("ws_d", "cloud", "fk_1"))).toBeUndefined();
    expect(placeOf([here, ascii], on("ws_e", "cloud", "ctr_1", "p_gone"))).toBeUndefined();
  });

  it("counts what stands on each row off the workspace list: this computer's own, the forks at a provider, the forks on a joined computer", () => {
    const places = [here, hetzner, ascii];
    const workspaces = [on("ws_a", "local", "local"), on("ws_b", "cloud", "fk_1"), on("ws_c", "cloud", "fk_2"), on("ws_d", "cloud", "ctr_1", "p_1")];
    expect(placeWorkspaceCounts(places, workspaces)).toEqual({ here: 1, box: 2, p_1: 1 });
  });

  it("leaves a row nothing stands on out, and counts nothing for a workspace no row holds", () => {
    expect(placeWorkspaceCounts([here, hetzner], [on("ws_a", "local", "local")])).toEqual({ here: 1 });
    expect(placeWorkspaceCounts([here], [on("ws_b", "cloud", "ctr_1", "p_gone")])).toEqual({});
  });
});

describe("the one word the slot beside a row's name carries", () => {
  it("says a computer runs an older daemon than this wsp deploys, in the protocol's own word", () => {
    const behind = { ...hetzner, daemonVersion: DAEMON_VERSION - 5 };
    expect(placeStateWord(behind, null)).toBe(`daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}`);
    // The same word wsp places prints in its BEHIND column, read off the protocol by both.
    expect(placeStateWord(behind, null)).toBe(placeDaemonBehind(behind));
  });

  it("says a computer that is not answering first, since nothing can be put on a computer that is off", () => {
    const away = absentComputer("hetzner", 32 * 60 * 1000);
    expect(placeStateWord({ ...hetzner, daemonVersion: DAEMON_VERSION - 5, present: false }, away)).toBe(away.away);
  });

  it("says nothing of a computer that is answering on this wsp's own daemon, or one that has never reported", () => {
    expect(placeStateWord({ ...hetzner, daemonVersion: DAEMON_VERSION }, null)).toBe("");
    expect(placeStateWord(hetzner, null)).toBe("");
    expect(placeStateWord(ascii, null)).toBe("");
  });
});
