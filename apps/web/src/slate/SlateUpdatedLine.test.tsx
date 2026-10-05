// SPDX-License-Identifier: AGPL-3.0-only
// The timeline's one line: a turn the agent wrote the slate in is marked once, however many writes it made; a
// person's write marks nothing; pressing the line opens the Slate tab.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { deriveSession } from "../adapt/index.js";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { SlateUpdatedLine } from "./SlateUpdatedLine";

afterEach(cleanup);

const scope = { workspaceId: "ws", sessionId: "s1", threadId: "t1" };
const turn = (turnId: string, writes: ("agent" | "person")[]): SessionEvent[] => [
  { type: "session.start", ...scope, turnId, prompt: "go" } as SessionEvent,
  ...writes.map((by, i) => ({ type: "session.slate", ...scope, turnId, cause: "write", version: i + 1, by, pieces: ["root"] }) as SessionEvent),
  { type: "session.done", ...scope, turnId, result: { status: "completed" } } as SessionEvent,
];

describe("the timeline's slate line", () => {
  it("marks a turn the agent wrote the slate in, once, and not one only the person wrote in", () => {
    const model = deriveSession([...turn("a", ["agent", "agent", "agent"]), ...turn("b", ["person"]), ...turn("c", [])]);
    expect(model.turns.map(t => [t.turnId, t.slated === true])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });

  it("opens the Slate tab when pressed", () => {
    useStore.setState({ selectedId: "ws" });
    useRightPanelStore.setState({ byWorkspaceId: {} });
    render(<SlateUpdatedLine />);
    fireEvent.click(screen.getByRole("button", { name: "Updated the slate" }));
    expect(useRightPanelStore.getState().byWorkspaceId["ws"]?.activeSurfaceId).toBe("slate");
  });
});
