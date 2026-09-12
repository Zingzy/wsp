// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { PlaceView } from "@wsp/protocol";
import { NOTHING_HELD, placeName, removeSentence, removeTitle } from "./places.js";

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
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018 };

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
      "wsp, your image (4.2 GB) and its workspace come off hetzner, which is otherwise left as it is. The workspace's record and 2 threads leave this Mac.",
    );
  });

  it("says workspaces and records in the plural above one", () => {
    expect(removeSentence(hetzner, { workspaces: [{ name: "a", state: "Running", threads: 2 }, { name: "b", state: "Running", threads: 1 }] }, 4.2 * 1024 ** 3)).toBe(
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
    expect(removeSentence(ascii, { workspaces: [{ name: "api", state: "Running", threads: 3 }, { name: "web", state: "Running", threads: 2 }] })).toBe(
      "Its 2 workspaces are deleted at ASCII and the key is forgotten on this Mac. Their records and 5 threads leave this Mac.",
    );
  });

  it("adds when an offline computer is swept", () => {
    expect(removeSentence(laptop, NOTHING_HELD)).toBe(
      "wsp and your image come off old-macbook, which is otherwise left as it is. It is offline; what is on it is swept the next time it connects.",
    );
  });
});
