// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, JOINED_COMPUTER, PLACE_BLOCKED_WORD, absentComputer, placeDaemonBehind, type PlaceProvision, type PlaceView, type SealedImageCopy, type WorkspaceView } from "@wsp/protocol";
import { copyOn } from "./image.js";
import { NOTHING_HELD, PLACE_KIND_WORDS, PROJECT_PICK_WORDS, hereName, outcomeWord, placeName, placeOf, placeStateCell, removeSentence, removeTitle, whereSegments } from "./places.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const MAC = "zingzy's MacBook Pro";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzys-macbook-pro.local", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, engine: "none", present: true, takesForks: false };
const hetzner: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "hetzner",
  default: true,
  shape: { cpu: 2, memMb: 4 * 1024 },
  diskFreeBytes: 38 * 1024 ** 3,
  engine: "docker",
  present: true,
  takesForks: true,
  joinedAt: ago(60 * 60 * 1000),
  lastSeenAt: ago(3_000),
};
const laptop: PlaceView = { ...hetzner, id: "p_2", name: "old-macbook", default: false, shape: { cpu: 4, memMb: 8 * 1024 }, diskFreeBytes: 91 * 1024 ** 3, engine: "none", present: false, lastSeenAt: ago(2 * 60 * 60 * 1000) };
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };

describe("what the section computes beyond the table's own cells", () => {
  it("reads a provider row under the name a person knows it by", () => {
    expect(placeName(ascii)).toBe("Boat");
    expect(placeName(hetzner)).toBe("hetzner");
  });

  it("calls the computer the host runs on by the name its owner gave it, else its hostname, never this Mac", () => {
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local", label: MAC })).toBe(MAC);
    expect(placeName({ ...here, name: "zingzys-macbook-pro.local" })).toBe("zingzys-macbook-pro.local");
    expect(hereName([{ ...here, label: MAC }, hetzner])).toBe(MAC);
    expect(hereName([hetzner, { ...here, label: MAC }])).toBe(MAC);
    // Until the places list holds the row there is no name, and no stand-in word is said in its place.
    expect(hereName([hetzner])).toBe("");
    expect(hereName([])).toBe("");
    expect(removeSentence(hetzner, NOTHING_HELD, "")).toBe("");
  });
});

describe("the remove sentence", () => {
  it("names what comes off a computer that holds workspaces, and what leaves the computer the host runs on", () => {
    expect(removeTitle(hetzner)).toBe("Remove hetzner?");
    expect(removeSentence(hetzner, { workspaces: [{ name: "spoo-fix", state: "Running", threads: 2 }] }, MAC, 4.2 * 1024 ** 3)).toBe(
      "wsp and its task come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The task's record and 2 threads leave zingzy's MacBook Pro.",
    );
  });

  it("says workspaces and records in the plural above one", () => {
    expect(removeSentence(hetzner, { workspaces: [{ name: "a", state: "Running", threads: 2 }, { name: "b", state: "Running", threads: 1 }] }, MAC, 4.2 * 1024 ** 3)).toBe(
      "wsp and its 2 tasks come off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is. The tasks' records and 3 threads leave zingzy's MacBook Pro.",
    );
  });

  it("drops the second sentence for a computer that holds none", () => {
    expect(removeSentence(hetzner, NOTHING_HELD, MAC, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("leaves the size out where nothing has measured the image", () => {
    expect(removeSentence(hetzner, NOTHING_HELD, MAC)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image stays where it is.");
  });

  it("says what becomes of the copy of the image, since every computer that joined runs workspaces and holds one", () => {
    // What Remove promises about four gigabytes of somebody's disk is what the sweep does: it walks wsp's own
    // folder and the unit, and never the store the copy sits in, so the copy stays.
    expect(removeSentence(hetzner, NOTHING_HELD, MAC, 4.2 * 1024 ** 3)).toBe("wsp comes off hetzner, which is otherwise left as it is, and the copy of your image (4.2 GB) stays where it is.");
  });

  it("says a provider's workspaces are deleted there and its key forgotten here", () => {
    expect(removeSentence(ascii, { workspaces: [{ name: "api", state: "Running", threads: 3 }, { name: "web", state: "Running", threads: 2 }] }, MAC)).toBe(
      "Its 2 tasks are deleted at Boat and the key is forgotten on zingzy's MacBook Pro. Their records and 5 threads leave zingzy's MacBook Pro.",
    );
  });

  it("adds when an offline computer is swept", () => {
    expect(removeSentence(laptop, NOTHING_HELD, MAC)).toBe(
      "wsp comes off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. It is offline; what is on it is swept the next time it connects.",
    );
  });
});

describe("the rows the New workspace dialog offers, and what each says", () => {
  const copy = (place: string, version: number): SealedImageCopy => ({ place, version, snapshotId: `snap_${place}`, builtAt: ago(60_000) });

  it("offers every computer and provider that takes a workspace, never the computer the app runs on", () => {
    // This computer runs Docker here: it can hold copies of the image, and it is still never somewhere to put
    // another workspace, since its local mode is already the one it can be.
    expect(whereSegments([{ ...here, engine: "docker" }, hetzner, laptop, ascii]).map(p => p.id)).toEqual(["p_1", "p_2", "box"]);
  });

  it("offers nothing at all where this computer is the only row there is", () => {
    expect(whereSegments([{ ...here, engine: "docker" }])).toEqual([]);
  });

  it("says there is no project to make a workspace of yet, and the line that records one", () => {
    expect(PROJECT_PICK_WORDS.noneYet).toBe("No projects yet, and a task is a copy of one.");
    expect(PROJECT_PICK_WORDS.addOne).toBe("Record one with wsp add <folder> here, or wsp add <url> --on <computer> there.");
  });

  it("reads a copy by the word it names its place with, the id or the name alike", () => {
    expect(copyOn([copy("p_1", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("hetzner", 2)], hetzner)?.version).toBe(2);
    expect(copyOn([copy("old-macbook", 2)], hetzner)).toBeUndefined();
  });
});

describe("which row a workspace stands on", () => {
  const on = (id: string, kind: WorkspaceView["kind"], machineId: string, place?: string): WorkspaceView => ({
    id,
    name: id,
    kind,
    machineId,
    phase: "running",
    golden: "",
    createdAt: ago(0),
    project: { id: "pr_1", name: "api", path: "/root/api", computer: place ?? "default" },
    ...(place === undefined ? {} : { place }),
  });

  it("puts a fork on a joined computer on that computer's row", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_a", "cloud", "ctr_1", "p_1"))?.id).toBe("p_1");
  });

  it("puts what runs here on the first row, and a fork at the provider", () => {
    expect(placeOf([here, hetzner, ascii], on("ws_b", "local", "local"))?.id).toBe("here");
    expect(placeOf([here, hetzner, ascii], on("ws_c", "cloud", "fk_1"))?.id).toBe("box");
  });

  it("places nothing where the list holds no row for it", () => {
    expect(placeOf([here], on("ws_d", "cloud", "fk_1"))).toBeUndefined();
    expect(placeOf([here, ascii], on("ws_e", "cloud", "ctr_1", "p_gone"))).toBeUndefined();
  });

});

describe("the state cell of a list row", () => {
  const ready = { kind: "word", word: "Ready" };
  it("says a computer behind this wsp's daemon as Update where the client can ask for one, else as Behind, the protocol's word on the hover", () => {
    const behind = { ...hetzner, daemonVersion: DAEMON_VERSION - 5 };
    expect(placeStateCell(behind, null, { canUpdate: true })).toEqual({ kind: "update", why: placeDaemonBehind(behind) });
    expect(placeStateCell(behind, null, { canUpdate: false })).toEqual({ kind: "word", word: "Behind", why: `daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}` });
  });

  it("says a computer that is not answering first, since nothing can be put on a computer that is off", () => {
    const away = absentComputer("hetzner", 32 * 60 * 1000);
    expect(placeStateCell({ ...hetzner, daemonVersion: DAEMON_VERSION - 5, present: false }, away, { canUpdate: true })).toEqual({ kind: "word", word: "No answer", why: away.sentence });
  });

  it("says a computer that cannot run workspaces is Blocked first, its reason on the hover, before not answering and before behind", () => {
    const blocked = { ...hetzner, daemonVersion: DAEMON_VERSION - 5, blocked: "hetzner cannot run wsp workspaces: it mounts cgroup v1 at /sys/fs/cgroup" };
    expect(placeStateCell(blocked, null, { canUpdate: true })).toEqual({ kind: "word", word: "Blocked", why: blocked.blocked });
    expect(placeStateCell({ ...blocked, present: false }, absentComputer("hetzner", 32 * 60 * 1000), { canUpdate: true })).toEqual({ kind: "word", word: "Blocked", why: blocked.blocked });
  });

  it("offers Sign in where an agent there needs one, naming it, and reads Ready otherwise", () => {
    expect(placeStateCell({ ...hetzner, signIns: { claude: "signed-in", codex: "none" } }, null, { canUpdate: true })).toEqual({ kind: "sign-in", why: "needs a sign-in: Codex" });
    expect(placeStateCell({ ...hetzner, daemonVersion: DAEMON_VERSION }, null, { canUpdate: true })).toEqual(ready);
    expect(placeStateCell(hetzner, null, { canUpdate: false })).toEqual(ready);
    expect(placeStateCell(ascii, null, { canUpdate: false })).toEqual(ready);
  });

  it("reads the recipe after the computer's silence and before the daemon behind: Building with its step, Stopped, Failed", () => {
    const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: "x", startedAt: "x", rows: [], at: { label: "uv", index: 3, of: 7 } };
    const stopped: PlaceProvision = { ...running, state: "stopped", said: "the box went away" };
    const failed: PlaceProvision = { ...running, state: "done", rows: [{ id: "tools/gh", label: "GitHub CLI", outcome: "failed" }] };
    expect(placeStateCell({ ...hetzner, provision: running, daemonVersion: 1 }, null, { canUpdate: true })).toEqual({ kind: "word", word: "Building 3/7", why: "setting up 3/7: uv" });
    expect(placeStateCell({ ...hetzner, provision: stopped }, null, { canUpdate: true })).toEqual({ kind: "word", word: "Stopped", why: "stopped: the box went away" });
    expect(placeStateCell({ ...hetzner, provision: failed }, null, { canUpdate: true })).toEqual({ kind: "word", word: "Failed", why: "1 of 1 failed: GitHub CLI" });
    expect(placeStateCell({ ...laptop, provision: running }, absentComputer("old-macbook", null), { canUpdate: true })).toMatchObject({ word: "No answer" });
  });
});

describe("the word for a row's kind", () => {
  it("names a cloud row cloud where a row's kind is read in a sentence, and a computer of the person's own by what it is", () => {
    expect(PLACE_KIND_WORDS.provider).toBe("cloud");
    expect(PLACE_KIND_WORDS.computer).toBe(JOINED_COMPUTER);
  });

  it("shows a present row's own note, which is where a tool answered from outside the directories its road links into", () => {
    const note = "node answers from /usr/bin/node, outside where its own installer puts it (/usr/local/bin)";
    expect(outcomeWord({ id: "tools/brew/node", label: "node", outcome: "present", note })).toBe(`already there: ${note}`);
    // A present row with nothing to add is the word alone, and an installed row's note is the road's own: the row
    // already says it installed, so the landing's "already on the machine" never reaches a line here.
    expect(outcomeWord({ id: "tools/brew/gh", label: "gh", outcome: "present" })).toBe("already there");
    expect(outcomeWord({ id: "tools/brew/gh", label: "gh", outcome: "installed", note: "already on the machine" })).toBe("installed");
  });

});
