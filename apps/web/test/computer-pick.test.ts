// SPDX-License-Identifier: AGPL-3.0-only
import type { PlaceView } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { groupsOn } from "../src/sidebar/computerPick.js";

const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "studio.local", default: false, engine: "none", present: true, takesForks: false },
  { id: "p_spoo", kind: "computer", name: "spoo", default: false, engine: "none", present: true, takesForks: true },
];
const group = (id: string, computer?: string) => ({ project: { id, name: id, ...(computer === undefined ? {} : { computer }) }, workspaces: [] });

describe("the projects a computer pick keeps", () => {
  it("keeps a project recorded against the computer's id or its name, and one with no computer under this one", () => {
    const groups = [group("by-id", "p_spoo"), group("by-name", "spoo"), group("here"), group("elsewhere", "p_other")];
    expect(groupsOn(groups, PLACES, "p_spoo").map(g => g.project.id)).toEqual(["by-id", "by-name"]);
    expect(groupsOn(groups, PLACES, "here").map(g => g.project.id)).toEqual(["here"]);
    expect(groupsOn(groups, PLACES, null)).toBe(groups);
  });
});
