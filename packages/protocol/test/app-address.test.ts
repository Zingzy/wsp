// SPDX-License-Identifier: AGPL-3.0-only
// The address that opens the app on one workspace, on one thread of it, or on
// the screen its next thread is written on: wsp init writes the workspace form
// after its first fork, the app writes the others as the person moves, and the
// app's store reads all three back.
import { describe, expect, it } from "vitest";
import { addressFromHash, addressFromLink, appHash, linkFromHash, linkHash, openingHash, pairingCodeOf, workspaceHash } from "../src/index.js";

describe("the workspace a page opens on", () => {
  it("round-trips an id through the hash", () => {
    expect(workspaceHash("ws_a1b2")).toBe("#w/ws_a1b2");
    expect(appHash({ workspaceId: "ws_a1b2" })).toBe("#w/ws_a1b2");
    expect(addressFromHash(workspaceHash("ws_a1b2"))).toEqual({ workspaceId: "ws_a1b2" });
  });

  it("names no workspace for the app's own hashes, an empty one, or no hash at all", () => {
    expect(addressFromHash("#gallery")).toBeUndefined();
    expect(addressFromHash("")).toBeUndefined();
    expect(addressFromHash("#w/")).toBeUndefined();
  });
});

describe("the thread a page opens on", () => {
  it("round-trips a workspace and a thread, and the workspace reads out of the same hash", () => {
    expect(appHash({ workspaceId: "ws_a1b2", threadId: "thr_9" })).toBe("#w/ws_a1b2/t/thr_9");
    expect(addressFromHash("#w/ws_a1b2/t/thr_9")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9" });
  });

  it("names no thread for a workspace hash, an empty thread, or an unrelated hash", () => {
    expect(addressFromHash("#w/ws_a1b2")?.threadId).toBeUndefined();
    expect(addressFromHash("#w/ws_a1b2/t/")).toEqual({ workspaceId: "ws_a1b2" });
    expect(addressFromHash("#gallery")).toBeUndefined();
  });

  it("escapes what an id carries", () => {
    expect(addressFromHash(appHash({ workspaceId: "ws a", threadId: "t/1" }))).toEqual({ workspaceId: "ws a", threadId: "t/1" });
  });
});

describe("the screen a workspace's next thread is written on", () => {
  it("has an address of its own, which names no thread", () => {
    expect(appHash({ workspaceId: "ws_a1b2", fresh: true })).toBe("#w/ws_a1b2/new");
    expect(addressFromHash("#w/ws_a1b2/new")).toEqual({ workspaceId: "ws_a1b2", fresh: true });
  });

  it("is not read into a workspace whose own id ends that way, and a thread address is never fresh", () => {
    expect(addressFromHash("#w/new")).toEqual({ workspaceId: "new" });
    expect(addressFromHash(appHash({ workspaceId: "ws/new" }))).toEqual({ workspaceId: "ws/new" });
    expect(addressFromHash("#w/ws_a1b2/t/thr_9/new")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9/new" });
  });
});

describe("the code wsp init puts in the address of the page it opens", () => {
  it("rides the end of the hash beside the workspace, and alone when there is no workspace", () => {
    expect(openingHash("7K3MQP2X", "ws_a1b2")).toBe("#w/ws_a1b2/c/7K3MQP2X");
    expect(openingHash("7K3MQP2X")).toBe("#c/7K3MQP2X");
    expect(pairingCodeOf("#w/ws_a1b2/c/7K3MQP2X")).toEqual({ code: "7K3MQP2X", rest: "#w/ws_a1b2" });
    expect(pairingCodeOf("#c/7K3MQP2X")).toEqual({ code: "7K3MQP2X", rest: "" });
  });

  it("is not part of what the address names, so the workspace and the thread read as they would without it", () => {
    expect(addressFromHash("#w/ws_a1b2/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2" });
    expect(addressFromHash("#w/ws_a1b2/t/thr_9/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9" });
    expect(addressFromHash("#w/ws_a1b2/new/c/7K3MQP2X")).toEqual({ workspaceId: "ws_a1b2", fresh: true });
    expect(addressFromHash("#c/7K3MQP2X")).toBeUndefined();
  });

  it("reads no code off a hash carrying none, an empty one, or the app's own hashes", () => {
    expect(pairingCodeOf("#w/ws_a1b2")).toBeUndefined();
    expect(pairingCodeOf("#w/ws_a1b2/c/")).toBeUndefined();
    expect(pairingCodeOf("#c/")).toBeUndefined();
    expect(pairingCodeOf("#gallery")).toBeUndefined();
    expect(pairingCodeOf("")).toBeUndefined();
  });
});

describe("a wsp:// link", () => {
  it("names a thread, a workspace, a project or a Settings page by its id, and carries it to the page as a hash", () => {
    expect(addressFromLink("wsp://thread/th_9f3a")).toEqual({ kind: "thread", id: "th_9f3a" });
    expect(addressFromLink("wsp://workspace/ws_a1b2")).toEqual({ kind: "workspace", id: "ws_a1b2" });
    expect(addressFromLink("wsp://project/pr_77c0")).toEqual({ kind: "project", id: "pr_77c0" });
    expect(addressFromLink("wsp://settings/keybindings")).toEqual({ kind: "settings", id: "keybindings" });
    expect(addressFromLink("wsp://settings/keybindings/")).toEqual({ kind: "settings", id: "keybindings" });
    expect(addressFromLink("WSP://thread/0b6e1c2a-7f1d-4c55-9a9b-3f1f2a6c8d10")).toEqual({ kind: "thread", id: "0b6e1c2a-7f1d-4c55-9a9b-3f1f2a6c8d10" });
    for (const target of [{ kind: "thread", id: "th_9f3a" }, { kind: "settings", id: "keybindings" }] as const) {
      expect(linkFromHash(linkHash(target))).toEqual(target);
    }
    expect(linkHash({ kind: "thread", id: "th_9f3a" })).toBe("#open/thread/th_9f3a");
    // A link's hash is not a workspace address, and a workspace address is not a link.
    expect(addressFromHash(linkHash({ kind: "workspace", id: "ws_a" }))).toBeUndefined();
    expect(linkFromHash(workspaceHash("ws_a"))).toBeUndefined();
  });

  it("names nothing for any other scheme, route or shape: ids alone ride a link, never an act or a query", () => {
    for (const url of [
      "https://thread/th_1",
      "wsp:thread/th_1",
      "wsp://send/th_1",
      "wsp://thread/",
      "wsp://thread",
      "wsp://thread/th_1/extra",
      "wsp://thread/th_1?send=rm%20-rf",
      "wsp://thread/th_1#x",
      "wsp://user:pw@thread/th_1",
      "wsp://thread:9/th_1",
      "wsp://thread/th%201",
      "wsp://thread/..",
      "wsp://thread/%2e%2e",
      "wsp://thread/<script>",
      `wsp://thread/${"a".repeat(129)}`,
      "not a url",
      "",
    ]) {
      expect(addressFromLink(url), url).toBeUndefined();
    }
    expect(linkFromHash("#open/send/th_1")).toBeUndefined();
    expect(linkFromHash("#open/thread/a%20b")).toBeUndefined();
  });
});
