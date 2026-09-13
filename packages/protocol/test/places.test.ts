// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACE_PORT,
  DEFAULT_PORT,
  DEFAULT_WS_PORT,
  EventUnion,
  GUEST_DAEMON_DIR,
  GUEST_WSP_BIN,
  PLACE_ADD_WORDS,
  PLACE_LINK_NONCE_BYTES,
  PLACE_PORT_OFFSET,
  PlaceAddStep,
  PlaceAuthRequest,
  PlaceJoinReply,
  PlaceJoinRequest,
  PlaceReport,
  joinAddressOf,
  placeAddSheetWord,
  sentPairCode,
  shownPairCode,
  WORKSPACE_KIND_WORDS,
  deleteNotice,
  placeDaemonPaths,
  placeLinkTranscript,
  sshDaemonPaths,
  workFolderIn,
  workspacePlaceId,
  wspBinIn,
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
  agents: [],
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

describe("the steps of an install on a computer over ssh", () => {
  it("has words for every one of them, so a step added is a step a person can read", () => {
    expect(Object.keys(PLACE_ADD_WORDS).sort()).toEqual([...PlaceAddStep.options].sort());
    for (const step of PlaceAddStep.options) expect(PLACE_ADD_WORDS[step].length).toBeGreaterThan(0);
  });

  it("says a step in the app's sheet as that sheet says it, a done one as the state it reached, and takes the terminal's word for the rest", () => {
    expect(placeAddSheetWord("connect", "running")).toBe(PLACE_ADD_WORDS.connect);
    expect(placeAddSheetWord("connect", "done")).toBe(PLACE_ADD_WORDS.connect);
    expect(placeAddSheetWord("wsp", "running")).toBe("installing wsp under ~/.wsp");
    expect(placeAddSheetWord("service", "running")).toBe("starting the agent as a user service");
    expect(placeAddSheetWord("join", "running")).toBe("waiting for it to connect to this Mac");
    // A line under a check reading as the wait it was in is the wrong word for a step that is over.
    expect(placeAddSheetWord("join", "done")).toBe("connected to this Mac");
    // What one line of the sheet's list holds at 12 px mono beside a check: a longer word is cut from the right.
    for (const step of PlaceAddStep.options) for (const state of ["running", "done"] as const) expect(placeAddSheetWord(step, state).length).toBeLessThanOrEqual(51);
  });
});

describe("where a computer joined as a place keeps its own two files", () => {
  it("puts them in the folder the daemon's own files are in, so one sweep takes the lot", () => {
    const at = placeDaemonPaths("/home/maya");
    expect(at.placeFile).toBe("/home/maya/.wsp/place.json");
    expect(at.placeKey).toBe("/home/maya/.wsp/place-key.pem");
    expect(at.placeLog).toBe("/home/maya/.wsp/place.log");
    for (const path of [at.placeFile, at.placeKey, at.placeLog]) expect(path.startsWith(`${at.wsp}/`)).toBe(true);
  });

  it("names the wsp command in a bundle by one rule, which a fork and a joined computer both read", () => {
    expect(wspBinIn(GUEST_DAEMON_DIR)).toBe(GUEST_WSP_BIN);
    expect(wspBinIn("/home/maya/.wsp/daemon")).toBe("/home/maya/.wsp/daemon/wsp/dist/bin.js");
  });
});

describe("the address a person types on the join screen", () => {
  it("makes a bare host and port into the http address the join road dials", () => {
    expect(joinAddressOf("192.168.1.20:4420")).toBe("http://192.168.1.20:4420");
    expect(joinAddressOf("  old-macbook.local:4420 ")).toBe("http://old-macbook.local:4420");
  });

  it("leaves an address that already carries a scheme alone", () => {
    expect(joinAddressOf("https://p_x.singhi.me")).toBe("https://p_x.singhi.me");
    expect(joinAddressOf("http://192.168.1.20:4420")).toBe("http://192.168.1.20:4420");
  });

  it("is nothing for a word that names no port and for a scheme this road cannot dial", () => {
    expect(joinAddressOf("box")).toBeUndefined();
    expect(joinAddressOf("")).toBeUndefined();
    expect(joinAddressOf("ws://x")).toBeUndefined();
  });
});

describe("the port the door for computers you own answers on", () => {
  it("sits the offset above the app port and is not the runtime's own", () => {
    expect(DEFAULT_PLACE_PORT).toBe(DEFAULT_PORT + 20);
    expect(PLACE_PORT_OFFSET).toBe(20);
    expect(DEFAULT_PLACE_PORT).not.toBe(DEFAULT_WS_PORT);
  });
});

describe("what a join carrying the app's own ask may send", () => {
  it("takes a client the window's token is minted for, and refuses one with no name", () => {
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "7QK3M2VD", publicKey, nonce, report, client: { name: "old-macbook" } }).success).toBe(true);
    expect(PlaceJoinRequest.safeParse({ id: 1, op: "place.join", code: "7QK3M2VD", publicKey, nonce, report, client: { name: "" } }).success).toBe(false);
  });

  it("answers the primary computer's name, and a device only with both halves of it", () => {
    const signature = Buffer.alloc(64, 5).toString("base64");
    const base = { placeId: "p_1", hostPublicKey: publicKey, nonce, signature, hostName: "zingzy-mbp" };
    expect(PlaceJoinReply.safeParse(base).success).toBe(true);
    expect(PlaceJoinReply.safeParse({ ...base, hostName: "" }).success).toBe(false);
    expect(PlaceJoinReply.safeParse({ ...base, device: { deviceId: "d_1", deviceToken: "" } }).success).toBe(false);
    expect(PlaceJoinReply.safeParse({ ...base, device: { deviceId: "d_1", deviceToken: "t" } }).success).toBe(true);
  });

  it("takes the agents a computer found on itself, up to the cap the sentence they land in can hold", () => {
    expect(PlaceReport.safeParse({ ...report, agents: ["claude", "codex"] }).success).toBe(true);
    expect(PlaceReport.safeParse({ ...report, agents: Array.from({ length: 33 }, () => "claude") }).success).toBe(false);
  });
});

describe("the four events a computer you own rides the runtime's own stream on", () => {
  const place = { id: "p_1", kind: "computer" as const, name: "old-macbook", default: true };

  it("parses each with the sequence every other event carries", () => {
    expect(EventUnion.safeParse({ type: "place.joined", place, from: "192.168.1.34", seq: 3 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.present", placeId: "p_1", from: "192.168.1.34", seq: 4 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.absent", placeId: "p_1", seq: 5 }).success).toBe(true);
    expect(EventUnion.safeParse({ type: "place.removed", placeId: "p_1", seq: 6 }).success).toBe(true);
  });

  it("refuses a join with no address it came from, since the sheet says where it connected from", () => {
    expect(EventUnion.safeParse({ type: "place.joined", place, seq: 3 }).success).toBe(false);
  });
});

describe("a pairing code as a person reads it and as the host takes it", () => {
  it("shows in two halves and comes back as the letters alone, whichever screen it was copied off", () => {
    expect(shownPairCode("QW4K7PZX")).toBe("QW4K-7PZX");
    expect(shownPairCode("qw4k7pzx")).toBe("QW4K-7PZX");
    expect(shownPairCode("QW4K")).toBe("QW4K");
    expect(sentPairCode("QW4K-7PZX")).toBe("QW4K7PZX");
    expect(sentPairCode("qw4k-7pzx")).toBe("QW4K7PZX");
    expect(sentPairCode(shownPairCode("QW4K7PZX"))).toBe("QW4K7PZX");
  });
});

describe("which row of the places list a workspace stands on", () => {
  const here = { id: "here", kind: "computer" as const };
  const laptop = { id: "p_1", kind: "computer" as const };
  const ascii = { id: "box", kind: "provider" as const };
  const solari = { id: "solari", kind: "provider" as const };
  const places = [here, laptop, ascii, solari];

  it("takes the computer a record names, wherever the name is written", () => {
    expect(workspacePlaceId({ kind: "place", machineId: "place:p_1" }, places)).toBe("p_1");
    expect(workspacePlaceId({ kind: "place", machineId: "m1", place: "p_1" }, places)).toBe("p_1");
  });

  it("puts this computer's own workspace on the first row, which is the computer the host runs on", () => {
    expect(workspacePlaceId({ kind: "local", machineId: "local" }, places)).toBe("here");
  });

  it("puts a fork on the provider its record was stamped with, so two providers in one list do not share a total", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "solari" }, places)).toBe("solari");
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_2", provider: "box" }, places)).toBe("box");
  });

  it("stands a fork written before records carried that word at the first provider, where a host that forks at one put it", () => {
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1" }, places)).toBe("box");
    expect(workspacePlaceId({ machineId: "fk_1" }, places)).toBe("box");
  });

  it("places a fork stamped with a provider this list does not hold nowhere, so a removed provider's spend is on nobody's row", () => {
    // Removing a provider deletes its workspaces where they stand and keeps their series for the month. Falling
    // back to the first provider would add every one of them to the provider that is left.
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "hetzner" }, places)).toBeUndefined();
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1", provider: "solari" }, [here, ascii])).toBeUndefined();
  });

  it("places nothing it cannot: a computer that has been removed, and a fork on a list with no provider at all", () => {
    expect(workspacePlaceId({ kind: "place", machineId: "place:p_gone" }, places)).toBeUndefined();
    expect(workspacePlaceId({ kind: "cloud", machineId: "fk_1" }, [here])).toBeUndefined();
  });
});
