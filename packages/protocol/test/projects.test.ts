// SPDX-License-Identifier: AGPL-3.0-only
// The projects a workspace holds and the one rule for which of them a thread
// starts in: the composer, the command line and the runtime all read it here.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, dropTileLine, folderName, goldenForkName, homeShortened, lastTargetLine, noProjectLine, noWorkspaceForFolderLine, projectAt, projectCountCell, projectFor, ProjectGolden, projectsInPlace, REGISTERING_LINE, registeredLine, registerRequest, registerTakesNoConsentLine, THIS_COMPUTER, threadOpenedLine, workspaceForFolder, workspaceProjects, type WorkspaceProject, WorkspaceView } from "../src/index.js";

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

  it("a view carries the machine's home where the kind knows it, so a client shortens a folder under it to ~ the way the machine's own shell would", () => {
    expect(WorkspaceView.parse({ ...view, home: "/root" })).toEqual({ ...view, home: "/root" });
    expect(WorkspaceView.parse(view)).not.toHaveProperty("home");
    expect(homeShortened("/root/spoo", "/root")).toBe("~/spoo");
    expect(homeShortened("/root", "/root")).toBe("~");
    expect(homeShortened("/rooted/spoo", "/root")).toBe("/rooted/spoo");
    expect(homeShortened("/root/spoo", undefined)).toBe("/root/spoo");
  });
});

describe("getting a project onto a workspace", () => {
  it("the drop tile's words follow the kind: a box is imported to by name, this computer registers, a kind with no road has no tile", () => {
    expect(dropTileLine("cloud", "b2")).toBe("import to b2");
    expect(dropTileLine("local", "zingzy-mac")).toBe(`register on ${THIS_COMPUTER}`);
    expect(dropTileLine("ssh", "pi")).toBeNull();
  });

  it("a register asks for the folder at its own path with nothing carried, rewritten or travelling, and the lines say nothing was copied", () => {
    expect(registerRequest("/Users/dev/wsp")).toEqual({ source: "/Users/dev/wsp", dest: "/Users/dev/wsp", carry: [], rewrite: [] });
    expect(REGISTERING_LINE).toBe("already on this computer, registering");
    expect(registeredLine("/Users/dev/wsp")).toBe("wsp registered at /Users/dev/wsp; nothing was copied.");
    expect(registerTakesNoConsentLine(["--keep"])).toBe("--keep has no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(registerTakesNoConsentLine(["keep", "agents"])).toBe("keep, agents have no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(folderName("/Users/dev/wsp/")).toBe("wsp");
    expect(folderName("wsp")).toBe("wsp");
  });

  it("with no --to the import goes to the workspace the last thread started on, and the line says so", () => {
    expect(lastTargetLine("b2")).toBe("importing to b2, the workspace the last thread started on");
  });
});

describe("the workspace a folder on this computer belongs to", () => {
  const b2 = { id: "ws_b2", name: "b2", kind: "cloud" as const, projects: [spoo, wsp] };
  const b3 = { id: "ws_b3", name: "b3", kind: "cloud" as const, projects: [{ ...wsp, importedAt: "2026-09-05T00:00:00Z" }] };
  const mac = { id: "ws_mac", name: "mac", kind: "local" as const, projects: [{ name: "wsp", dest: "/Users/dev/wsp", importedAt: "2026-09-06T00:00:00Z" }] };

  it("a folder registered on this computer matches by its path; a folder imported to a box matches the project of its name on the workspace the last thread on it used, else the last target, else the first that holds it", () => {
    const none = DEFAULT_PREFERENCES;
    expect(workspaceForFolder([b2, b3, mac], "/Users/dev/wsp", none)).toEqual({ workspace: mac, project: mac.projects[0] });
    // A repo of the same name elsewhere on this computer is not the registered one: a path is matched by its path, and
    // only a copy on a box, whose folder here is unknown, is matched by its name.
    expect(workspaceForFolder([mac], "/Users/dev/other/wsp", none)).toBeNull();
    expect(workspaceForFolder([mac, b3], "/Users/dev/other/wsp", none)).toEqual({ workspace: b3, project: b3.projects[0] });
    expect(workspaceForFolder([b2, b3], "/Users/dev/wsp", none)).toEqual({ workspace: b2, project: wsp });
    expect(workspaceForFolder([b2, b3], "/Users/dev/wsp", { ...none, project: { ws_b3: "wsp" } })).toEqual({ workspace: b3, project: b3.projects[0] });
    expect(workspaceForFolder([b2, b3], "/Users/dev/wsp", { ...none, target: { workspace: "ws_b3", project: "wsp" } })).toEqual({ workspace: b3, project: b3.projects[0] });
    // The target wins over a per-workspace memory, since it is the later fact.
    expect(workspaceForFolder([b2, b3], "/Users/dev/wsp", { ...none, project: { ws_b2: "wsp" }, target: { workspace: "ws_b3", project: "wsp" } })).toEqual({ workspace: b3, project: b3.projects[0] });
    // A last thread in another project of that workspace says nothing about this folder.
    expect(workspaceForFolder([b2, b3], "/Users/dev/wsp", { ...none, project: { ws_b3: "other" }, target: { workspace: "ws_b3" } })).toEqual({ workspace: b2, project: wsp });
    expect(workspaceForFolder([b2, b3, mac], "/Users/dev/elsewhere", none)).toBeNull();
    expect(workspaceForFolder([], "/Users/dev/wsp", none)).toBeNull();
  });

  it("a real import lands a box's copy at the folder's own path, and that path decides nothing among boxes: the target and the last project do, and only a copy registered on this computer wins by its path", () => {
    const none = DEFAULT_PREFERENCES;
    const here = { name: "spoo", dest: "/Users/dev/spoo", importedAt: "2026-09-04T00:00:00Z" };
    const c2 = { id: "ws_c2", name: "c2", kind: "cloud" as const, projects: [here] };
    const c3 = { id: "ws_c3", name: "c3", kind: "cloud" as const, projects: [{ ...here, importedAt: "2026-09-05T00:00:00Z" }] };
    const home = { id: "ws_home", name: "home", kind: "local" as const, projects: [{ ...here, importedAt: "2026-09-06T00:00:00Z" }] };
    expect(workspaceForFolder([c2, c3], "/Users/dev/spoo", { ...none, target: { workspace: "ws_c3", project: "spoo" } })).toEqual({ workspace: c3, project: c3.projects[0] });
    expect(workspaceForFolder([c2, c3], "/Users/dev/spoo", { ...none, project: { ws_c3: "spoo" } })).toEqual({ workspace: c3, project: c3.projects[0] });
    expect(workspaceForFolder([c2, c3], "/Users/dev/spoo", none)).toEqual({ workspace: c2, project: here });
    // The folder is that project on this computer, whatever ran last elsewhere.
    expect(workspaceForFolder([c2, home], "/Users/dev/spoo", { ...none, target: { workspace: "ws_c2", project: "spoo" } })).toEqual({ workspace: home, project: home.projects[0] });
  });

  it("the refusal names the folder and the road that lands it", () => {
    expect(noWorkspaceForFolderLine("/Users/dev/my repo", "--in <workspace>")).toBe("no workspace holds a project for /Users/dev/my repo; name one with --in <workspace>, or wsp import '/Users/dev/my repo' --to <workspace> lands it there");
    // The tool has no flag to pass, so its refusal names its own word.
    expect(noWorkspaceForFolderLine("/Users/dev/spoo", "workspace")).toContain("name one with workspace,");
  });

  it("the first line of a thread opened from inside a repo names the workspace and the folder", () => {
    expect(threadOpenedLine("1a2b3c4d", "b2", "~/spoo")).toBe("thread 1a2b3c4d on b2 in ~/spoo");
  });
});

describe("a project golden's manifest", () => {
  it("lists every project the snapshot carries, so a fork is told what it gets; a manifest with one project under the old field is not a golden", () => {
    const golden = { snapshotId: "snap_p", projects: [spoo, wsp], golden: "snap_g", version: 3, workspaceId: "ws_1", workspaceName: "b2", createdAt: "2026-09-06T09:00:00.000Z" };
    expect(ProjectGolden.parse(golden)).toEqual(golden);
    expect(ProjectGolden.safeParse({ ...golden, projects: undefined, project: spoo }).success).toBe(false);
    expect(projectsInPlace([spoo, wsp])).toBe(" with spoo, wsp in place");
    expect(projectsInPlace([])).toBe("");
    // A fork of the golden goes by the newest project it carries, the name new --from takes for it.
    expect(goldenForkName(golden)).toBe("wsp");
    expect(goldenForkName({ ...golden, projects: [] })).toBe("snap_p");
  });
});
