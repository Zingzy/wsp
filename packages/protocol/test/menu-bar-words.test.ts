// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { HERE_PLACE_ID, hereName, needsYouCount, placeName, placeOf, threadFinishedLine, workspaceComputerName, type PlaceView, type SessionView, type WorkspaceView } from "../src/index.js";

const row = (over: Partial<SessionView> & Pick<SessionView, "id">): SessionView => ({ workspaceId: "ws_mac", harness: "claude", status: "running", ...over });

describe("the count of threads waiting on the person, which the dock and the menu bar both read", () => {
  it("counts a thread that asks, one stopped behind one that asks, and a finish no window has shown, once each however many turns it has", () => {
    const sessions = [
      row({ id: "s1", threadId: "t_ask", asking: "Bash: sleep 5" }),
      row({ id: "s2", threadId: "t_work" }),
      row({ id: "s3", threadId: "t_done", status: "completed", endedAt: 20 }),
      row({ id: "s4", threadId: "t_seen", status: "completed", endedAt: 20, readAt: 30 }),
      row({ id: "s5", threadId: "t_done", status: "completed", endedAt: 10, workspaceId: "ws_mac" }),
      row({ id: "s6", threadId: "t_behind", waitingOn: { threadId: "t_ask", prompt: { toolName: "Bash", input: "{}" } } as SessionView["waitingOn"] }),
      row({ id: "s7", threadId: "t_box", workspaceId: "ws_box", asking: "Edit: a.ts" }),
    ];
    expect(needsYouCount(sessions)).toBe(4);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("the computer a workspace runs on, by the name its own row carries", () => {
  const places: PlaceView[] = [
    { id: HERE_PLACE_ID, kind: "computer", name: "zmac", label: "zingzy's MacBook Pro", default: true },
    { id: "pl_box", kind: "computer", name: "spoo", default: false },
    { id: "pl_solari", kind: "provider", name: "solari", default: false },
  ] as PlaceView[];

  it("names a computer by the name its owner gave it, else its own, and a provider by its row in the provider table", () => {
    expect(placeName(places[0]!)).toBe("zingzy's MacBook Pro");
    expect(placeName(places[1]!)).toBe("spoo");
    expect(placeName(places[2]!)).not.toBe("");
    expect(hereName(places)).toBe("zingzy's MacBook Pro");
    expect(hereName([])).toBe("");
  });

  it("puts a workspace on its row, this computer's own included, and falls back to the protocol's word for one no row holds", () => {
    const local = { id: "ws_mac", kind: "local", machineId: "local" } as unknown as WorkspaceView;
    const onBox = { id: "ws_box", kind: "cloud", machineId: "m1", place: "pl_box" } as unknown as WorkspaceView;
    expect(placeOf(places, onBox)?.id).toBe("pl_box");
    expect(workspaceComputerName(places, local)).toBe("zingzy's MacBook Pro");
    expect(workspaceComputerName(places, onBox)).toBe("spoo");
    expect(workspaceComputerName([], onBox)).not.toBe("");
  });
});

describe("the line a finished thread is said in", () => {
  it("names the thread", () => {
    expect(threadFinishedLine("fix the login")).toBe("fix the login finished");
  });
});
