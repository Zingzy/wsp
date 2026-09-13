// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { PLACE_INSTALL, PLACES_WORDS, REPORTED_WORD, ROW_LINE_MAX, absentComputer, absentRoad, awayMsOf, lastKnown, placeAddSheetWord, placeDialLine, placeNoDialLine, workspacePlace, workspaceState } from "../src/index.js";

describe("the one state of a computer that is not answering", () => {
  const now = Date.parse("2026-09-12T13:30:00.000Z");
  const reading = absentComputer("old-laptop", awayMsOf({ lastSeenAt: "2026-09-12T12:52:00.000Z" }, now));

  it("says the same thing in every slot that has to hold it", () => {
    expect(reading.word).toBe("Unreachable");
    // The table's slot stands beside three fact columns and holds one word; how long it has been is on the row's
    // title and in its detail's Answered row, which is where the figure already was.
    expect(reading.away).toBe("no answer");
    expect(reading.line).toBe("no answer 38 min · is it on?");
    expect(reading.said).toBe("old-laptop is not answering");
    expect(reading.will).toBe("it connects on its own when it is on");
    expect(reading.sentence).toBe("old-laptop is not answering; it connects on its own when it is on");
  });

  it("writes the row's line under the cap the row cuts at, so the half that says what to do is never the half that goes", () => {
    for (const ms of [0, 59 * 60_000, 23 * 3_600_000, 400 * 86_400_000, null]) {
      expect(absentComputer("old-laptop", ms).line.length).toBeLessThanOrEqual(ROW_LINE_MAX);
    }
  });

  it("says nothing about how long it has been when this host never heard from it", () => {
    expect(awayMsOf({}, now)).toBeNull();
    expect(absentComputer("old-laptop", null).away).toBe("no answer");
    expect(absentComputer("old-laptop", null).line).toBe("no answer · is it on?");
  });

  it("states the silence and asks, and never claims the computer is off, which this host cannot know", () => {
    // A computer that is on and simply not answering reads the same line, so the line may not diagnose: the host
    // knows the silence and that the computer dials in by itself, and nothing else.
    for (const ms of [0, 38 * 60_000, 23 * 3_600_000, null]) {
      const line = absentComputer("hetzner", ms).line;
      expect(line).not.toContain("turn it on");
      expect(line).not.toContain("switch");
      expect(line.startsWith("no answer")).toBe(true);
    }
  });

  it("names the computer a workspace stands on however the workspace got there", () => {
    expect(workspacePlace({ machineId: "place:p_oldlaptop" })).toBe("p_oldlaptop");
    expect(workspacePlace({ machineId: "ctr_9f", place: "p_oldlaptop" })).toBe("p_oldlaptop");
    expect(workspacePlace({ machineId: "sbx_44" })).toBeUndefined();
  });

  it("folds a computer that answers nothing into the state word every surface reads", () => {
    expect(workspaceState({ phase: "running", reach: "unreachable" })).toBe("unreachable");
  });
});

describe("what this host knows about reaching a computer that is not answering", () => {
  const awayMs = 32 * 60_000;

  it("names the login it dials on the ssh road, dates the silence and puts the last refusal at the end", () => {
    const road = absentRoad({ name: "vps", road: { ssh: "root@65.21.4.12" }, awayMs, dialled: { answered: false, said: "ssh: connect to host 65.21.4.12 port 22: Connection refused" } });
    // The spec's row detail, one string: the address and the road it is.
    expect(road.address).toBe("root@65.21.4.12 · ssh");
    expect(road.answered).toBe("32 min ago");
    expect(road.refused).toBe("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    expect(road.sentence).toBe("wsp logs in to vps at root@65.21.4.12 over ssh; it last answered 32 min ago. The last try said: ssh: connect to host 65.21.4.12 port 22: Connection refused");
  });

  it("names the address a computer that joined with a code dialled in from, since that is the only one there is", () => {
    const road = absentRoad({ name: "old-laptop", road: { from: "192.168.1.34" }, awayMs: 36 * 60_000 });
    expect(road.address).toBe("192.168.1.34 · dials in");
    expect(road.refused).toBeNull();
    expect(road.sentence).toBe("wsp waits for old-laptop to dial in, last from 192.168.1.34; it last answered 36 min ago.");
  });

  it("says so plainly on a computer this host has no address for and has never heard from", () => {
    const road = absentRoad({ name: "old-laptop", awayMs: null });
    expect(road.address).toBeNull();
    expect(road.answered).toBe("not since it joined");
    expect(road.sentence).toBe("wsp waits for old-laptop to dial in; it has not answered since it joined.");
  });

  it("keeps a refusal off the reading when the last dial answered", () => {
    expect(absentRoad({ name: "vps", awayMs, dialled: { answered: true, roundTripMs: 14 } }).refused).toBeNull();
  });

  it("marks a fact the computer has stopped answering for as the reading it is, never as one still coming", () => {
    expect(lastKnown("Debian 12", awayMs)).toBe("Debian 12 · last seen 32 min ago");
    // Nothing to date it against leaves the fact as it stands rather than inventing a span.
    expect(lastKnown("Debian 12", null)).toBe("Debian 12");
    // A figure that grows while the computer is up is dated by the report it was read in, not by the silence: the
    // two spans differ by however long the link was held after that report.
    expect(lastKnown("4h 12m", 3 * 3_600_000, REPORTED_WORD)).toBe("4h 12m · reported 3 h ago");
  });
});

describe("what one dial of a computer answers", () => {
  it("reads a frame the link carried as the computer itself answering, with how long it took", () => {
    expect(placeDialLine({ name: "vps", linked: true, dialled: { answered: true, roundTripMs: 14 } })).toBe("vps answered in 14 ms.");
  });

  it("reads an ssh login that answered while the link is down as the computer being on and the agent not calling home", () => {
    const line = placeDialLine({ name: "vps", road: { ssh: "root@65.21.4.12" }, linked: false, dialled: { answered: true, roundTripMs: 412 } });
    expect(line).toBe("root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.");
  });

  it("hands back the road's own sentence when nothing answered, rather than a wsp-shaped one over it", () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    expect(placeDialLine({ name: "vps", road: { ssh: "root@65.21.4.12" }, linked: false, dialled: { answered: false, said } })).toBe(said);
  });

  it("says there is no road at all on a computer that joined by typing a code", () => {
    expect(placeNoDialLine("old-laptop")).toContain("joined by typing a code");
  });
});

describe("what the two screens say wsp puts on a computer", () => {
  it("writes the ssh road's install lines from the one list, folder, weight and whose service it is included", () => {
    expect(placeAddSheetWord("wsp", "running")).toBe("installing wsp under ~/.wsp");
    expect(PLACE_INSTALL.weight).toBe("about 40 MB");
    expect(placeAddSheetWord("service", "running")).toBe("starting the agent as a user service");
    expect(PLACE_INSTALL.imageCopy("4.2 GB")).toBe("Your image (4.2 GB) is copied into Docker there the first time a workspace is created. Remove takes all of it off again.");
    // A host that has built no image yet says the sentence without a figure rather than one it guessed.
    expect(PLACE_INSTALL.imageCopy(undefined)).toBe("Your image is copied into Docker there the first time a workspace is created. Remove takes all of it off again.");
  });

  it("calls the command beside wsp's files what it does, on the way in and on the way out, and never a shim", () => {
    expect(PLACE_INSTALL.taken.opener).toContain("opens sign-in pages in your browser");
    for (const said of [PLACES_WORDS.remove.leaveTakes, PLACE_INSTALL.taken.opener, PLACE_INSTALL.openerLine, placeAddSheetWord("wsp", "running"), placeAddSheetWord("service", "running")]) {
      expect(said).not.toContain("shim");
    }
  });

  it("writes what Remove takes off from the same list, so neither screen can hold a word the other lost", () => {
    // Every one of the three, in the sentence, off the list rather than spelled again beside it.
    for (const said of Object.values(PLACE_INSTALL.taken)) expect(PLACES_WORDS.remove.leaveTakes).toContain(said);
    expect(PLACES_WORDS.remove.leaveTakes).toBe(
      `It takes off ${PLACE_INSTALL.taken.service}, ${PLACE_INSTALL.taken.files}, and ${PLACE_INSTALL.taken.opener}. Your work folder stays, and so do any copies of your image in Docker there.`,
    );
  });
});
