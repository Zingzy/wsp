// SPDX-License-Identifier: AGPL-3.0-only
// This computer's folders as a browser tab's picker walks them: folders only,
// sorted, repositories marked, the dot-named ones counted rather than listed
// until they are asked for, the roots being the home folder and each imported
// project's own folder, and every path outside those roots refused, by a typed
// path or by a symlink that leaves them.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { hostFolderRoots, hostFolders, importedProjectFolders, listHostFolders } from "../src/host-folders.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A home folder with a repository, a plain folder and two dot-named ones inside it, a project folder outside home,
 * and a folder on this disk that no root holds. */
function tree(): { home: string; project: string; elsewhere: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-folders-"));
  dirs.push(root);
  const home = join(root, "home");
  const project = join(root, "work", "api");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(home, "code", "spoo", ".git"), { recursive: true });
  mkdirSync(join(home, "code", "notes"), { recursive: true });
  mkdirSync(join(home, "code", ".cache"), { recursive: true });
  mkdirSync(join(home, "code", ".config"), { recursive: true });
  mkdirSync(join(home, "Applications"), { recursive: true });
  writeFileSync(join(home, "code", "README.md"), "read me\n");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(elsewhere, "secrets"), { recursive: true });
  return { home, project, elsewhere };
}

const names = (folders: readonly { path: string }[]): string[] => folders.map(f => f.path.slice(f.path.lastIndexOf("/") + 1));
const workspace = (over: Partial<WorkspaceView>): WorkspaceView => ({
  id: "ws_a",
  name: "api",
  machineId: "m_a",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-06T10:00:00Z",
  ...over,
});

describe("this computer's folder listing", () => {
  it("lists folders only, sorted, marks the repository, and counts the hidden ones without listing them", () => {
    const { home } = tree();
    const listing = listHostFolders({ dir: join(home, "code") }, { home });
    expect(listing.dir).toBe(join(home, "code"));
    expect(names(listing.folders)).toEqual(["notes", "spoo"]);
    expect(listing.folders.map(f => f.repo)).toEqual([false, true]);
    expect(listing.folders.map(f => f.path)).toEqual([join(home, "code", "notes"), join(home, "code", "spoo")]);
    expect(listing.hidden).toBe(2);
  });

  it("lists the dot-named folders too when they are asked for, and still says how many of the level they are", () => {
    const { home } = tree();
    const listing = listHostFolders({ dir: join(home, "code"), hidden: true }, { home });
    expect(names(listing.folders)).toEqual([".cache", ".config", "notes", "spoo"]);
    expect(listing.hidden).toBe(2);
  });

  it("browses from the home folder and every imported project folder, and starts at home when nothing was asked for", () => {
    const { home, project } = tree();
    expect(hostFolderRoots({ home, projects: [project] })).toEqual([home, project]);
    const listing = listHostFolders({}, { home, projects: [project] });
    expect(listing.dir).toBe(home);
    expect(listing.roots).toEqual([home, project]);
    expect(names(listing.folders)).toEqual(["Applications", "code"]);
    expect(names(listHostFolders({ dir: project }, { home, projects: [project] }).folders)).toEqual(["src"]);
  });

  it("keeps out a project folder the home folder already holds, one that is gone, and a second copy of the same one", () => {
    const { home, project } = tree();
    const inside = join(home, "code", "spoo");
    expect(hostFolderRoots({ home, projects: [inside, project, project, join(project, "gone")] })).toEqual([home, project]);
  });

  it("refuses a path outside the roots, before anything under it is read, and a relative one", () => {
    const { home, project, elsewhere } = tree();
    const paths = { home, projects: [project] };
    const refusal = `${elsewhere} is outside the folders wsp browses on this computer: ${home}, ${project}`;
    expect(() => listHostFolders({ dir: elsewhere }, paths)).toThrow(refusal);
    expect(() => listHostFolders({ dir: join(elsewhere, "secrets") }, paths)).toThrow("is outside the folders wsp browses");
    expect(() => listHostFolders({ dir: `${home}/code/../../elsewhere` }, paths)).toThrow("is outside the folders wsp browses");
    expect(() => listHostFolders({ dir: "code/spoo" }, paths)).toThrow("is outside the folders wsp browses");
    // The project folder alone is no longer a root once no record names it.
    expect(() => listHostFolders({ dir: project }, { home })).toThrow("is outside the folders wsp browses");
  });

  it("refuses a symlink inside the roots that points out of them, and leaves it out of the level it sits in", () => {
    const { home, elsewhere } = tree();
    const out = join(home, "code", "out");
    symlinkSync(elsewhere, out);
    expect(names(listHostFolders({ dir: join(home, "code") }, { home }).folders)).toEqual(["notes", "spoo"]);
    expect(() => listHostFolders({ dir: out }, { home })).toThrow("is outside the folders wsp browses");
  });

  it("follows a symlink to a folder the roots hold, and leaves a symlink to a file out", () => {
    const { home } = tree();
    symlinkSync(join(home, "code", "spoo"), join(home, "code", "current"));
    symlinkSync(join(home, "code", "README.md"), join(home, "code", "readme-link"));
    expect(names(listHostFolders({ dir: join(home, "code") }, { home }).folders)).toEqual(["current", "notes", "spoo"]);
  });

  it("falls back to the first root for a folder inside the roots that is gone or is a file", () => {
    const { home } = tree();
    for (const dir of [join(home, "code", "moved-away"), join(home, "code", "README.md")]) {
      expect(listHostFolders({ dir }, { home }).dir).toBe(home);
    }
  });

  it("reads the project folders off the records, each once, and answers a listing over them", async () => {
    const { project } = tree();
    const records = [workspace({ project: { name: "api", dest: project, importedAt: "2026-09-06T10:00:00Z" } }), workspace({ id: "ws_b", project: { name: "api", dest: project, importedAt: "2026-09-06T11:00:00Z" } }), workspace({ id: "ws_c" })];
    expect(importedProjectFolders(records)).toEqual([project]);
    expect(importedProjectFolders([])).toEqual([]);
    const folders = hostFolders(async () => records);
    // hostFolders reads this computer's own home folder, which the paths argument is not given for.
    expect((await folders.list({ dir: project })).roots).toEqual([...hostFolderRoots(), project]);
  });
});
