// SPDX-License-Identifier: AGPL-3.0-only
// What a lab is made of, checked without a host, a build or a browser: the
// fixtures a tester picks between, the provider each one needs, and the two
// rules the driver reads a page with.
import { describe, expect, it } from "vitest";
import { attrWord, diffLines } from "./drive.mjs";
import { FIXTURE_NAMES, fixtureState } from "./fixture-state.mjs";
import { providerFor } from "./host.mjs";

describe("the fixtures a lab serves", () => {
  it("has one per kind of person the testers play", () => {
    expect(FIXTURE_NAMES).toEqual(["mac-only", "mac-and-laptop", "mac-and-vps", "ascii-only", "solari-only", "both-providers", "no-sign-in", "orchestrator"]);
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
    expect(spawning.map(w => w.name)).toEqual(["this-mac"]);
    const rows = Object.values(state.sessions).flatMap(d => d.sessions);
    const under = rows.filter(r => r.parentThreadId !== undefined);
    expect(under.length).toBeGreaterThan(1);
    for (const row of under) expect([row.id, row.rootThreadId, row.startedBy]).toEqual([row.id, "th_migrate", "agent"]);
    // The root is a thread that is really there, and it is a person's.
    expect(rows.find(r => r.threadId === "th_migrate")?.startedBy).toBe("person");
  });

  it("names the fixture the screenshot run photographs as its default, and refuses one nobody wrote", () => {
    expect(JSON.stringify(fixtureState())).toBe(JSON.stringify(fixtureState("mac-only")));
    expect(() => fixtureState("mac-and-fridge")).toThrow(/no fixture is called mac-and-fridge/);
  });
});

describe("the provider a fixture's host runs under", () => {
  it("asks for the one that answers out of memory only where a fixture holds forks or a sealed image", () => {
    const by = Object.fromEntries(FIXTURE_NAMES.map(name => [name, providerFor(fixtureState(name))]));
    expect(by).toEqual({
      "mac-only": "none",
      "mac-and-laptop": "none",
      "mac-and-vps": "fake",
      "ascii-only": "fake",
      "solari-only": "fake",
      "both-providers": "fake",
      "no-sign-in": "none",
      orchestrator: "fake",
    });
  });

  it("reads a sealed image on its own, since a person can hold one with every machine asleep and none recorded", () => {
    expect(providerFor({ workspaces: {}, goldens: { default: { head: 1, versions: [] } } })).toBe("fake");
    expect(providerFor({ workspaces: {} })).toBe("none");
  });
});

describe("what the driver reads and aims at", () => {
  it("says the lines that came and went, and nothing about the ones that stayed", () => {
    expect(diffLines("api\nweb\nnotes", "api\nweb\nnotes")).toEqual([]);
    expect(diffLines("api\nnotes", "api\nweb\nnotes")).toEqual(["+ web"]);
    expect(diffLines("api\nweb\nnotes", "api\nnotes")).toEqual(["- web"]);
    // A page read for the first time is every line new rather than nothing.
    expect(diffLines("", "api\nweb")).toEqual(["+ api", "+ web"]);
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
