// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { PlaceView } from "@wsp/protocol";
import { hourlyRate, NOTHING_HELD, placeDiskFree, placeSize, placeStateWord, placeWorkspaces, quietFor, removeSentence, removeTitle } from "./places.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const here: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, docker: false, present: true };
const hetzner: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "hetzner",
  default: true,
  shape: { cpu: 2, memMb: 4 * 1024 },
  diskFreeBytes: 38 * 1024 ** 3,
  docker: true,
  present: true,
  joinedAt: ago(60 * 60 * 1000),
  lastSeenAt: ago(3_000),
};
const laptop: PlaceView = { ...hetzner, id: "p_2", name: "old-macbook", default: false, shape: { cpu: 4, memMb: 8 * 1024 }, diskFreeBytes: 91 * 1024 ** 3, docker: false, present: false, lastSeenAt: ago(2 * 60 * 60 * 1000) };
const ascii: PlaceView = { id: "box", kind: "provider", name: "ascii", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018 };

describe("the computers table", () => {
  it("names the four columns' cells for this computer", () => {
    expect(placeSize(here)).toBe("8\u00a0cores\u00a0·\u00a016\u00a0GB");
    expect(placeDiskFree(here)).toBe("210 GB");
    expect(placeWorkspaces(here, { workspaces: [{ name: "api", threads: 2 }] })).toEqual({ figure: "1", note: "agents only" });
  });

  it("quotes a provider from the smallest shape it offers, per workspace", () => {
    expect(placeSize(ascii)).toBe("from 2\u00a0vCPU\u00a0·\u00a04\u00a0GB");
    expect(placeDiskFree(ascii)).toBe("40 GB each");
    expect(placeWorkspaces(ascii, { workspaces: [{ name: "api", threads: 3 }, { name: "web", threads: 2 }] })).toEqual({ figure: "2", note: "$0.018/h" });
  });

  it("puts the default mark in the name's slot and leaves it empty on a row that is neither", () => {
    expect(placeStateWord(hetzner, NOW)).toBe("default");
    expect(placeStateWord(here, NOW)).toBe("");
  });

  it("says how long a computer that stopped answering has been quiet", () => {
    expect(placeStateWord(laptop, NOW)).toBe("offline · 2 h");
    expect(placeWorkspaces(laptop, { workspaces: [{ name: "old", threads: 1 }] })).toEqual({ figure: "1", note: "not answering" });
  });

  it("marks a default computer that is also offline with both words, in that order", () => {
    expect(placeStateWord({ ...laptop, default: true }, NOW)).toBe("default · offline · 2 h");
  });

  it("reads room for more where the host knows it and a tally where it does not", () => {
    expect(placeWorkspaces(hetzner, { workspaces: [{ name: "spoo-fix", threads: 2 }], rooms: 3 })).toEqual({ figure: "1 of 3", note: "" });
    expect(placeWorkspaces(hetzner, { workspaces: [] })).toEqual({ figure: "0", note: "" });
  });

  it("quotes a cheap hourly rate at the precision it is sold at", () => {
    expect(hourlyRate(0.018)).toBe("$0.018/h");
    expect(hourlyRate(0.11)).toBe("$0.11/h");
    expect(hourlyRate(0.5)).toBe("$0.50/h");
  });

  it("reads a quiet stretch in minutes, hours then days", () => {
    expect(quietFor(90_000)).toBe("1 m");
    expect(quietFor(14 * 60_000)).toBe("14 m");
    expect(quietFor(2 * 60 * 60_000)).toBe("2 h");
    expect(quietFor(3 * 24 * 60 * 60_000)).toBe("3 d");
  });
});

describe("the remove sentence", () => {
  it("names what comes off a computer that holds workspaces, and what leaves this Mac", () => {
    expect(removeTitle(hetzner)).toBe("Remove hetzner?");
    expect(removeSentence(hetzner, { workspaces: [{ name: "spoo-fix", threads: 2 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp, your image (4.2 GB) and its workspace come off hetzner, which is otherwise left as it is. The workspace's record and 2 threads leave this Mac.",
    );
  });

  it("says workspaces and records in the plural above one", () => {
    expect(removeSentence(hetzner, { workspaces: [{ name: "a", threads: 2 }, { name: "b", threads: 1 }] }, 4.2 * 1024 ** 3)).toBe(
      "wsp, your image (4.2 GB) and its 2 workspaces come off hetzner, which is otherwise left as it is. The workspaces' records and 3 threads leave this Mac.",
    );
  });

  it("drops the second sentence for a computer that holds none", () => {
    expect(removeSentence(hetzner, NOTHING_HELD, 4.2 * 1024 ** 3)).toBe("wsp and your image (4.2 GB) come off hetzner, which is otherwise left as it is.");
  });

  it("leaves the size out where nothing has measured the image", () => {
    expect(removeSentence(hetzner, NOTHING_HELD)).toBe("wsp and your image come off hetzner, which is otherwise left as it is.");
  });

  it("says a provider's workspaces are deleted there and its key forgotten here", () => {
    expect(removeSentence(ascii, { workspaces: [{ name: "api", threads: 3 }, { name: "web", threads: 2 }] })).toBe(
      "Its 2 workspaces are deleted at ascii and the key is forgotten on this Mac. Their records and 5 threads leave this Mac.",
    );
  });

  it("adds when an offline computer is swept", () => {
    expect(removeSentence(laptop, NOTHING_HELD)).toBe(
      "wsp and your image come off old-macbook, which is otherwise left as it is. It is offline; what is on it is swept the next time it connects.",
    );
  });
});
