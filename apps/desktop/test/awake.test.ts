// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { awakeWanted } from "../src/awake.js";

const workspaces = [
  { id: "ws_mac", kind: "local" },
  { id: "ws_box", kind: "cloud", place: "pl_box" },
] as unknown as WorkspaceView[];
const row = (over: Partial<SessionView> & Pick<SessionView, "id">): SessionView => ({ workspaceId: "ws_mac", harness: "claude", status: "running", ...over });

describe("whether the computer is kept awake", () => {
  it("while a thread works on one of this computer's own workspaces and the switch is on", () => {
    expect(awakeWanted([row({ id: "s1", threadId: "t1" })], workspaces, true)).toBe(true);
    expect(awakeWanted([row({ id: "s1", threadId: "t1" })], workspaces, false)).toBe(false);
  });

  it("not for a thread on a box, which runs whether this computer sleeps or not", () => {
    expect(awakeWanted([row({ id: "s1", threadId: "t1", workspaceId: "ws_box" })], workspaces, true)).toBe(false);
  });

  it("not for a thread stopped on a prompt, one that finished, or nothing at all", () => {
    expect(awakeWanted([row({ id: "s1", threadId: "t1", asking: "Bash: ls" })], workspaces, true)).toBe(false);
    expect(awakeWanted([row({ id: "s1", threadId: "t1", status: "completed", endedAt: 2 })], workspaces, true)).toBe(false);
    expect(awakeWanted([], workspaces, true)).toBe(false);
  });

  it("reads the thread's latest turn, so a thread that ran once and works again counts once it works", () => {
    const rows = [row({ id: "s1", threadId: "t1", status: "completed", endedAt: 2, startedAt: 1 }), row({ id: "s2", threadId: "t1", startedAt: 3 })];
    expect(awakeWanted(rows, workspaces, true)).toBe(true);
  });
});
