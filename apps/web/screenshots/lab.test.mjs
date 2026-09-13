// SPDX-License-Identifier: AGPL-3.0-only
// What a lab is made of, checked without a host, a build or a browser: the
// fixtures a tester picks between, the provider and the environment each one
// needs, the lines a lab prints, and the rules the driver reads a page with.
import { FAKE_AS_ENV, FAKE_RECORDS_ENV, FAKE_ROOT_ENV, HOST_ASLEEP_SEND, PERSON_HOME_ENV, SEND_BLOCK_WORDS, WEB_DIR_ENV } from "@wsp/protocol";
import { COMPOSER_STATE_WORDS } from "../src/composer-state-words.js";
import { TRANSCRIPT_LOADING } from "../src/transcript-words.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GHOST_IS_NOT_A_CONTROL, OPEN_OVER_THE_PAGE, PRESS_NEEDS_FOCUS, READ_PAGE, SAID_ON_THE_PAGE, SEVERAL_READ, UNDER_AN_OPEN_MENU, attrWord, diffLines, findByWords, findField, openMenu, parseArgs, typedField, whyNotClicked, whyNotOne } from "./drive.mjs";
import { FIXTURE_NAMES, fixtureCloud, fixtureFleet, fixtureFolders, fixtureMachines, fixtureSnapshots, fixtureState, threadId } from "./fixture-state.mjs";
import { DAEMON_BUILD, agentStoreRows, daemonBinaryHere, hostEnv, providerFor, whatIsNotBuilt } from "./host.mjs";
import { AGENT_KEYS, binDir, builtAt, copyApp, folderHash, keysFound, labHome, labLogs, labRoot, shimText, standInRoot, writeAgentHome, writeKeys, writeStandIn, writeWorkFolder } from "./lab-home.mjs";
import { A_MESSAGE, APP_UP, NOT_READY_NAMES, PROMPT_ECHOES, READY_ON_THE_PAGE } from "./ready.mjs";
import { NO_FINDER_CHOOSER, homeOf, keptLog, labLines, labShell, parseArgs as parseLabArgs, pointerPath, stopLab, whyNotOursToRemove } from "./lab.mjs";

describe("the fixtures a lab serves", () => {
  it("has one per kind of person the testers play", () => {
    expect(FIXTURE_NAMES).toEqual(["mac-in-use", "mac-only", "mac-and-laptop", "mac-and-vps", "ascii-only", "solari-only", "both-providers", "no-sign-in", "mac-and-boxes", "orchestrator", "image-built"]);
  });

  it("gives the two personas who have this computer and nothing else an empty window named after it", () => {
    for (const name of ["mac-only", "no-sign-in"]) {
      const state = fixtureState(name);
      const workspaces = Object.values(state.workspaces);
      expect([name, workspaces.map(w => w.name)]).toEqual([name, [hostname()]]);
      // Nothing of anybody else's to read: no thread tagged as theirs, no folder they never imported, no cost.
      expect([name, workspaces[0].projects]).toEqual([name, undefined]);
      expect([name, state.sessions, state.transcripts]).toEqual([name, {}, {}]);
    }
  });

  it("puts every folder a fixture names under the home it is served from, and none of them under the person's", () => {
    // A turn starts in the one project its workspace has, so a project folder under the person's own home is a
    // tester's agent running inside the person's real repository, with their project MCP servers, their
    // instruction file and their files to edit.
    const lab = "/Users/Shared/wsp-lab/priya";
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name, { home: lab });
      const folders = [];
      for (const w of Object.values(state.workspaces)) {
        // A fork's folders are on the machine it runs on, and a computer somebody joined has a home of its own;
        // what a fixture may not do is name a folder of the person's.
        if (w.kind !== "local") continue;
        folders.push(w.home, w.folder);
      }
      folders.push(...fixtureFolders(state), ...Object.values(state.sessions).flatMap(doc => doc.sessions.map(row => row.cwd)));
      for (const folder of folders) {
        expect([name, folder, folder === lab || folder.startsWith(`${lab}/`)]).toEqual([name, folder, true]);
        expect([name, folder, folder.startsWith(`${homedir()}/`)]).toEqual([name, folder, false]);
      }
    }
  });

  it("names every project folder under the work folder, which is where a turn on that workspace starts", () => {
    const lab = "/Users/Shared/wsp-lab/dev";
    const folders = fixtureFolders(fixtureState("mac-in-use", { home: lab }));
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) expect([folder, folder.startsWith(`${lab}/wsp-work/`)]).toEqual([folder, true]);
    // Told no home, a fixture is this computer's own, which is the person's Mac as the screenshot run photographs it.
    expect(fixtureFolders(fixtureState("mac-in-use"))[0].startsWith(`${homedir()}/`)).toBe(true);
  });

  it("builds every one with workspaces the runtime can load", () => {
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name);
      const workspaces = Object.values(state.workspaces);
      expect([name, workspaces.length > 0]).toEqual([name, true]);
      for (const w of workspaces) {
        // The key is the id: the store reads a collection as one document per id, so a row filed under another
        // key would load as a workspace nothing can name.
        expect([name, state.workspaces[w.id]]).toEqual([name, w]);
        expect([name, ["local", "place", "cloud"].includes(w.kind)]).toEqual([name, true]);
        expect([name, typeof w.name, typeof w.machineId, typeof w.phase]).toEqual([name, "string", "string", "string"]);
        // A fork boots from the image the manifest's head names; a local machine forks from nothing.
        if (w.kind === "cloud") expect([name, w.golden]).toEqual([name, state.goldens.default.versions.at(-1).snapshotId]);
        else expect([name, w.golden]).toEqual([name, ""]);
      }
    }
  });

  it("writes a spec on every workspace record, since a wake re-forks and reads the envs off it", () => {
    // Without one the wake's re-fork reads r.spec.envs, raises a TypeError and the app puts it in front of the
    // person as a toast; two testers met it, one on the first verb they typed.
    for (const name of FIXTURE_NAMES) {
      for (const w of Object.values(fixtureState(name).workspaces)) expect([name, w.id, w.spec]).toEqual([name, w.id, {}]);
    }
  });

  it("names no machine with the suffix that tells the stand-in one sleeps, and seeds the state instead", () => {
    for (const name of FIXTURE_NAMES) {
      for (const w of Object.values(fixtureState(name).workspaces)) {
        // The id is what `wsp workspaces` prints in the MACHINE column, and a tester read fk_slr_2.paused there
        // beside a STATE column that said Running.
        expect([name, w.machineId, w.machineId.endsWith(".paused")]).toEqual([name, w.machineId, false]);
      }
    }
    const state = fixtureState("solari-only");
    const machines = fixtureMachines(state);
    const forks = Object.values(state.workspaces).filter(w => w.kind === "cloud");
    expect(forks.length).toBeGreaterThan(0);
    for (const w of forks) {
      expect([w.name, machines[w.machineId].state]).toEqual([w.name, w.phase === "napping" ? "paused" : "running"]);
      expect([w.name, machines[w.machineId].shape.cpu, machines[w.machineId].shape.memMb]).toEqual([w.name, w.size.cpu, w.size.memMb]);
    }
    // A local workspace is this computer and the stand-in holds none of it.
    expect(Object.keys(machines)).toEqual(forks.map(w => w.machineId));
    expect(fixtureFleet(state)).toEqual({ machines, snapshots: fixtureSnapshots(state) });
  });

  it("opens the trial persona's meter at nothing, since they have not pasted a key yet", () => {
    // A sidebar reading $0.48 today on a machine they never made was read as the product billing them for it.
    const points = fixtureState("ascii-only")["cost-histories"]["ws_api"].points;
    expect(points.map(p => [p.awakeMs, p.accruedUsd])).toEqual([[0, 0]]);
  });

  it("gives every thread a transcript and every transcript a thread", () => {
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name);
      expect([name, Object.keys(state.sessions).sort()]).toEqual([name, Object.keys(state.transcripts).sort()]);
      for (const [workspaceId, doc] of Object.entries(state.sessions)) {
        expect([name, doc.workspaceId]).toEqual([name, workspaceId]);
        expect([name, state.workspaces[workspaceId] !== undefined]).toEqual([name, true]);
        for (const row of doc.sessions) expect([name, row.workspaceId]).toEqual([name, workspaceId]);
      }
    }
  });

  it("hangs an orchestrator's spawned threads off the one root, one on each machine the root's reply names", () => {
    const state = fixtureState("orchestrator");
    const spawning = Object.values(state.workspaces).filter(w => w.agents?.spawn === true);
    expect(spawning.map(w => w.name)).toEqual([hostname()]);
    const rows = Object.values(state.sessions).flatMap(d => d.sessions);
    const under = rows.filter(r => r.parentThreadId !== undefined);
    for (const row of under) expect([row.id, row.rootThreadId, row.startedBy]).toEqual([row.id, threadId("migrate"), "agent"]);
    // The root is a thread that is really there, and it is a person's.
    expect(rows.find(r => r.threadId === threadId("migrate"))?.startedBy).toBe("person");
    // Every fork the root made has a thread on it. The reply says a thread stands on each of the three, and a
    // tester who counted the rows and found two read the reply as the product lying to him.
    const forks = Object.values(state.workspaces).filter(w => w.kind === "cloud");
    expect(forks.map(w => w.name).sort()).toEqual(["api", "docs", "web"]);
    for (const fork of forks) expect([fork.name, (state.sessions[fork.id]?.sessions ?? []).length]).toEqual([fork.name, 1]);
  });

  it("gives every seeded session and thread a UUID, since the harness refuses a resume id of any other shape", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name);
      for (const doc of Object.values(state.sessions)) {
        for (const row of doc.sessions) {
          expect([name, row.id, uuid.test(row.id)]).toEqual([name, row.id, true]);
          expect([name, row.threadId, uuid.test(row.threadId)]).toEqual([name, row.threadId, true]);
          expect([name, row.turnId, uuid.test(row.turnId)]).toEqual([name, row.turnId, true]);
        }
      }
      // The transcript's events name the same ids as the rows, so a thread opened from a row replays its own turn.
      for (const [workspaceId, doc] of Object.entries(state.transcripts)) {
        const known = new Set((state.sessions[workspaceId]?.sessions ?? []).map(r => r.threadId));
        for (const e of doc.events) expect([name, e.threadId, known.has(e.threadId)]).toEqual([name, e.threadId, true]);
      }
    }
  });

  it("leaves another person's threads out of every fixture whose persona has run nothing", () => {
    // A tester who has just installed wsp meets no chat about a repository they have never seen, and no cost
    // against their name: five fixtures opened on somebody else's spoo threads and $0.42 of somebody else's money.
    for (const name of ["mac-only", "no-sign-in", "mac-and-laptop", "mac-and-vps", "ascii-only", "solari-only", "both-providers"]) {
      expect([name, fixtureState(name).sessions, fixtureState(name).transcripts]).toEqual([name, {}, {}]);
    }
    // The two that keep threads are the person's own computer with work on it, which is what the screenshot run
    // photographs, and the one whose whole point is a tree of them.
    for (const name of ["mac-in-use", "orchestrator"]) expect([name, Object.keys(fixtureState(name).sessions).length > 0]).toEqual([name, true]);
  });

  it("puts no two workspaces on one machine, since that is a sidebar wsp refuses to make", () => {
    // The runtime refuses a second workspace on a machine that already carries one (`alreadyRecorded`), and this
    // computer is one machine, so four local rows is a state nobody can reach. A tester read three rows and could
    // not say which computer two of them were on.
    for (const name of FIXTURE_NAMES) {
      const machines = Object.values(fixtureState(name).workspaces).map(w => w.machineId);
      expect([name, machines.length]).toEqual([name, new Set(machines).size]);
    }
  });

  it("gives the two personas who joined a second computer one row for this Mac, since one workspace stands on one machine", () => {
    // A tester read "the only one it can be" beside three rows and could not tell which computer two of them were
    // on; both were this Mac, which wsp records as one machine and refuses a second workspace on.
    for (const name of ["mac-and-laptop", "mac-and-vps"]) {
      const local = Object.values(fixtureState(name).workspaces).filter(w => w.kind === "local");
      expect([name, local.map(w => w.name)]).toEqual([name, [hostname()]]);
    }
  });

  it("names a fork's project after the fork, so an image taken on it is not named after a folder nobody imported", () => {
    // The note a snapshot leaves names the projects it holds, so a fork called api holding a project called spoo
    // answered "Image of spoo taken" on a screen headed api, to a persona who had never heard of spoo.
    for (const name of FIXTURE_NAMES) {
      for (const w of Object.values(fixtureState(name).workspaces).filter(w => w.kind === "cloud")) {
        for (const p of w.projects ?? []) expect([name, w.name, p.name]).toEqual([name, w.name, w.name]);
      }
    }
  });

  it("leaves the persona who came to paste a key with nothing awake and nothing spending", () => {
    const state = fixtureState("ascii-only");
    // Two forks awake and $2.44 gone read as money spent on a cloud nobody had given a key to, and the meter
    // moving a cent read as the product contradicting the line beside it that said naps cost nothing.
    const forks = Object.values(state.workspaces);
    expect(forks.map(w => `${w.name} ${w.phase}`)).toEqual(["api napping"]);
    expect(state["cost-histories"]["ws_api"].points.at(-1).rateUsdPerHour).toBe(0);
  });

  it("makes a joined computer a place with its own shape, never a local workspace wearing this Mac's", () => {
    for (const [name, workspaceId, placeId, cores] of [["mac-and-laptop", "ws_laptop", "p_oldlaptop", 4], ["mac-and-vps", "ws_build", "p_vps", 2]]) {
      const state = fixtureState(name);
      const w = state.workspaces[workspaceId];
      expect([name, w.kind, w.machineId]).toEqual([name, "place", `place:${placeId}`]);
      // The shape it reported is its own, not this computer's, and its folders are on it.
      expect([name, state.places[placeId].report.shape.cpu]).toEqual([name, cores]);
      expect([name, w.folder.startsWith(homedir())]).toEqual([name, false]);
    }
    // The server running Docker says so, which is what makes it a place a fork could stand on.
    expect(fixtureState("mac-and-vps").places.p_vps.report.docker).toBe(true);
  });

  it("opens every fork's meter with the hours it has been awake, so a rate has an amount beside it", () => {
    // The trial persona is the one exception, and is checked on its own below: their machine has been awake for
    // no time at all, so their meter opens at nothing.
    for (const name of ["solari-only", "both-providers", "orchestrator"]) {
      const state = fixtureState(name);
      const meters = state["cost-histories"];
      for (const w of Object.values(state.workspaces).filter(w => w.kind === "cloud")) {
        const last = meters[w.id]?.points.at(-1);
        expect([name, w.id, last !== undefined && last.accruedUsd > 0]).toEqual([name, w.id, true]);
        // A machine that is awake is still being charged for; one asleep is not, and both have an amount.
        expect([name, w.id, last.rateUsdPerHour > 0]).toEqual([name, w.id, w.phase === "running"]);
      }
    }
  });

  it("names the cloud each fixture's machines are meant to be at, so no row reads the stand-in's own word", () => {
    expect(Object.fromEntries(FIXTURE_NAMES.map(name => [name, fixtureCloud(name) ?? "no cloud"]))).toEqual({
      "mac-in-use": "no cloud",
      "mac-only": "no cloud",
      "mac-and-laptop": "no cloud",
      "mac-and-vps": "no cloud",
      "ascii-only": "box",
      "solari-only": "solari",
      "both-providers": "solari",
      "no-sign-in": "no cloud",
      "mac-and-boxes": "no cloud",
      orchestrator: "box",
      "image-built": "no cloud",
    });
    // Every fixture with a cloud machine names the cloud it is standing in for, and no fixture without one does.
    for (const name of FIXTURE_NAMES) {
      const forks = Object.values(fixtureState(name).workspaces).some(w => w.kind === "cloud");
      expect([name, fixtureCloud(name) !== undefined]).toEqual([name, forks]);
    }
  });

  it("says which snapshots the provider behind a fixture is already holding, one per version of its image", () => {
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name);
      const versions = Object.values(state.goldens ?? {}).flatMap(m => m.versions);
      const rows = fixtureSnapshots(state);
      expect([name, rows.map(r => r.id).sort()]).toEqual([name, versions.map(v => v.snapshotId).sort()]);
      // A size and a day each, since the line that prices an account's storage reads both off the listing.
      for (const row of rows) expect([name, row.id, row.sizeBytes > 0, typeof row.createdAt]).toEqual([name, row.id, true, "string"]);
    }
  });

  it("names the fixture the screenshot run photographs as its default, and refuses one nobody wrote", () => {
    expect(JSON.stringify(fixtureState())).toBe(JSON.stringify(fixtureState("mac-in-use")));
    expect(() => fixtureState("mac-and-fridge")).toThrow(/no fixture is called mac-and-fridge/);
  });
});


describe("what a lab must find built before it will serve anything", () => {
  const bin = "/repo/packages/wspx/daemon/aarch64-apple-darwin/wsp-daemon";

  it("refuses to start without this computer's daemon binary, and names the command that builds it", async () => {
    // A whole round of nine served hosts whose own daemon never started: no node build makes this binary, so a
    // checkout that has built everything else still has none, and every tester met a computer answering nothing.
    const said = await whatIsNotBuilt({ exists: path => path !== bin, daemon: async () => bin });
    expect(said).toContain(bin);
    expect(said).toContain(DAEMON_BUILD);
    expect(said).toContain("cargo build --release");
  });

  it("says nothing when the app, the command and the daemon are all there", async () => {
    expect(await whatIsNotBuilt({ exists: () => true, daemon: async () => bin })).toBeUndefined();
  });

  it("still names the app and the command first, since the daemon's path is read out of that command's build", async () => {
    const said = await whatIsNotBuilt({ exists: () => false, daemon: async () => bin });
    expect(said).toContain("the web app is not built");
  });

  it("says so plainly on a machine wsp builds no daemon for, where there is nothing to build", async () => {
    expect(await whatIsNotBuilt({ exists: () => true, daemon: async () => undefined })).toContain("builds no daemon for");
  });

  it("reads that path off the built wsp command rather than spelling its target table a second time", async () => {
    const load = async () => ({
      daemonTargetHere: () => ({ triple: "aarch64-apple-darwin" }),
      daemonBinaryIn: (dir, triple) => `${dir}/${triple}/wsp-daemon`,
      workspaceAsset: kind => `/repo/packages/wspx/${kind}`,
    });
    expect(await daemonBinaryHere(load)).toBe(bin);
    expect(await daemonBinaryHere(async () => ({ daemonTargetHere: () => undefined, daemonBinaryIn: () => "", workspaceAsset: () => "" }))).toBeUndefined();
  });
});

describe("the provider a fixture's host runs under", () => {
  it("asks for the one that answers out of memory only where a fixture holds forks or a sealed image", () => {
    const by = Object.fromEntries(FIXTURE_NAMES.map(name => [name, providerFor(fixtureState(name))]));
    expect(by).toEqual({
      "mac-in-use": "none",
      "mac-only": "none",
      "mac-and-laptop": "none",
      "mac-and-vps": "none",
      "ascii-only": "fake",
      "solari-only": "fake",
      "both-providers": "fake",
      "no-sign-in": "none",
      "mac-and-boxes": "fake",
      orchestrator: "fake",
      "image-built": "fake",
    });
  });

  it("reads a sealed image on its own, since a person can hold one with every machine asleep and none recorded", () => {
    expect(providerFor({ workspaces: {}, goldens: { default: { head: 1, versions: [] } } })).toBe("fake");
    expect(providerFor({ workspaces: {} })).toBe("none");
  });
});

describe("what the driver reads and aims at", () => {
  /** A page that reads a word on nothing but its text, as many times as a case says, of which `hidden` are laid
   * nowhere. Every locator answers the filter the driver asks for, and the filters asked are kept, since what a
   * tester can see is the whole question here. */
  const reading = ({ exact = 0, hidden = 0 }) => {
    const filtered = [];
    const guess = count => ({
      count: async () => count,
      first: () => ({}),
      filter(only) {
        filtered.push(only);
        return guess(only?.visible === true ? count - hidden : count);
      },
    });
    return { filtered, getByRole: () => guess(0), getByLabel: () => guess(0), getByPlaceholder: () => guess(0), getByText: (_word, opts) => guess(opts?.exact === true ? exact : 1), locator: () => guess(0) };
  };

  /** What a case put on the document's own prototypes, taken off again whether it passed or not. */
  const undo = [];
  afterEach(() => {
    for (const back of undo.splice(0)) back();
    document.body.innerHTML = "";
  });

  it("says the lines that came and went, and nothing about the ones that stayed", () => {
    expect(diffLines("api\nweb\nnotes", "api\nweb\nnotes")).toEqual([]);
    expect(diffLines("api\nnotes", "api\nweb\nnotes")).toEqual(["+ web"]);
    expect(diffLines("api\nweb\nnotes", "api\nnotes")).toEqual(["- web"]);
    // A page read for the first time is every line new rather than nothing.
    expect(diffLines("", "api\nweb")).toEqual(["+ api", "+ web"]);
  });

  it("names a control that shows no words of its own, so a tester can say what they are pointing at", () => {
    // jsdom lays nothing out and writes no innerText, so the two the reading leans on are answered here: every
    // element is on the screen, and its own words are its text.
    const laid = { configurable: true, value: () => ({ width: 20, height: 20 }) };
    Object.defineProperty(Element.prototype, "getBoundingClientRect", laid);
    Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
    undo.push(() => {
      delete Element.prototype.getBoundingClientRect;
      delete HTMLElement.prototype.innerText;
    });
    document.body.innerHTML = `<h2>WORKSPACES\n</h2><button aria-label="New workspace"><svg></svg></button><button>Continue\n</button>`;

    const read = READ_PAGE();
    expect(read.text.split("\n")).toEqual(["WORKSPACES", "[Continue]", "controls with no words of their own:", "[New workspace]"]);
  });

  it("reads a step at a time, and takes the break word as a break only where a verb would be", () => {
    expect(parseArgs(["priya", "click", "New workspace", "then", "shot", "new.png"])).toEqual({
      session: "priya",
      steps: [
        { verb: "click", words: ["New workspace"] },
        { verb: "shot", words: ["new.png"] },
      ],
    });
    // A page word is a page word: "then" after a verb is what to click, not another step.
    expect(parseArgs(["priya", "click", "then"]).steps).toEqual([{ verb: "click", words: ["then"] }]);
    expect(parseArgs(["priya", "shot", "wide.png", "--width", "1440"]).steps).toEqual([{ verb: "shot", words: ["wide.png"], width: 1440 }]);
  });

  it("waits for the answer, not for the words the tester typed coming back at them", () => {
    // The persona's own case: a one-word task, so every echo of the prompt holds the word the wait is for.
    document.body.innerHTML = `
      <div data-row-id="thread:th_1">Naming this thread pomegranate</div>
      <span data-thread-breadcrumb>Naming this thread pomegranate</span>
      <div data-message-role="user"><p>reply with the single word pomegranate and nothing else</p></div>
      <div data-testid="composer-editor"><p>reply with the single word pomegranate and nothing else</p></div>
      <div data-timeline-row-kind="working">Working</div>`;
    expect(SAID_ON_THE_PAGE(["pomegranate", PROMPT_ECHOES])).toBe(false);

    document.body.insertAdjacentHTML("beforeend", `<div data-message-role="assistant"><p>pomegranate</p></div>`);
    expect(SAID_ON_THE_PAGE(["pomegranate", PROMPT_ECHOES])).toBe(true);
  });

  it("is not ready while a thread's transcript is still arriving, so no shot of a working thread is blank", () => {
    const ready = () => READY_ON_THE_PAGE([APP_UP, NOT_READY_NAMES, TRANSCRIPT_LOADING, A_MESSAGE]);
    document.body.innerHTML = `<div data-shell-center><div>loading transcript</div></div>`;
    expect(ready()).toBe(false);
    // The words arrive and the line goes with them.
    document.body.innerHTML = `<div data-shell-center><div data-message-role="user"><p>list the files</p></div></div>`;
    expect(ready()).toBe(true);
    // A thread nobody has run yet has an empty pane for a reason, and waiting on one would hang every command.
    document.body.innerHTML = `<div data-shell-center><div>What should we build?</div></div>`;
    expect(ready()).toBe(true);
    // The composer's own words still hold it: a page that is connecting is not one a key press lands on.
    document.body.innerHTML = `<div data-shell-center><button aria-label="${COMPOSER_STATE_WORDS.connecting}"></button></div>`;
    expect(ready()).toBe(false);
  });

  it("takes every word the app is not ready in from the files that hold them, with no second spelling here", () => {
    expect(NOT_READY_NAMES).toEqual([
      COMPOSER_STATE_WORDS.workspaceUnavailable,
      COMPOSER_STATE_WORDS.connecting,
      COMPOSER_STATE_WORDS.preparingWorktree,
      ...Object.values(SEND_BLOCK_WORDS),
      HOST_ASLEEP_SEND,
    ]);
    // The one a tester really meets first: the socket is still dialling and the button says so in the protocol's
    // words, not the composer's.
    expect(NOT_READY_NAMES).toContain("Connecting to wsp");
  });

  it("puts a key press back into the field the same command typed into", () => {
    const steps = parseArgs(["sam", "type", "Send message", "list the files", "then", "press", "Enter"]).steps;
    expect(typedField(steps, 1)).toBe("Send message");
    // A press with nothing typed before it lands wherever the page left the focus, which is what a click leaves.
    expect(typedField(parseArgs(["sam", "click", "api", "then", "press", "Enter"]).steps, 1)).toBeUndefined();
    // A goto is a new page: whatever was typed before it is gone with the old one.
    expect(typedField(parseArgs(["sam", "type", "Send message", "hello", "then", "goto", "http://127.0.0.1:1", "then", "press", "Enter"]).steps, 2)).toBeUndefined();
  });

  it("says why a key press on a window that has only just opened would go nowhere", () => {
    expect(PRESS_NEEDS_FOCUS).toContain("click or type first");
    expect(PRESS_NEEDS_FOCUS).toContain("then");
  });

  it("takes quit as a verb of its own, since a window is closed rather than driven", () => {
    expect(parseArgs(["sam", "quit"]).steps).toEqual([{ verb: "quit", words: [] }]);
  });

  it("never takes a field's ghost as something to click, and still finds a field by it to type into", async () => {
    // A page where the only thing reading those words is a field's own example of what to type.
    const ghosting = held => {
      const asked = [];
      const guess = how => {
        asked.push(how);
        const one = { count: async () => (held === how ? 1 : 0), first: () => ({ how }), filter: () => one };
        return one;
      };
      return { asked, getByRole: role => guess(`role:${role}`), getByLabel: () => guess("label"), getByPlaceholder: () => guess("placeholder"), getByText: () => guess("text") };
    };
    const clicking = ghosting("placeholder");
    // A tester clicked the example path in the folder picker's field three times and wrote the picker off as
    // broken: an example is not a control, and a click that lands on one does nothing a person can see.
    expect(await findByWords(clicking, "~/code/spoo")).toBeUndefined();
    expect(clicking.asked).not.toContain("placeholder");
    // Typing is the one thing a ghost means, and that road still reads it.
    expect(await findField(ghosting("placeholder"), "~/code/spoo")).toEqual({ how: "placeholder" });
    const said = GHOST_IS_NOT_A_CONTROL("~/code/spoo");
    expect(said).toContain("field's own example");
    expect(said).toContain("type");
  });

  it("says which when a word reads on more than one control, rather than pressing the first of them", async () => {
    // Two controls read Remove, one in the row's menu and one in the row's own detail; the driver took the first
    // and the click timed out with nothing on the screen to say why.
    const said = await whyNotOne(reading({ exact: 2 }), "Remove");
    expect(said).toBe(SEVERAL_READ("Remove", 2));
    expect(said).toContain("say which");
    expect(said).toContain("attr=");
    // One control reading it is a word the driver can aim by, and a word aimed at an attribute already says which.
    expect(await whyNotOne(reading({ exact: 1 }), "Remove")).toBeUndefined();
    expect(await whyNotOne(reading({ exact: 2 }), "attr=row-id=ws:ws_api")).toBeUndefined();
    // The loose reading is the last guess and several of it is the page drawing a line inside another line.
    expect(await whyNotOne(reading({ exact: 0 }), "Remove")).toBeUndefined();
  });

  it("counts only what a tester can see, since a word by text reads an element the page laid nowhere", async () => {
    // A word drawn once on the screen and once under a panel that is closed would otherwise be refused as two
    // things to choose between while the page read lists one, and a tester would have nothing to say instead.
    const page = reading({ exact: 2, hidden: 1 });
    expect(await whyNotOne(page, "Remove")).toBeUndefined();
    expect(page.filtered).toEqual([{ visible: true }, { visible: true }, { visible: true }, { visible: true }, { visible: true }]);
  });

  it("says a menu an earlier command left open is over the thing a click aimed at, and nothing when none is", async () => {
    // The page keeps whatever the last command left open, which is what puts a menu over the next target.
    const said = UNDER_AN_OPEN_MENU("Edit");
    expect(said).toContain("menu");
    expect(said).toContain("press Escape then click");
    const page = open => ({ asked: [], locator(selector) { this.asked.push(selector); return { count: async () => open }; } });
    const covered = page(1);
    expect(await whyNotClicked(covered, "Edit")).toBe(said);
    expect(covered.asked).toEqual([OPEN_OVER_THE_PAGE]);
    // A click that would not land with nothing standing open is the driver's own failure and keeps its own words:
    // a sentence guessed at a menu would send a tester chasing one nobody opened.
    expect(await whyNotClicked(page(0), "Edit")).toBeUndefined();
    expect(await openMenu(page(1))).toBe(true);
    expect(await openMenu(page(0))).toBe(false);
    // A dialog is the thing the tester opened, so it is not one of these: telling them to close it is telling
    // them to leave the screen they are reading.
    expect(OPEN_OVER_THE_PAGE).not.toContain("dialog");
  });

  it("aims a word at a data attribute only when it says so", () => {
    expect(attrWord("attr=row-id=ws:ws_api")).toBe('[data-row-id="ws:ws_api"]');
    expect(attrWord("attr=cloud-setup-row")).toBe("[data-cloud-setup-row]");
    expect(attrWord("Set up cloud machines")).toBeUndefined();
    // The same rule the surfaces list is read by, so a word that is not an attribute name is refused rather than
    // turned into a class selector the next restyle moves.
    expect(() => attrWord("attr=.sidebar button")).toThrow(/data attribute name/);
  });
});

describe("what a lab tells the tester who starts it", () => {
  const home = "/Users/dev/wsp-lab/priya";
  const facts = {
    name: "priya",
    url: "http://127.0.0.1:4123",
    pid: 321,
    home,
    node: "/usr/local/bin/node",
    bin: "/repo/packages/host/dist/bin.js",
    env: { PATH: `${home}/bin:/usr/bin`, HOME: home, WSP_HOME: `${home}/.wsp`, WSP_PROVIDER: "none", [PERSON_HOME_ENV]: home },
    build: { sha: "34f2429839f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", app: "a1b2c3d4e5f60718", command: "0f1e2d3c4b5a6978", appDir: `${home}/app`, builtAt: "2026-09-12T09:05:00Z" },
    signedIn: true,
    for: "/notes/priya",
  };

  it("says when the app it is serving was built, so a tester's run is pinned to a build and not only to a commit", () => {
    expect(labLines(facts)[1]).toContain("built 2026-09-12T09:05:00Z");
    // Where the log will be, on the screen the tester is reading, so nobody has to work it out at the stop.
    expect(labLines(facts).find(line => line.startsWith("this lab's log"))).toContain(join("/notes/priya", "priya-lab.log"));
  });

  it("says where the app is, which build it is serving, and the shell whose wsp is this lab's", () => {
    const lines = labLines(facts);
    expect(lines[0]).toBe(`lab priya serving http://127.0.0.1:4123 pid 321 home ${home}`);
    // Which app a tester met, so a build that landed while they drove can be told from the one they were given.
    expect(lines[1]).toContain("34f2429839f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0");
    expect(lines[1]).toContain("a1b2c3d4e5f60718");
    // The command a tester's wsp runs is recorded beside the app, since its bundle resolves its imports out of the
    // checkout and cannot be copied into the lab's home the way the app is.
    expect(lines[1]).toContain("0f1e2d3c4b5a6978");
    expect(lines[1]).toContain(`${home}/app`);
    const shell = lines.at(-1);
    // Nothing of the tester's own in it, and this lab's wsp first on the path: a verb run under their own shell
    // reads their state file and the .env beside whichever checkout they are standing in.
    expect(shell).toContain("env -i");
    expect(shell).toContain(`HOME='${home}'`);
    expect(shell).toContain(`PATH='${home}/bin:/usr/bin'`);
  });

  it("says this computer's daemon is up and where its binary came from", () => {
    const daemon = "/repo/packages/wspx/daemon/aarch64-apple-darwin/wsp-daemon";
    expect(labLines({ ...facts, daemon, reach: "reachable" })[2]).toBe(`this computer's workspace reads reachable, its daemon out of ${daemon}`);
    // A fixture of forks alone has no row here to read, and a word about a workspace it does not hold would be a
    // word about nothing; the binary the forks' own daemons come out of is still named.
    expect(labLines({ ...facts, daemon })[2]).toBe(`this fixture has no workspace on this computer; the daemon its machines run is at ${daemon}`);
  });

  it("says the app here takes a typed folder, since the Finder chooser is the desktop app's road", () => {
    // A tester went looking for "Choose in Finder", found none and wrote the Import screen off as unfinished.
    expect(labLines(facts)).toContain(NO_FINDER_CHOOSER);
    expect(NO_FINDER_CHOOSER).toContain("browser");
    expect(NO_FINDER_CHOOSER).toContain("desktop app");
  });

  it("gives the tester's shell a pty, so wsp prints its reply once rather than on both streams", () => {
    // A pipe is not a terminal, so the command cannot tell that one screen holds both its streams and writes to
    // both; a tester read the doubled reply as the product repeating itself.
    expect(labShell(facts)).toContain("/usr/bin/script -q /dev/null /bin/sh");
    expect(labShell(facts).indexOf("env -i")).toBeLessThan(labShell(facts).indexOf("script"));
  });

  it("says the turn there has this lab's own wsp tools, since a tester's agent asks what it can reach", () => {
    expect(labLines(facts).join("\n")).toContain("this lab's own wsp tools");
  });

  it("says plainly when no key was found, since a turn there will answer that it is not logged in", () => {
    expect(labLines({ ...facts, signedIn: true }).join("\n")).toContain("signed in with the agents' key");
    for (const name of AGENT_KEYS) expect(labLines({ ...facts, signedIn: false }).join("\n")).toContain(name);
  });

  it("keeps a stopped lab's log in the folder the start was told about, not the one the stop was run from", () => {
    expect(keptLog("priya", "/notes/priya/lab.log", { for: "/somewhere/else" })).toBe("/notes/priya/lab.log");
    // Seven logs of one round of nine landed in two folders nobody was reading, because the stop reads the folder
    // a tester happens to be standing in and they stand wherever the shell left them.
    expect(keptLog("priya", undefined, { for: "/notes/priya" })).toBe("/notes/priya/priya-lab.log");
    // Nothing in the record and nothing said: the lab root's own logs folder, never the folder the start happened
    // to be run from. All nine logs of one round landed in the coordinator's working folder, unread.
    expect(keptLog("priya", undefined, undefined)).toBe(join(labLogs(), "priya-lab.log"));
  });

  it("takes that folder at the start, since by the stop there is nobody to ask", () => {
    expect(parseLabArgs(["start", "priya", "--fixture", "mac-only", "--for", "/notes/priya"])).toEqual({ verb: "start", name: "priya", fixture: "mac-only", for: "/notes/priya" });
    // A start that names none still records one, so both ends of a lab read the same folder.
    expect(parseLabArgs(["start", "priya", "--fixture", "mac-only"]).for).toBeUndefined();
  });
});

describe("a lab's own home", () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const throwaway = () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-lab-home-test-"));
    made.push(dir);
    return dir;
  };

  it("sits on this computer but outside the person's home, and moves whole when a run names another root", () => {
    // Everything under their home carries their own agent instructions: an agent reads the instruction file of
    // every .claude folder above the folder it runs in, and a tester's turn quoted the person's back at them.
    expect(labRoot({}, "darwin").startsWith(`${homedir()}/`)).toBe(false);
    expect(labHome("priya", {}, "darwin")).toBe("/Users/Shared/wsp-lab/priya");
    expect(labHome("priya", { WSP_LAB_ROOT: "/tmp/throwaway" })).toBe("/tmp/throwaway/priya");
    // A name with nothing in it is nobody naming anything.
    expect(labRoot({ WSP_LAB_ROOT: "" }, "darwin")).toBe("/Users/Shared/wsp-lab");
  });

  it("fills every agent store where that agent reads it, with the sign-in and nothing else", () => {
    const home = throwaway();
    const written = writeAgentHome(home);
    const rows = agentStoreRows(home);
    expect(rows.length).toBeGreaterThan(0);
    // The store is the folder the host points the agent at, not the home: a file written beside the home is a
    // file no agent opens, and one written there read as isolation that nothing was keeping.
    for (const { agent, store } of rows) {
      const path = join(store, agent.mcp.files[0].replace(/^~\//, "").split("/").at(-1));
      expect([path, written.includes(path)]).toEqual([path, true]);
      const config = JSON.parse(readFileSync(path, "utf8"));
      // This lab's own wsp and nothing else. An agent's own configuration on this Mac carries the person's MCP
      // servers, one of which is their own host: a tester's agent reached it through that entry and wrote a
      // workspace record there. With none at all a tester's agent does not know it is inside wsp: one wrote
      // JSON-RPC by hand for twelve minutes to find its own threads, and an orchestrator never opened one.
      // The file under the store is the catalog's own path for it with the home taken off, and the agent's own
      // folder too where that path goes through it: the store is that folder, so a second one under it is a file
      // no agent opens.
      expect(path.startsWith(`${store}/`)).toBe(true);
      expect(path.slice(store.length + 1).startsWith(`${agent.stateHome}/`)).toBe(false);
      expect(Object.keys(config.mcpServers)).toEqual(["wsp"]);
      expect(config.mcpServers.wsp).toEqual({ command: join(binDir(home), "wsp"), args: ["mcp"] });
      expect(config.projects).toBeUndefined();
      // Onboarding already answered, so a turn opens on the task rather than on a wizard.
      expect(config.hasCompletedOnboarding).toBe(true);
      // A skills folder that is there and empty: nothing of this computer's reaches a tester's thread.
      expect(statSync(join(store, "skills")).isDirectory()).toBe(true);
    }
  });

  it("writes the agents' keys where only this lab's verbs read them, and never into what it prints", () => {
    const home = throwaway();
    const path = writeKeys(home, { [AGENT_KEYS[0]]: "sk-ant-x-not-a-key" });
    expect(path).toBe(join(home, ".wsp", ".env"));
    expect(readFileSync(path, "utf8")).toBe(`${AGENT_KEYS[0]}=sk-ant-x-not-a-key\n`);
    // Nobody else on this computer reads it.
    expect(statSync(path).mode & 0o077).toBe(0);
    // The lines a lab prints and the record it keeps are read and pasted, so the key is in neither: what they
    // carry is whether one was found.
    const facts = { name: "priya", url: "u", pid: 1, home, node: "n", bin: "b", env: hostEnv({ home, state: { workspaces: {} } }), build: { sha: "s", app: "a", command: "c", appDir: "d" }, signedIn: true };
    expect(labLines(facts).join("\n")).not.toContain("sk-ant-x");
    expect(shimText(facts)).not.toContain("sk-ant-x");
  });

  it("takes each key from the first layer that holds it, calls an empty one no key, and opens no layer it does not need", () => {
    const name = AGENT_KEYS[0];
    expect(keysFound([() => ({}), () => ({ [name]: "" }), () => ({ [name]: "sk-ant-x-second" })])[name]).toBe("sk-ant-x-second");
    expect(keysFound([() => ({ [name]: "sk-ant-x-first" }), () => ({ [name]: "sk-ant-x-second" })])[name]).toBe("sk-ant-x-first");
    expect(keysFound([() => ({}), () => undefined])).toEqual({});
    // A layer is a file of the person's; the shell holding every key it looks for is the shell's answer alone, so
    // the files behind it are never opened.
    const opened = [];
    const layer = (what, held) => () => {
      opened.push(what);
      return held;
    };
    keysFound([layer("shell", Object.fromEntries(AGENT_KEYS.map(k => [k, "sk-ant-x-shell"]))), layer("checkout", {}), layer("their wsp home", {})]);
    expect(opened).toEqual(["shell"]);
  });

  it("makes a repository at every folder a fixture says a project was imported into", () => {
    const home = throwaway();
    const dests = [join(home, "wsp-work", "spoo"), join(home, "wsp-work", "wsp")];
    const { work, repos } = writeWorkFolder(home, dests);
    expect(work).toBe(join(home, "wsp-work"));
    expect(repos).toEqual(dests);
    // A turn starts in the project its workspace has, so a folder a fixture names and nobody makes is an agent in
    // a folder that is not there.
    for (const dest of dests) {
      expect(statSync(join(dest, "README.md")).isFile()).toBe(true);
      expect(statSync(join(dest, ".git")).isDirectory()).toBe(true);
    }
    // A fixture with no project still gives a turn somewhere of its own to work.
    const bare = throwaway();
    expect(writeWorkFolder(bare).repos).toEqual([join(bare, "wsp-work", "notes")]);
    expect(statSync(join(bare, "wsp-work", "notes", "README.md")).isFile()).toBe(true);
  });

  it("finds a lab it started under another root, so a stop from any shell reaches the pid that was recorded", () => {
    const home = throwaway();
    const name = `test-${home.split("-").at(-1).toLowerCase()}`;
    const pointer = pointerPath(name);
    try {
      // A lab started with one root and stopped from a shell naming another was told there was nothing to stop,
      // and its host stayed up. The pointer is what makes the recorded pid findable.
      writeFileSync(join(home, "lab.json"), "{}\n");
      writeFileSync(pointer, `${JSON.stringify({ home })}\n`);
      expect(homeOf(name)).toBe(home);
      // A pointer at a folder that holds no lab is a lab that has been stopped: the root's own answer stands.
      rmSync(join(home, "lab.json"));
      expect(homeOf(name)).toBe(labHome(name));
    } finally {
      rmSync(pointer, { force: true });
    }
    expect(homeOf(name)).toBe(labHome(name));
  });

  it("refuses to remove a folder that is not a lab's, since a root named wrongly would take a real one with it", () => {
    const home = throwaway();
    // A folder holding somebody's files and no record of this harness is not this start's to delete.
    expect(whyNotOursToRemove(home, () => ["spoo", "notes"])).toContain("not a lab of this harness");
    // Both verbs read it, so it names neither of them.
    expect(whyNotOursToRemove(home, () => ["spoo", "notes"])).not.toContain("start");
    // A lab's own home, and a folder that is not there or holds nothing, are.
    expect(whyNotOursToRemove(home, () => ["lab.json", "app", "wsp-work"])).toBeUndefined();
    expect(whyNotOursToRemove(home, () => [])).toBeUndefined();
    expect(whyNotOursToRemove(home, () => undefined)).toBeUndefined();
  });

  it("puts this lab's wsp on the tester's path, bound to this lab and to nothing of theirs", () => {
    const home = "/Users/dev/wsp-lab/kai";
    const env = { PATH: `${home}/bin:/usr/bin`, HOME: home, WSP_HOME: `${home}/.wsp`, WSP_PROVIDER: "fake" };
    const text = shimText({ home, node: "/usr/local/bin/node", bin: "/repo/packages/host/dist/bin.js", env });
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(`cd '${home}'`);
    // Nothing of the tester's environment survives, and the lab's own bin leads the path so a verb that shells out
    // to wsp reaches this lab again.
    expect(text).toContain("env -i");
    for (const [name, value] of Object.entries(env)) expect(text).toContain(`${name}='${value}'`);
    expect(text).toContain('"$@"');
    expect(binDir(home)).toBe(`${home}/bin`);
  });

  it("refuses to start on an app it could not copy whole, since a build landing mid-copy serves a page nobody can name", () => {
    const from = throwaway();
    writeFileSync(join(from, "index.html"), "<!doctype html>one");
    // The three readings a copy takes: the source before it, the copy, then the source again. One run of nine
    // served an app hashing to something no other run served, and what it was cannot be recovered.
    // The command's own hash comes in as a reader too, so this case asks nothing of a checkout that has not been
    // built: every other case in this file runs without one.
    const command = () => "0f1e2d3c4b5a6978";
    const moved = answers => () => copyApp(throwaway(), { from, command, hash: () => answers.shift() });
    expect(moved(["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"])).toThrow(/changed while it was being copied/);
    expect(moved(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"])).toThrow(/changed while it was being copied/);
    // A folder nobody is writing copies whole, and the record says which build it was.
    const copied = copyApp(throwaway(), { from, command });
    expect(copied.command).toBe(command());
    expect(copied.hash).toBe(folderHash(from));
    expect(copied.builtAt).toBe(builtAt(from));
    expect(copied.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("hands the stand-in a folder of the lab's own, under .wsp where the app's folder picker never lists it", () => {
    const home = throwaway();
    const state = fixtureState("solari-only", { home });
    const fleet = fixtureFleet(state);
    const path = writeStandIn(home, fleet);
    // A tester opened Import, was shown a folder called stand-in in what the app had just told them was their
    // home, and could not say what it was; nothing hidden is listed there.
    expect(standInRoot(home)).toBe(join(home, ".wsp", "stand-in"));
    expect(path.startsWith(`${standInRoot(home)}/`)).toBe(true);
    // A stand-in listing no snapshot answered "0 snapshots" on the line pricing the account's storage while the
    // versions table above it showed two, and one holding no machine woke every sleeping fork in the fixture.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fleet);
    expect(Object.keys(fleet.machines).length).toBeGreaterThan(0);
  });

  it("keeps a lab's log and takes its home away even when no pid was written down, since the host may already be gone", async () => {
    const home = throwaway();
    const kept = throwaway();
    const name = `test-${home.split("-").at(-1).toLowerCase()}`;
    writeFileSync(join(home, "lab.json"), `${JSON.stringify({ name, home, for: kept })}\n`);
    writeFileSync(join(home, "lab.log"), "the host said the send failed\n");
    writeFileSync(pointerPath(name), `${JSON.stringify({ home })}\n`);
    try {
      await stopLab({ name });
    } finally {
      rmSync(pointerPath(name), { force: true });
    }
    expect(readFileSync(join(kept, `${name}-lab.log`), "utf8")).toContain("the host said the send failed");
    expect(existsSync(home)).toBe(false);
  });

  it("leaves a folder that is not a lab's where it is, since a stop no longer returns before it removes anything", async () => {
    // A root named in a shell and a name typed wrongly point the stop at a folder that is somebody's. It used to
    // return at the missing pid file and remove nothing; now it goes on to keep the log, so it reads the folder
    // the way the start does before it takes anything away.
    const root = throwaway();
    const name = `test-${root.split("-").at(-1).toLowerCase()}`;
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "the-only-copy.md"), "somebody's file\n");
    const was = process.env["WSP_LAB_ROOT"];
    process.env["WSP_LAB_ROOT"] = root;
    try {
      expect(homeOf(name)).toBe(home);
      await stopLab({ name });
    } finally {
      if (was === undefined) delete process.env["WSP_LAB_ROOT"];
      else process.env["WSP_LAB_ROOT"] = was;
    }
    expect(existsSync(join(home, "the-only-copy.md"))).toBe(true);
  });

  it("hashes the app it copied, so two runs can be told apart by what they served", () => {
    const one = throwaway();
    const two = throwaway();
    writeFileSync(join(one, "index.html"), "<!doctype html>one");
    writeFileSync(join(two, "index.html"), "<!doctype html>one");
    expect(folderHash(one)).toBe(folderHash(two));
    writeFileSync(join(two, "index.html"), "<!doctype html>two");
    expect(folderHash(one)).not.toBe(folderHash(two));
  });
});

describe("the environment a fixture's host is started with", () => {
  const home = "/Users/dev/wsp-lab/priya";

  it("names the home a turn's agent runs under, which a lab points at itself", () => {
    const env = hostEnv({ home, state: { workspaces: {} }, personHome: home });
    expect(env).toEqual({
      PATH: process.env["PATH"],
      HOME: home,
      WSP_HOME: `${home}/.wsp`,
      WSP_PROVIDER: "none",
      [PERSON_HOME_ENV]: home,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
    });
    // Nothing of the shell that started it beyond the path the agents are found on: a key or a home in the
    // tester's terminal would put the run on a real provider or on their own machines.
    expect(Object.keys(env).filter(name => name.startsWith("WSP_")).sort()).toEqual(["WSP_HOME", PERSON_HOME_ENV, "WSP_PROVIDER"].sort());
  });

  it("takes this computer's home when none is named, which is every host but a lab's", () => {
    expect(hostEnv({ home, state: { workspaces: {} } })[PERSON_HOME_ENV]).toBe(homedir());
  });

  it("moves every agent's store into a lab's own home, and leaves the person's alone where the home is theirs", () => {
    // The agent this computer runs looks its user instructions up under the home its login record names, whatever
    // HOME says, so a turn quoted the person's own instruction file back at a tester; the store variable is what
    // moves the lookup. Which variable is the catalog's to name.
    const lab = hostEnv({ home, state: { workspaces: {} }, personHome: home });
    expect(lab.CLAUDE_CONFIG_DIR).toBe(`${home}/.claude`);
    // The screenshot run's host serves under a throwaway home but runs no turn, so nothing of the person's moves.
    expect(hostEnv({ home, state: { workspaces: {} }, personHome: "/Users/dev" }).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("points the host at the app the lab copied, so a build that lands mid-run changes nothing under a tester", () => {
    expect(hostEnv({ home, state: { workspaces: {} }, appDir: `${home}/app` })[WEB_DIR_ENV]).toBe(`${home}/app`);
    // A run that copied nothing says nothing, and the host serves what was built beside it.
    expect(hostEnv({ home, state: { workspaces: {} } })[WEB_DIR_ENV]).toBeUndefined();
  });

  it("leads the path with this lab's own wsp, so a turn that shells out to one reaches this host", () => {
    expect(hostEnv({ home, state: { workspaces: {} }, binDir: `${home}/bin` }).PATH.startsWith(`${home}/bin:`)).toBe(true);
  });

  it("gives the stand-in a folder of the lab's own where the caller asks for one, and none where it does not", () => {
    const forks = fixtureState("solari-only");
    // A fork whose machine has a folder has a daemon, which is what answers its terminal, its process list and its
    // live readings; without one every one of those rows read unreachable to three testers in a row.
    expect(hostEnv({ home, state: forks, standIn: `${home}/stand-in` })[FAKE_ROOT_ENV]).toBe(`${home}/stand-in`);
    // The screenshot run photographs screens rather than driving machines, so it asks for none and starts none.
    expect(hostEnv({ home, state: forks })[FAKE_ROOT_ENV]).toBeUndefined();
    // A fixture of this computer's own machines runs under no stand-in at all.
    expect(hostEnv({ home, state: fixtureState("mac-only"), standIn: `${home}/stand-in` })[FAKE_ROOT_ENV]).toBeUndefined();
  });

  it("names the stand-in's records alone where no folder was asked for, so a seeded fleet starts no daemon", () => {
    const forks = fixtureState("solari-only");
    const records = `${home}/.wsp/stand-in/records.json`;
    // The run that photographs screens seeds the fleet and drives none of it: its sleeping fork sleeps because the
    // records say so, and no machine gets a folder, so nothing runs on any of them.
    expect(hostEnv({ home, state: forks, records })[FAKE_RECORDS_ENV]).toBe(records);
    // A folder carries its own records inside it, so the two are never both named.
    expect(hostEnv({ home, state: forks, records, standIn: `${home}/.wsp/stand-in` })[FAKE_RECORDS_ENV]).toBeUndefined();
    // A fixture of this computer's own machines runs under no stand-in at all, so there is no fleet to seed.
    expect(hostEnv({ home, state: fixtureState("mac-only"), records })[FAKE_RECORDS_ENV]).toBeUndefined();
  });

  it("tells the stand-in which cloud it is standing in for, and only where a stand-in is serving", () => {
    const forks = fixtureState("ascii-only");
    expect(hostEnv({ home, state: forks, cloud: "box" })[FAKE_AS_ENV]).toBe("box");
    // A fixture of this computer's own machines runs under no provider at all, so there is nothing to stand in for.
    expect(hostEnv({ home, state: fixtureState("mac-only"), cloud: "box" })[FAKE_AS_ENV]).toBeUndefined();
  });
});
