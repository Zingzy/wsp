// SPDX-License-Identifier: AGPL-3.0-only
// What one word to wsp add names, what a project is called, where its
// checkout sits inside a workspace of it, and which workspace a folder on
// this computer belongs to: the command line, the runtime and the app all
// read these here.
import { describe, expect, it } from "vitest";
import { addedProjectLine, ADD_FORMS_LINE, computerNamed, folderName, HERE_PLACE_ID, hiddenFolder, isMacMachine, goldenForkName, homeShortened, kindWords, noWorkspaceForFolderLine, NOT_A_REPO_LINE, ProjectGolden, projectNameOf, projectPathOn, projectsInPlace, type ProjectSource, type ProjectView, REGISTERING_LINE, registeredLine, registerTakesNoConsentLine, sameSourceRefusal, sourceKind, threadOpenedLine, workspaceForFolder, type WorkspaceProject, WorkspaceView } from "../src/index.js";

const spoo: WorkspaceProject = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z", size: 1024 };
const wsp: WorkspaceProject = { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" };
const ref = { id: "pr_1a2b3c4d", name: "spoo-landing", path: "/root/spoo-landing", computer: "pl_box" };
const view = { id: "ws_1", name: "b2", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-06T09:00:00.000Z", project: ref };

const folderSource = (path: string): ProjectSource => ({ kind: "folder", path });
const gitSource = (url: string): ProjectSource => ({ kind: "git", url });

const project = (over: Partial<ProjectView>): ProjectView => ({
  id: "pr_1",
  name: "wsp",
  computer: "here",
  source: folderSource("/Users/dev/wsp"),
  path: "/Users/dev/wsp",
  createdAt: "2026-09-17T00:00:00.000Z",
  ...over,
});

describe("what one word to wsp add names", () => {
  it("a login is a computer, a url or a repo path is a repo, a path is a folder, and anything else is refused with the three forms", () => {
    expect(sourceKind("root@spoo")).toBe("computer");
    expect(sourceKind("root@178.156.161.168")).toBe("computer");
    expect(sourceKind("git@github.com:spoo-me/frontend.git")).toBe("git");
    expect(sourceKind("https://github.com/spoo-me/frontend")).toBe("git");
    expect(sourceKind("spoo-me/frontend.git")).toBe("git");
    expect(sourceKind("/Users/dev/wsp")).toBe("folder");
    expect(sourceKind("~/spoo/spoo-landing")).toBe("folder");
    expect(sourceKind("./frontend")).toBe("folder");
    // A path is a path first: a folder somebody called repo.git is theirs on this computer, not a url.
    expect(sourceKind("/Users/me/repo.git")).toBe("folder");
    expect(() => sourceKind("spoo")).toThrow(ADD_FORMS_LINE);
  });

  it("a project is named by its repo's last word without .git, or by the folder's own name", () => {
    expect(projectNameOf(gitSource("https://github.com/spoo-me/frontend.git"))).toBe("frontend");
    expect(projectNameOf(gitSource("https://github.com/spoo-me/frontend"))).toBe("frontend");
    expect(projectNameOf(gitSource("git@github.com:spoo-me/frontend.git"))).toBe("frontend");
    expect(projectNameOf(folderSource("/Users/z/spoo/spoo-landing"))).toBe("spoo-landing");
    expect(projectNameOf(folderSource("/Users/z/spoo/spoo-landing/"))).toBe("spoo-landing");
  });

  it("the checkout sits where the workspace's kind puts it: the folder itself on this computer, the copy's own home on a machine", () => {
    expect(projectPathOn(gitSource("https://github.com/spoo-me/frontend"), "spoo-landing")).toBe("/root/spoo-landing");
    expect(projectPathOn(folderSource("/Users/z/spoo/spoo-landing"), "spoo-landing")).toBe("/Users/z/spoo/spoo-landing");
  });

  it("which sources a computer takes is its kind's own row, so no road decides it for itself", () => {
    expect(kindWords("local").projectSources).toEqual(["folder"]);
    expect(kindWords("cloud").projectSources).toEqual(["git"]);
    expect(kindWords("ssh").projectSources).toEqual([]);
  });

  it("the refusals name the project, the folder and the computer", () => {
    expect(sameSourceRefusal("spoo-landing", "spoo")).toBe("that source is already a project on spoo, spoo-landing; one source on one computer is one project");
    expect(NOT_A_REPO_LINE).toBe("is not a git repo; git init makes it one, or name a repo's url with --on <computer>");
  });
});

describe("the project a workspace holds", () => {
  it("a workspace view carries exactly one project; a view with none, and one still carrying the old list, is not a view", () => {
    expect(WorkspaceView.parse(view)).toEqual(view);
    const { project: _dropped, ...noProject } = view;
    expect(WorkspaceView.safeParse(noProject).success).toBe(false);
    expect(WorkspaceView.safeParse({ ...noProject, projects: [spoo, wsp] }).success).toBe(false);
    // A view that carries both does not carry the list on: one stored home per fact, and the wire says so.
    expect("projects" in WorkspaceView.parse({ ...view, projects: [spoo] })).toBe(false);
  });

  it("a view carries the kind's own folder where the kind names one, the last branch of the rule, so a client shows the folder the runtime will open rather than guessing it", () => {
    expect(WorkspaceView.parse({ ...view, kind: "local", folder: "/Users/dev/wsp-work" })).toEqual({ ...view, kind: "local", folder: "/Users/dev/wsp-work" });
    expect(WorkspaceView.parse(view)).not.toHaveProperty("folder");
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

describe("what a computer is called in a row", () => {
  it("is this computer's own word for the computer the host runs on, and the name this wsp holds for every other", () => {
    const named = new Map([["pl_box", "hetzner"]]);
    expect(computerNamed(HERE_PLACE_ID, named, "darwin")).toBe("this Mac");
    expect(computerNamed(HERE_PLACE_ID, named, "linux")).toBe("this computer");
    expect(computerNamed("pl_box", named)).toBe("hetzner");
    // A caller that could not read the list says the id rather than inventing a name for it.
    expect(computerNamed("pl_box")).toBe("pl_box");
  });

  it("the line a recorded project answers with names the computer the same way, and says the command that makes its workspace", () => {
    const project = { id: "pr_1", name: "spoo-landing", computer: "pl_box", source: { kind: "git" as const, url: "https://github.com/dev/spoo.git" }, path: "/root/spoo-landing", createdAt: "t" };
    expect(addedProjectLine(project, new Map([["pl_box", "hetzner"]]))).toBe(
      'spoo-landing pr_1: https://github.com/dev/spoo.git on hetzner, at /root/spoo-landing inside a workspace of it\nmake one with: wsp new \'spoo-landing\' "<what you are working on>"',
    );
    const here = { ...project, id: "pr_2", name: "wsp", computer: HERE_PLACE_ID, source: { kind: "folder" as const, path: "/Users/dev/wsp" }, path: "/Users/dev/wsp" };
    expect(addedProjectLine(here, new Map(), "darwin")).toContain("on this Mac, at /Users/dev/wsp");
  });
});

describe("getting a project onto a machine", () => {
  it("a register says nothing was copied, and the flags a copy takes have no meaning here", () => {
    expect(REGISTERING_LINE).toBe("already on this computer, registering");
    expect(registeredLine("/Users/dev/wsp")).toBe("wsp registered at /Users/dev/wsp; nothing was copied.");
    expect(registerTakesNoConsentLine(["--keep"])).toBe("--keep has no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(registerTakesNoConsentLine(["keep", "agents"])).toBe("keep, agents have no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(folderName("/Users/dev/wsp/")).toBe("wsp");
    expect(folderName("wsp")).toBe("wsp");
  });

  it("a folder browser hides the machine's own folders: the dot-named ones anywhere, and a Mac home's own Library", () => {
    const mac = { home: "/Users/dev", mac: true };
    // A dot-named folder is the machine's own wherever it sits, and with nothing known about the machine at all.
    expect(hiddenFolder("/Users/dev/.config", mac)).toBe(true);
    expect(hiddenFolder("/root/.wsp-inbox")).toBe(true);
    expect(hiddenFolder("/Users/dev/code", mac)).toBe(false);
    // The Library the Mac keeps in the home itself, which its Finder hides too.
    expect(hiddenFolder("/Users/dev/Library", mac)).toBe(true);
    expect(hiddenFolder("/Users/dev/Library/", mac)).toBe(true);
    // A home is wherever the login puts it, and a lab account's is not /Users/<name>: the home decides, not the
    // path's shape, or every persona home on a Mac gets the junk drawer back.
    expect(hiddenFolder("/Users/Shared/lab/priya/Library", { home: "/Users/Shared/lab/priya", mac: true })).toBe(true);
    expect(hiddenFolder("/var/folders/t/session/Library", { home: "/var/folders/t/session", mac: true })).toBe(true);
    // A Library somebody made inside their own work is theirs, and so is one on a machine that is not a Mac.
    expect(hiddenFolder("/Users/dev/code/app/Library", mac)).toBe(false);
    expect(hiddenFolder("/root/Library", { home: "/root", mac: false })).toBe(false);
    expect(hiddenFolder("/Users/dev/Library", { home: "/Users/dev" })).toBe(false);
    expect(hiddenFolder("/Users/dev/Library")).toBe(false);
  });

  it("a machine says it is a Mac by the name its maker gives it, or by the kernel where it had nothing better", () => {
    expect(isMacMachine("macOS 15.5")).toBe(true);
    expect(isMacMachine("Darwin 25.4.0")).toBe(true);
    expect(isMacMachine("Ubuntu 24.04.1 LTS")).toBe(false);
    expect(isMacMachine("Debian GNU/Linux 12 (bookworm)")).toBe(false);
    // A machine that has answered nothing yet has said nothing to hide.
    expect(isMacMachine(undefined)).toBe(false);
    expect(isMacMachine("")).toBe(false);
  });
});

describe("the workspace a folder on this computer belongs to", () => {
  const here = project({ id: "pr_wsp", name: "wsp", path: "/Users/dev/wsp", source: folderSource("/Users/dev/wsp") });
  const nested = project({ id: "pr_host", name: "host", path: "/Users/dev/wsp/packages/host", source: folderSource("/Users/dev/wsp/packages/host") });
  const cloned = project({ id: "pr_front", name: "frontend", computer: "pl_box", path: "/root/frontend", source: gitSource("https://github.com/spoo-me/frontend") });
  const on = (p: ProjectView, id = `ws_${p.id}`) => ({ id, name: p.name, project: { id: p.id, name: p.name, path: p.path, computer: p.computer } });

  it("a folder under a project worked in place picks that project's workspace, the nearest when projects nest", () => {
    const wspWorkspace = on(here);
    const hostWorkspace = on(nested);
    expect(workspaceForFolder([wspWorkspace], [here], "/Users/dev/wsp")).toEqual({ workspace: wspWorkspace, project: here });
    expect(workspaceForFolder([wspWorkspace], [here], "/Users/dev/wsp/packages/host/src")).toEqual({ workspace: wspWorkspace, project: here });
    expect(workspaceForFolder([wspWorkspace, hostWorkspace], [here, nested], "/Users/dev/wsp/packages/host/src")).toEqual({ workspace: hostWorkspace, project: nested });
  });

  it("a folder no project holds, and a project no workspace stands on, name nothing", () => {
    expect(workspaceForFolder([on(here)], [here], "/Users/dev/elsewhere")).toBeNull();
    expect(workspaceForFolder([], [here], "/Users/dev/wsp")).toBeNull();
    expect(workspaceForFolder([on(here)], [], "/Users/dev/wsp")).toBeNull();
  });

  it("a project a computer cloned is on that computer, not here, so a folder of this name here is not it", () => {
    expect(workspaceForFolder([on(cloned)], [cloned], "/root/frontend")).toBeNull();
    expect(workspaceForFolder([on(cloned)], [cloned], "/Users/dev/frontend")).toBeNull();
  });

  it("the refusal names the folder and the road that records it", () => {
    expect(noWorkspaceForFolderLine("/Users/dev/my repo", "<workspace>")).toBe("no workspace holds a project for /Users/dev/my repo; name one with <workspace>, or wsp add '/Users/dev/my repo' records it as a project here");
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
