// SPDX-License-Identifier: AGPL-3.0-only
// The address that opens the app on one workspace, or on one thread of it:
// wsp init writes the workspace form after its first fork, a thread row's
// copy-link action writes the thread form, and the app's store reads both.
import { describe, expect, it } from "vitest";
import { threadFromHash, threadHash, workspaceFromHash, workspaceHash } from "../src/index.js";

describe("the workspace a page opens on", () => {
  it("round-trips an id through the hash", () => {
    expect(workspaceHash("ws_a1b2")).toBe("#w/ws_a1b2");
    expect(workspaceFromHash(workspaceHash("ws_a1b2"))).toBe("ws_a1b2");
  });

  it("names no workspace for the app's own hashes, an empty one, or no hash at all", () => {
    expect(workspaceFromHash("#gallery")).toBeUndefined();
    expect(workspaceFromHash("")).toBeUndefined();
    expect(workspaceFromHash("#w/")).toBeUndefined();
  });
});

describe("the thread a page opens on", () => {
  it("round-trips a workspace and a thread, and the workspace reads out of the same hash", () => {
    expect(threadHash("ws_a1b2", "thr_9")).toBe("#w/ws_a1b2/t/thr_9");
    expect(threadFromHash("#w/ws_a1b2/t/thr_9")).toEqual({ workspaceId: "ws_a1b2", threadId: "thr_9" });
    expect(workspaceFromHash("#w/ws_a1b2/t/thr_9")).toBe("ws_a1b2");
  });

  it("names no thread for a workspace hash, an empty thread, or an unrelated hash", () => {
    expect(threadFromHash("#w/ws_a1b2")).toBeUndefined();
    expect(threadFromHash("#w/ws_a1b2/t/")).toBeUndefined();
    expect(threadFromHash("#gallery")).toBeUndefined();
  });

  it("escapes what an id carries", () => {
    expect(threadFromHash(threadHash("ws a", "t/1"))).toEqual({ workspaceId: "ws a", threadId: "t/1" });
  });
});
