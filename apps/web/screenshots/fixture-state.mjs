// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway states a screenshot run and a persona lab serve, one per kind
// of person: what their sidebar holds, whether an image is sealed, and what
// their threads say. The default is what the screenshot run photographs, this
// computer with work on it and two computers of the person's own joined to it,
// its projects recorded on each and the threads with the transcript each
// replays, one of them opened by another thread's agent, so no surface is
// photographed empty and the spawned row's grammar is in a shot; the rest vary
// the setup a tester meets. Nothing here is a real computer, a real key or a
// real folder, and the copies are served by the provider that answers out of
// memory, so no fixture dials anything.
//
// One workspace stands on one machine, and this computer is one machine, so no
// fixture puts two rows on it: a sidebar wsp refuses to make is a sidebar a
// tester judges the product by, and one read three rows here and could not say
// which computer two of them were on.
//
// Every folder a fixture names sits under the home the host serving it runs
// in, and a workspace of the local kind is named the way wsp names one here. A
// tester given somebody else's home and somebody else's threads spent their
// first minute working out whose Mac they were on, and a project folder under
// the person's own home put a tester's turn inside the person's real
// repository.
import { DAEMON_VERSION, HERE_PLACE_ID as HERE, STATE_SHAPE } from "@wsp/protocol";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AT, buildFor, FIXTURE_PULLS, HERE_AGENTS } from "./fixture-kit.mjs";

export { HERE_AGENTS, HERE_HOST_ITEMS, HERE_LABEL, HERE_PROJECT_FILES, sessionId, threadId } from "./fixture-kit.mjs";

/** Every setup a lab can serve, by the word `--fixture` takes. One row per kind of person: what builds its store,
 * the cloud its machines are meant to be at, which the stand-in provider then wears as its own word, and the
 * repositories that person already keeps at the top of their home, which wsp has imported nowhere, and the keys
 * they have saved, which is what the host reads a cloud's key as held off. Without the
 * cloud word every fork in a fixture reads "fake" on the row where a person reads which cloud they are paying;
 * without a repository of their own, a person told to point the app at one of their repositories has none to point
 * it at. Adding a fixture is a file in fixtures/ named for it, whose default export is its row, so two
 * tickets adding a fixture never edit the same file. */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURES = Object.fromEntries(
  await Promise.all(
    readdirSync(FIXTURE_DIR)
      .filter(file => file.endsWith(".mjs"))
      .map(file => file.slice(0, -".mjs".length))
      .sort()
      .map(async name => [name, (await import(pathToFileURL(join(FIXTURE_DIR, `${name}.mjs`)).href)).default]),
  ),
);

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** The project folders a fixture leaves mid-work, a branch one commit ahead of main with three files changed and
 * nothing committed, so the Changes pane and a tile's counts have something to show: empty for every other fixture. */
export function fixtureChanges(name, state) {
  const named = new Set(fixtureRow(name).changes ?? []);
  return Object.values(state.projects ?? {}).flatMap(p => (p.computer === HERE && named.has(p.name) ? [p.path] : []));
}

/** The branch compares a fixture's stand-in gh answers, by repository and head branch: none for every fixture that names none. */
export const fixtureCompares = name => (name === undefined ? {} : (fixtureRow(name).compares ?? {}));

/** The pull requests a fixture's stand-in gh answers for: none for every fixture that names none. */
export const fixturePulls = name => {
  const named = name === undefined ? undefined : fixtureRow(name).pulls;
  return named === undefined ? [] : FIXTURE_PULLS[named];
};

/** The files a fixture's host keeps beside its state file, each a path under that folder: blobs and a daemon's
 * readings. None for a fixture that names none. */
export const fixtureFiles = name => (name === undefined ? [] : (fixtureRow(name).files?.() ?? []));

/** The moment a fixture's page reads as now, a ms epoch, for a fixture whose shots line up with frozen ones by their
 * times: none for every other, whose page reads the real clock. */
export const fixtureClock = name => (name === undefined ? undefined : fixtureRow(name).clock?.());

/** What a fixture's page finds in its local storage before it loads, by key: none for a fixture that names none. */
export const fixtureStorage = name => (name === undefined ? {} : (fixtureRow(name).storage?.() ?? {}));

/** This computer's agents as a fixture's host reads them: every fixture's, unless it names its own. */
export const fixtureAgents = name => (name === undefined ? HERE_AGENTS : (fixtureRow(name).agents?.() ?? HERE_AGENTS));

const fixtureRow = name => {
  const row = FIXTURES[name];
  if (row === undefined) throw new Error(`no fixture is called ${name}; there is ${FIXTURE_NAMES.join(", ")}`);
  return row;
};

/** The whole store one fixture serves, with every folder in it under the home the host will run in: a lab passes
 * its own, so nothing a tester's agent opens is the person's. The default is this computer's home, which is what
 * the screenshot run photographs; a lab that took it would put a tester's turn in the person's own repository. */
export function fixtureState(name = "mac-in-use", { home = homedir() } = {}) {
  buildFor(resolve(home), fixtureRow(name).cloud);
  // A host reads a state file in its own shape alone, so a fixture carries the document this build writes.
  return { ...fixtureRow(name).build(), $shape: { shape: STATE_SHAPE, wsp: "fixture", daemon: DAEMON_VERSION, bin: "fixture-state.mjs", at: new Date(AT).toISOString() } };
}

/** How big every snapshot in a fixture's image reads. Two of them sit inside the stand-in's ten free GB, so the
 * line pricing what an account is storing shows a size and owes nothing. */
const SNAPSHOT_BYTES = Math.round(4.2 * 1024 ** 3);

/** What the provider behind a fixture is already holding: one snapshot per version of every image the fixture says
 * was sealed, in the shape a provider lists them. A stand-in that listed none answered "0 snapshots" on the line
 * that prices an account's storage while the Versions table above it showed two, and a snapshot taken on the same
 * screen did not move it. */
export function fixtureSnapshots(state) {
  return Object.entries(state.goldens ?? {}).flatMap(([golden, manifest]) =>
    manifest.versions.map(v => ({ id: v.snapshotId, name: `wsp-standin-${golden.replace(/[^a-z0-9]+/g, "-")}-v${v.version}`, sizeBytes: SNAPSHOT_BYTES, createdAt: v.createdAt })),
  );
}

/** Whether a fixture's workspace is a fork at the provider the host forks on, which the stand-in answers for; a fork
 * on a joined computer is that computer's, and the stand-in holds nothing of it. */
export const atProvider = w => w.kind === "cloud" && w.place === undefined;

/** The disk every fork in a fixture reads as, the same figure the stand-in gives a machine it mints itself. */
const STANDIN_DISK_GB = 20;

/** Every machine a fixture names, in the state that fixture says it is in, for the stand-in's own records. The
 * state belongs in the records rather than in the machine's id: the stand-in used to read a suffix on the id to
 * know a machine slept, and the id is what `wsp workspaces` prints, so a tester read `fk_slr_2.paused` in the
 * MACHINE column beside a STATE column saying Running. The records file is the one place a fixture and the
 * provider can both read the same fact, and a lab writes it before the host comes up. */
export function fixtureMachines(state) {
  return Object.fromEntries(
    Object.values(state.workspaces ?? {})
      .filter(atProvider)
      .map(w => [
        w.machineId,
        {
          state: w.phase === "napping" ? "paused" : "running",
          shape: { cpu: w.size.cpu, memMb: w.size.memMb, diskGb: STANDIN_DISK_GB, createdAt: w.createdAt },
          labels: {},
        },
      ]),
  );
}

/** Everything the stand-in behind a fixture holds before the host comes up: its machines and its snapshots, in the
 * shape its own records file takes. Both harnesses seed it, so a fork reads the state its fixture gave it whether
 * or not the machines have a folder to run commands in. */
export const fixtureFleet = state => ({ machines: fixtureMachines(state), snapshots: fixtureSnapshots(state) });

/** Every folder a fixture expects to exist on this computer, so whoever serves it can make them: the folder of each
 * project here, which is where a turn on a workspace of it starts. */
export function fixtureFolders(state) {
  return Object.values(state.projects ?? {}).flatMap(p => (p.computer === HERE ? [p.path] : []));
}

/** The repositories a fixture's person already has, as folders under the home the host serving it runs in: work of
 * their own at the top of their home, where a person keeps theirs and where the app's folder picker opens, and
 * never a project any workspace has imported. A tester asked to import one of their own repositories walked up
 * from the work folder, found the app, the bin folder and the work folder, and had nothing to point the app at.
 * Empty for a fixture whose person keeps none. */
export function fixtureRepos(name, { home = homedir() } = {}) {
  return (fixtureRow(name).repos ?? []).map(folder => join(resolve(home), folder));
}

/** The keys a fixture's person has saved, by the variable each is read under: what the host reads as held, never a
 * key any provider takes. The stand-in serves the cloud whatever it holds, so nothing is ever asked with one. */
export function fixtureKeys(name = "mac-in-use") {
  return fixtureRow(name).keys ?? {};
}

/** The cloud a fixture's machines are meant to be at, by the id that provider's own module carries; nothing for a
 * fixture with no cloud machine in it. The host serves every fork through the stand-in whichever this says, and
 * the word only decides what the rows call the place those machines live. */
export function fixtureCloud(name = "mac-in-use") {
  return fixtureRow(name).cloud;
}
