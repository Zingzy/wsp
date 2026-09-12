// SPDX-License-Identifier: AGPL-3.0-only
// What a lab is made of, checked without a host, a build or a browser: the
// fixtures a tester picks between, the provider and the environment each one
// needs, the lines a lab prints, and the rules the driver reads a page with.
import { HOST_ASLEEP_SEND, PERSON_HOME_ENV, SEND_BLOCK_WORDS } from "@wsp/protocol";
import { COMPOSER_STATE_WORDS } from "../src/composer-state-words.js";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { READ_PAGE, SAID_ON_THE_PAGE, attrWord, diffLines, parseArgs } from "./drive.mjs";
import { FIXTURE_NAMES, fixtureState } from "./fixture-state.mjs";
import { hostEnv, providerFor } from "./host.mjs";
import { NOT_READY_NAMES, PROMPT_ECHOES } from "./ready.mjs";
import { keptLog, labLines } from "./lab.mjs";

describe("the fixtures a lab serves", () => {
  it("has one per kind of person the testers play", () => {
    expect(FIXTURE_NAMES).toEqual(["mac-in-use", "mac-only", "mac-and-laptop", "mac-and-vps", "ascii-only", "solari-only", "both-providers", "no-sign-in", "orchestrator", "image-built"]);
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

  it("puts every folder a fixture names under this computer's own home, so no tester is shown a stranger's Mac", () => {
    for (const name of FIXTURE_NAMES) {
      const state = fixtureState(name);
      for (const w of Object.values(state.workspaces)) {
        // A fork's folders are on the machine it runs on, and a computer that redeemed a pairing code has a home of
        // its own; what a fixture may not do is put this computer's own files somewhere this person has never been.
        if (w.kind !== "local" || w.id === "ws_laptop") continue;
        expect([name, w.home, w.folder]).toEqual([name, homedir(), homedir()]);
        for (const project of w.projects ?? []) expect([name, project.dest.startsWith(`${homedir()}/`)]).toEqual([name, true]);
      }
      for (const doc of Object.values(state.sessions)) {
        for (const row of doc.sessions) expect([name, row.cwd.startsWith(homedir())]).toEqual([name, true]);
      }
    }
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
        expect([name, w.kind]).toEqual([name, w.kind === "local" ? "local" : "cloud"]);
        expect([name, typeof w.name, typeof w.machineId, typeof w.phase]).toEqual([name, "string", "string", "string"]);
        // A fork boots from the image the manifest's head names; a local machine forks from nothing.
        if (w.kind === "cloud") expect([name, w.golden]).toEqual([name, state.goldens.default.versions.at(-1).snapshotId]);
        else expect([name, w.golden]).toEqual([name, ""]);
      }
    }
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

  it("hangs an orchestrator's spawned threads off the one root, on a workspace whose agents may spawn", () => {
    const state = fixtureState("orchestrator");
    const spawning = Object.values(state.workspaces).filter(w => w.agents?.spawn === true);
    expect(spawning.map(w => w.name)).toEqual([hostname()]);
    const rows = Object.values(state.sessions).flatMap(d => d.sessions);
    const under = rows.filter(r => r.parentThreadId !== undefined);
    expect(under.length).toBeGreaterThan(1);
    for (const row of under) expect([row.id, row.rootThreadId, row.startedBy]).toEqual([row.id, "th_migrate", "agent"]);
    // The root is a thread that is really there, and it is a person's.
    expect(rows.find(r => r.threadId === "th_migrate")?.startedBy).toBe("person");
  });

  it("names the fixture the screenshot run photographs as its default, and refuses one nobody wrote", () => {
    expect(JSON.stringify(fixtureState())).toBe(JSON.stringify(fixtureState("mac-in-use")));
    expect(() => fixtureState("mac-and-fridge")).toThrow(/no fixture is called mac-and-fridge/);
  });
});

describe("the provider a fixture's host runs under", () => {
  it("asks for the one that answers out of memory only where a fixture holds forks or a sealed image", () => {
    const by = Object.fromEntries(FIXTURE_NAMES.map(name => [name, providerFor(fixtureState(name))]));
    expect(by).toEqual({
      "mac-in-use": "none",
      "mac-only": "none",
      "mac-and-laptop": "none",
      "mac-and-vps": "fake",
      "ascii-only": "fake",
      "solari-only": "fake",
      "both-providers": "fake",
      "no-sign-in": "none",
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
  const facts = {
    name: "priya",
    url: "http://127.0.0.1:4123",
    pid: 321,
    home: "/tmp/wsp-lab-priya",
    node: "/usr/local/bin/node",
    bin: "/repo/packages/host/dist/bin.js",
    env: { PATH: "/usr/bin", HOME: "/tmp/wsp-lab-priya", WSP_HOME: "/tmp/wsp-lab-priya/.wsp", WSP_PROVIDER: "none", [PERSON_HOME_ENV]: "/Users/dev" },
  };

  it("says where the app is, whose home its turns run under, and how to run a verb against this lab alone", () => {
    const lines = labLines(facts);
    expect(lines[0]).toBe("lab priya serving http://127.0.0.1:4123 pid 321 home /tmp/wsp-lab-priya");
    expect(lines[1]).toContain("/Users/dev");
    const verb = lines.at(-1);
    // The child's own environment, word for word, and nothing of the tester's: a verb that runs in their shell
    // reads their state file and the .env beside whichever checkout they are standing in.
    expect(verb).toContain("env -i");
    expect(verb).toContain("cd '/tmp/wsp-lab-priya'");
    for (const [name, value] of Object.entries(facts.env)) expect(verb).toContain(`${name}='${value}'`);
  });

  it("keeps a stopped lab's log beside the tester unless they name somewhere else", () => {
    expect(keptLog("priya", "/notes/priya/lab.log")).toBe("/notes/priya/lab.log");
    expect(keptLog("priya", undefined)).toBe(join(process.cwd(), "priya-lab.log"));
  });
});

describe("the environment a fixture's host is started with", () => {
  it("carries the person's own home beside the throwaway one, so a turn finds the sign-in they made", () => {
    const env = hostEnv({ home: "/tmp/wsp-lab-priya", state: { workspaces: {} }, personHome: "/Users/dev" });
    expect(env).toEqual({
      PATH: process.env["PATH"],
      HOME: "/tmp/wsp-lab-priya",
      WSP_HOME: "/tmp/wsp-lab-priya/.wsp",
      WSP_PROVIDER: "none",
      [PERSON_HOME_ENV]: "/Users/dev",
    });
    // Nothing of the shell that started it beyond the path the agents are found on: a key or a home in the
    // tester's terminal would put the run on a real provider or on their own machines.
    expect(Object.keys(env).filter(name => name.startsWith("WSP_")).sort()).toEqual(["WSP_HOME", PERSON_HOME_ENV, "WSP_PROVIDER"].sort());
  });

  it("takes this computer's home when none is named, which is every host but a harness's", () => {
    expect(hostEnv({ home: "/tmp/wsp-lab-priya", state: { workspaces: {} } })[PERSON_HOME_ENV]).toBe(homedir());
  });
});
