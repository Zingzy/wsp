// SPDX-License-Identifier: AGPL-3.0-only
// A remove of a computer whose runtime folder stood before the add, with the leave that computer runs answering for
// real: the host reads the checkouts its records name before anything goes, the leave takes them and keeps a
// repository of the person's own beside them, and the computer's record goes only after the leave has run.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import { PLACE_FOUND_END, placeDaemonPaths, type ProjectView } from "@wsp/protocol";
import { ctx, sockets, serving, code, join, placesOf, forks, HOLDS_PROJECTS, type ForkingPlace } from "../../runtime/test/places-fixture.js";
import { report } from "../../runtime/test/place-join.js";
import { projectOn } from "../../runtime/test/stub-backend.js";
import { placeFilePath, placeKeyPath, writePlaceFile } from "../src/place-report.js";
import { fakeRunner, leaveCommand, tmp } from "./places-fixture.js";
import { captured } from "./verbs-fixture.js";

/** git with no config of this computer's, so a case reads the same everywhere. */
const git = (at: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-C", at, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });

/** A repository with one commit at `at`, pushed to a bare origin beside it where `pushed`. */
function repo(at: string, pushed: boolean): void {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q");
  writeFileSync(joinPath(at, "notes.md"), "one\n");
  git(at, "add", "notes.md");
  git(at, "commit", "-qm", "one");
  if (!pushed) return;
  const origin = `${at}.origin.git`;
  execFileSync("git", ["clone", "-q", "--bare", at, origin]);
  git(at, "remote", "add", "origin", origin);
  git(at, "fetch", "-q", "origin");
}

describe.runIf(process.platform === "linux")("removing a computer whose runtime folder stood before the add, its own leave answering", () => {
  it("takes the clean checkouts the host's records name, keeps the person's repository there, and forgets the computer only after", async () => {
    const home = tmp("remove-leave-stood");
    const runtime = joinPath(home, "system", "wsp");
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "srv", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const found = placeDaemonPaths(home).placeFound;
    mkdirSync(dirname(found), { recursive: true });
    writeFileSync(found, `${runtime}\0${PLACE_FOUND_END}\0`);
    repo(joinPath(runtime, "projects", "myrepo"), false);

    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { takesRuntime: false }), answers: c => (place = forks(c, undefined, undefined, HOLDS_PROJECTS)) });
    sockets.push(client.ws);
    // Two projects an older wsp cloned under the runtime's folder, clean and pushed there.
    const older: ProjectView[] = [];
    for (const name of ["acme-lab", "acme-site"]) {
      const made = await projectOn(ctx.runtime!, "srv", `https://github.com/acme/${name}.git`, { name });
      older.push(Object.assign(await ctx.runtime!.projects.resolve(made.id), { checkout: `/wsp/projects/${made.id}/checkout` }));
      repo(joinPath(runtime, "projects", made.id, "checkout"), true);
    }
    // That computer's /wsp is the case's runtime folder: what the host runs there runs here, on these checkouts.
    place.onComputer = cmd => {
      if (!cmd.includes("rev-list")) return { exitCode: 0, stdout: "", stderr: "" };
      const ran = spawnSync("/bin/sh", ["-c", cmd.replaceAll("/wsp/projects/", `${runtime}/projects/`)], { encoding: "utf8" });
      return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    };
    let standingAtLeave: boolean | undefined;
    client.onFrame(raw => {
      const frame = raw as unknown as { id?: number; op?: string; force?: boolean; projects?: string[] };
      if (frame.op !== "place.leave") return;
      void (async () => {
        standingAtLeave = (await placesOf()).some(p => p.id === placeId);
        const io = captured();
        const unsaved = (): string[] => {
          throw new Error("the leave read what the host had already read");
        };
        const flags = { yes: true, ...(frame.force === true ? { force: true } : {}), takes: frame.projects ?? [] };
        try {
          await leaveCommand(io, [], { home, run: fakeRunner().run, platform: "linux", uid: 0, unsaved }, flags);
          client.say({ id: frame.id, ok: true, swept: io.lines });
        } catch (e) {
          client.say({ id: frame.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });

    expect((await ctx.runtime!.places!.holds(placeId)).unsaved).toEqual([]);
    const answer = await ctx.runtime!.places!.remove(placeId);
    expect(answer.removed).toBe(true);
    for (const project of older) expect(existsSync(joinPath(runtime, "projects", project.id))).toBe(false);
    expect(readFileSync(joinPath(runtime, "projects", "myrepo", "notes.md"), "utf8")).toBe("one\n");
    expect(standingAtLeave).toBe(true);
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });
});
