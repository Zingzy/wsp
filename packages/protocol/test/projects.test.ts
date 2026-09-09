// SPDX-License-Identifier: AGPL-3.0-only
// The projects a workspace holds and the one rule for which of them a thread
// starts in: the composer, the command line and the runtime all read it here.
import { describe, expect, it } from "vitest";
import { noProjectLine, projectAt, projectCountCell, projectFor, workspaceProjects, type WorkspaceProject, WorkspaceView } from "../src/index.js";

const spoo: WorkspaceProject = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z", size: 1024 };
const wsp: WorkspaceProject = { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" };
const view = { id: "ws_1", name: "b2", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-06T09:00:00.000Z" };

describe("the projects on a workspace", () => {
  it("a workspace view carries its projects as a list, each with a size when the import measured one; the old single field is not a view", () => {
    expect(WorkspaceView.parse({ ...view, projects: [spoo, wsp] })).toEqual({ ...view, projects: [spoo, wsp] });
    expect(WorkspaceView.parse(view)).toEqual(view);
    expect(WorkspaceView.safeParse({ ...view, projects: [{ name: "proj" }] }).success).toBe(false);
    expect("project" in WorkspaceView.parse({ ...view, project: spoo })).toBe(false);
  });

  it("a view carries the kind's own folder where the kind names one, the last branch of the rule, so a client shows the folder the runtime will open rather than guessing it", () => {
    expect(WorkspaceView.parse({ ...view, kind: "local", folder: "/Users/dev/wsp-work" })).toEqual({ ...view, kind: "local", folder: "/Users/dev/wsp-work" });
    expect(WorkspaceView.parse(view)).not.toHaveProperty("folder");
  });

  it("a view without the list reads as none, so no client guards an absent field", () => {
    expect(workspaceProjects({})).toEqual([]);
    expect(workspaceProjects({ ...view, projects: [spoo] })).toEqual([spoo]);
  });

  it("the default project: the one named, else the last used on the workspace, else the only one, else none", () => {
    expect(projectFor([spoo, wsp], { named: "wsp", last: "spoo" })).toEqual(wsp);
    expect(projectFor([spoo, wsp], { named: undefined, last: "spoo" })).toEqual(spoo);
    expect(projectFor([spoo, wsp], { named: undefined, last: undefined })).toBeNull();
    expect(projectFor([spoo], { named: undefined, last: undefined })).toEqual(spoo);
    expect(projectFor([], { named: undefined, last: undefined })).toBeNull();
    // A remembered pick the workspace no longer holds drops through; a named one that is not there is refused.
    expect(projectFor([spoo, wsp], { named: undefined, last: "gone" })).toBeNull();
    expect(projectFor([spoo], { named: undefined, last: "gone" })).toEqual(spoo);
    expect(() => projectFor([spoo, wsp], { named: "gone", last: undefined })).toThrow(noProjectLine("gone", [spoo, wsp]));
  });

  it("the refusal names the project asked for and the ones the workspace has", () => {
    expect(noProjectLine("gone", [spoo, wsp])).toBe('no project named "gone" on this workspace; its projects are spoo, wsp');
    expect(noProjectLine("gone", [])).toBe('no project named "gone" on this workspace; it has no projects');
  });

  it("the project a folder sits in: the folder itself or one under it, the nearest when projects nest, none outside them all", () => {
    const nested: WorkspaceProject = { name: "host", dest: "/root/wsp/packages/host", importedAt: "2026-09-03T00:00:00Z" };
    expect(projectAt([spoo, wsp], "/root/spoo")).toEqual(spoo);
    expect(projectAt([spoo, wsp], "/root/wsp/packages/host")).toEqual(wsp);
    expect(projectAt([spoo, wsp, nested], "/root/wsp/packages/host/src")).toEqual(nested);
    expect(projectAt([spoo, wsp], "/root/spoo-fork")).toBeNull();
    expect(projectAt([spoo, wsp], undefined)).toBeNull();
    expect(projectAt([], "/root/spoo")).toBeNull();
  });

  it("the count a workspace listing shows: nothing for none, the number otherwise", () => {
    expect(projectCountCell([])).toBe("");
    expect(projectCountCell([spoo])).toBe("1");
    expect(projectCountCell([spoo, wsp])).toBe("2");
  });
});
