// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  PLACE_LINK_NONCE_BYTES,
  PlaceAuthRequest,
  PlaceJoinRequest,
  WORKSPACE_KIND_WORDS,
  deleteNotice,
  placeDaemonPaths,
  placeLinkTranscript,
  sshDaemonPaths,
  workFolderIn,
} from "../src/index.js";

const nonce = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 7).toString("base64");
const publicKey = Buffer.alloc(44, 3).toString("base64");

const report = {
  name: "old-macbook",
  platform: "darwin" as const,
  arch: "arm64",
  os: "Darwin 24.5.0",
  shape: { cpu: 4, memMb: 8192 },
  login: { HOME: "/Users/maya", USER: "maya", PATH: "/usr/bin" },
  docker: false,
  daemonVersion: 17,
  wsp: ["/usr/local/bin/wsp"],
  dialed: "http://192.168.1.20:4400",
};

describe("what a joining computer may send", () => {
  it("takes a whole join frame", () => {
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "7QK3M2VD", publicKey, nonce, report }).success).toBe(true);
  });

  it("refuses a nonce that is not the length a challenge is: a short one is a nonce somebody could have seen before", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "X", publicKey, nonce: short, report }).success).toBe(false);
  });

  it("refuses a key that is not an ed25519 public key's length", () => {
    const wrong = Buffer.alloc(32, 3).toString("base64");
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "X", publicKey: wrong, nonce, report }).success).toBe(false);
  });

  it("refuses a code longer than any this host mints", () => {
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "x".repeat(65), publicKey, nonce, report }).success).toBe(false);
  });

  it("refuses a report whose login is not string to string: every value there lands in a path a turn runs under", () => {
    const bad = { ...report, login: { HOME: 3 } };
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "X", publicKey, nonce, report: bad }).success).toBe(false);
  });

  it("refuses a report that dialed something other than an http address", () => {
    const bad = { ...report, dialed: "ftp://192.168.1.20" };
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "X", publicKey, nonce, report: bad }).success).toBe(false);
  });

  it("takes an auth frame from a place that already joined", () => {
    expect(PlaceAuthRequest.safeParse({ id: 1, op: "place.auth", placeId: "p_ab12cd34", nonce }).success).toBe(true);
  });
});

describe("the bytes both sides of a link sign", () => {
  const a = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 1).toString("base64");
  const b = Buffer.alloc(PLACE_LINK_NONCE_BYTES, 2).toString("base64");
  const bytes = (v: Uint8Array): string => Buffer.from(v).toString("hex");

  it("differs by the role, so neither side's signature can be replayed back at it as the other's", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b))).not.toBe(bytes(placeLinkTranscript("place", "p_1", a, b)));
  });

  it("differs by the order of the two nonces, so a transcript is one direction of one link", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b))).not.toBe(bytes(placeLinkTranscript("host", "p_1", b, a)));
  });

  it("differs by the place, so a signature for one place proves nothing about another", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b))).not.toBe(bytes(placeLinkTranscript("host", "p_2", a, b)));
  });

  it("is the same bytes for the same reading, so the two sides cannot drift", () => {
    expect(bytes(placeLinkTranscript("host", "p_1", a, b))).toBe(bytes(placeLinkTranscript("host", "p_1", a, b)));
  });
});

describe("the words a place's workspace carries", () => {
  const words = WORKSPACE_KIND_WORDS.place;

  it("is a machine wsp neither forks nor pays for, whose agents drive nothing, and whose folders land under its own home", () => {
    expect(words.driven).toBe(false);
    expect(words.agents).toBe(false);
    expect(words.importsAt).toBe("under home");
    expect(words.imports).toBe("copies");
    expect(words.daemon).toBe(true);
  });

  it("says the computer stays joined when a workspace on it is deleted, since wsp remove is what takes the agent off", () => {
    expect(deleteNotice(0, "place")).toContain("computer stays joined to this wsp");
    expect(deleteNotice(0, "place")).toContain("wsp remove");
  });
});

describe("where a daemon on somebody's own computer keeps things", () => {
  it("is one function under two names, so the ssh road and the place road cannot put a token in two folders", () => {
    expect(placeDaemonPaths).toBe(sshDaemonPaths);
  });

  it("names the work folder by the one rule this computer's own workspace reads", () => {
    expect(workFolderIn("/Users/maya/")).toBe("/Users/maya/wsp-work");
    expect(placeDaemonPaths("/Users/maya").tokenPath).toBe("/Users/maya/.wsp/daemon-token");
  });
});
