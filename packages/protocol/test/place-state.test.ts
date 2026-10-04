// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  AGENTS_ON,
  CLOUD_CAP_DEFAULT,
  DAEMON_VERSION,
  HERE_PLACE_ID,
  NAP_AFTER_MS,
  PLACE_BLOCKED_WORD,
  PlaceView,
  absentComputer,
  placeCapOf,
  placeSetRefusal,
  placeSettingsLine,
  placeTakes,
  settingFor,
  napMsOf,
  placeRoom,
  placeSpendLimit,
  placeStateOf,
  runningOn,
  SPEND_LIMIT_LINE,
  spendCapRefusal,
  threadsAtOnce,
  type PlaceSetup,
} from "@wsp/protocol";

const spoo: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: false, shape: { cpu: 2, memMb: 7885 }, daemonVersion: DAEMON_VERSION, cap: { threads: 2 }, running: 0 };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, cap: { machines: 3, spendPerDayUsd: 10 }, running: 0 };

describe("threads at once", () => {
  it("reads one thread per 2.5 GB, rounded to the nearest, at least one and never more than the cores", () => {
    expect(threadsAtOnce({ cpu: 2, memMb: 4096 })).toBe(2);
    expect(threadsAtOnce({ cpu: 4, memMb: 8192 })).toBe(3);
    expect(threadsAtOnce({ cpu: 10, memMb: 16384 })).toBe(6);
    expect(threadsAtOnce({ cpu: 2, memMb: 8192 })).toBe(2);
    expect(threadsAtOnce({ cpu: 2, memMb: 7885 })).toBe(2);
    expect(threadsAtOnce({ cpu: 1, memMb: 1024 })).toBe(1);
  });

  it("gives a computer its rule's default off its shape, a cloud 3 machines and $10 a day, and a set number over either", () => {
    expect(placeCapOf({ kind: "computer", shape: { cpu: 10, memMb: 16384 } })).toEqual({ threads: 6 });
    expect(placeCapOf({ kind: "computer" })).toBeUndefined();
    expect(placeCapOf({ kind: "computer" }, { threads: 1 })).toEqual({ threads: 1 });
    expect(placeCapOf({ kind: "computer", shape: { cpu: 2, memMb: 7885 } }, { threads: 1 })).toEqual({ threads: 1 });
    expect(CLOUD_CAP_DEFAULT).toEqual({ machines: 3, spendPerDayUsd: 10 });
    expect(placeCapOf({ kind: "provider" })).toEqual({ machines: 3, spendPerDayUsd: 10 });
    expect(placeCapOf({ kind: "provider" }, { machines: 5 })).toEqual({ machines: 5, spendPerDayUsd: 10 });
    expect(placeCapOf({ kind: "provider" }, { spendPerDayUsd: 0 })).toEqual({ machines: 3, spendPerDayUsd: 0 });
  });

  it("refuses a number the row's kind does not take, set or reset, a set with nothing in it, one key both set and reset, and counts below one", () => {
    expect(placeSetRefusal({ kind: "computer", name: "spoo" }, { machines: 2 })).toBe("spoo takes threads at once, agents may start agents and levels deep, not machines at once");
    expect(placeSetRefusal({ kind: "provider", name: "solari", takesForks: true }, { threads: 2 })).toBe("solari takes machines at once, spend per day, nap after, agents may start agents and levels deep, not threads at once");
    expect(placeSetRefusal({ kind: "computer", name: "mac", takesForks: false }, { napMs: null })).toBe("mac takes threads at once, agents may start agents and levels deep, not nap after");
    expect(placeSetRefusal({ kind: "computer", name: "spoo", takesForks: true }, { napMs: null })).toBeUndefined();
    expect(placeSetRefusal({ kind: "computer", name: "spoo", takesForks: false }, {}, ["spend"])).toBe("spoo takes threads at once, agents may start agents and levels deep, not spend per day");
    expect(placeSetRefusal({ kind: "computer", name: "spoo" }, { threads: 1 })).toBeUndefined();
    expect(placeSetRefusal({ kind: "provider", name: "solari", takesForks: true }, { spendPerDayUsd: 0 })).toBeUndefined();
    expect(placeSetRefusal({ kind: "computer", name: "spoo" }, {}, ["threads"])).toBeUndefined();
    expect(placeSetRefusal({ kind: "computer", name: "spoo", takesForks: true }, {})).toBe("nothing to set on spoo: it takes threads at once, nap after, agents may start agents and levels deep");
    expect(placeSetRefusal({ kind: "provider", name: "solari", takesForks: true }, { machines: undefined }, [])).toBe("nothing to set on solari: it takes machines at once, spend per day, nap after, agents may start agents and levels deep");
    expect(placeSetRefusal({ kind: "computer", name: "spoo" }, { threads: 2 }, ["threads"])).toBe("spoo: threads at once is both set and reset; name it once");
    expect(() => PlaceView.shape.cap.parse({ threads: 0 })).toThrow();
    expect(() => PlaceView.shape.cap.parse({ machines: 0, spendPerDayUsd: 10 })).toThrow();
    expect(PlaceView.shape.cap.parse({ machines: 1, spendPerDayUsd: 0 })).toEqual({ machines: 1, spendPerDayUsd: 0 });
  });
});

describe("what a place's settings read as in a line", () => {
  it("says each setting its kind takes at the value it runs at, with the default beside one the person set", () => {
    expect(placeSettingsLine({ ...spoo, capDefault: { threads: 2 } })).toBe("spoo: 2 threads at once (the default)");
    expect(placeSettingsLine({ ...spoo, cap: { threads: 1 }, capDefault: { threads: 2 }, settings: { threads: 1 } })).toBe("spoo: 1 thread at once (2 by default)");
    const nap = { takesForks: true, napDefault: NAP_AFTER_MS };
    expect(placeSettingsLine({ ...spoo, ...nap, capDefault: { threads: 2 }, napMs: NAP_AFTER_MS })).toBe("spoo: 2 threads at once (the default), naps after 20m (the default)");
    expect(placeSettingsLine({ ...spoo, ...nap, capDefault: { threads: 2 }, napMs: null, settings: { napMs: null } })).toBe("spoo: 2 threads at once (the default), never naps (20m by default)");
    expect(placeSettingsLine({ ...spoo, ...nap, capDefault: { threads: 2 }, napMs: 5 * 60_000, settings: { napMs: 5 * 60_000 } })).toBe("spoo: 2 threads at once (the default), naps after 5m (20m by default)");
    // The default beside a set value is the one the row carries, which is the host's own and not a constant here.
    expect(placeSettingsLine({ ...spoo, takesForks: true, napDefault: 60 * 60_000, capDefault: { threads: 2 }, napMs: 5 * 60_000, settings: { napMs: 5 * 60_000 } })).toBe("spoo: 2 threads at once (the default), naps after 5m (60m by default)");
    expect(placeSettingsLine({ ...solari, cap: { machines: 5, spendPerDayUsd: 2.5 }, capDefault: CLOUD_CAP_DEFAULT, settings: { machines: 5, spendPerDayUsd: 2.5 } })).toBe("solari: 5 machines at once (3 by default), $2.50 a day ($10 by default)");
    expect(NAP_AFTER_MS).toBe(20 * 60_000);
    expect(placeSettingsLine({ ...spoo, capDefault: { threads: 2 }, spawn: AGENTS_ON, spawnDefault: AGENTS_ON })).toBe("spoo: 2 threads at once (the default), agents may spawn: up to 3 workspaces (the default), 2 levels deep (the default)");
    expect(placeSettingsLine({ ...spoo, capDefault: { threads: 2 }, spawn: { ...AGENTS_ON, spawn: false }, spawnDefault: AGENTS_ON, settings: { spawn: { spawn: false } } })).toBe("spoo: 2 threads at once (the default), agents may not spawn (on, up to 3 by default), 2 levels deep (the default)");
  });
});

describe("one rule for each setting", () => {
  it("runs a workspace under its own value, else its place's, else the default, a value that is off included", () => {
    expect(settingFor(5, 10, 20)).toBe(5);
    expect(settingFor(null, 10, 20)).toBeNull();
    expect(settingFor(undefined, null, 20)).toBeNull();
    expect(settingFor(undefined, 10, 20)).toBe(10);
    expect(settingFor<number | null>(undefined, undefined, 20)).toBe(20);
  });

  it("turns the minutes a person names into the window, none of them never napping", () => {
    expect(napMsOf(0)).toBeNull();
    expect(napMsOf(45)).toBe(2_700_000);
  });

  it("says which settings a place takes, the nap only where it forks", () => {
    expect(placeTakes({ kind: "computer", takesForks: false }, "nap")).toBe(false);
    expect(placeTakes({ kind: "computer", takesForks: true }, "nap")).toBe(true);
    expect(placeTakes({ kind: "computer", takesForks: false }, "spawn")).toBe(true);
    expect(placeTakes({ kind: "provider", takesForks: true }, "threads")).toBe(false);
  });
});

describe("what runs on a place", () => {
  const places = [
    { id: HERE_PLACE_ID, kind: "computer" as const },
    { id: "p_1", kind: "computer" as const },
    { id: "solari", kind: "provider" as const },
  ];
  const workspaces = [
    { id: "w_mac", kind: "local" as const, machineId: "local", phase: "running" as const },
    { id: "w_box", kind: "cloud" as const, machineId: "m_1", place: "p_1", phase: "running" as const },
    { id: "w_s1", kind: "cloud" as const, machineId: "s_1", provider: "solari", phase: "running" as const },
    { id: "w_s2", kind: "cloud" as const, machineId: "s_2", provider: "solari", phase: "napping" as const },
    { id: "w_s3", kind: "cloud" as const, machineId: "s_3", provider: "solari", phase: "gone" as const },
    { id: "w_s4", kind: "cloud" as const, machineId: "s_4", provider: "solari", phase: "waking" as const },
  ];
  const threads = [
    { workspaceId: "w_mac", status: "running" as const },
    { workspaceId: "w_mac", status: "running" as const },
    { workspaceId: "w_mac", status: "completed" as const },
    { workspaceId: "w_box", status: "running" as const },
    { workspaceId: "w_box", status: "failed" as const },
    { workspaceId: "w_s1", status: "running" as const },
  ];

  it("counts running threads on a computer and machines holding a slot on a cloud", () => {
    expect(runningOn(HERE_PLACE_ID, places, workspaces, threads)).toBe(2);
    expect(runningOn("p_1", places, workspaces, threads)).toBe(1);
    // A napping machine and a gone one hold no slot; a waking one does.
    expect(runningOn("solari", places, workspaces, threads)).toBe(2);
    expect(runningOn("nowhere", places, workspaces, threads)).toBe(0);
  });

  it("reads the room left under the cap, never below none", () => {
    expect(placeRoom({ ...spoo, running: 1 })).toEqual({ running: 1, atOnce: 2, room: 1, noun: "thread" });
    expect(placeRoom({ ...spoo, running: 3 })).toEqual({ running: 3, atOnce: 2, room: 0, noun: "thread" });
    expect(placeRoom({ ...solari, running: 2 })).toEqual({ running: 2, atOnce: 3, room: 1, noun: "machine" });
    expect(placeRoom({ ...spoo, cap: undefined })).toBeUndefined();
  });
});

describe("the word a place's row says", () => {
  const running: PlaceSetup = { state: "running", addId: "a_1", startedAt: "2026-09-17T10:01:00.000Z", steps: [{ step: "agents", state: "running" }], waiting: [] };

  it("reads Ready when nothing stands in the way", () => {
    expect(placeStateOf(spoo, null)).toEqual({ word: "Ready" });
    expect(placeStateOf(solari, null)).toEqual({ word: "Ready" });
  });

  it("reads Full once the count meets the cap, with the count in the sentence", () => {
    expect(placeStateOf({ ...spoo, running: 2 }, null)).toEqual({ word: "Full", tone: "warning", sentence: "full: 2 of 2 threads running" });
    expect(placeStateOf({ ...solari, running: 3 }, null)).toEqual({ word: "Full", tone: "warning", sentence: "full: 3 of 3 machines running" });
    expect(placeStateOf({ ...spoo, cap: { threads: 1 }, running: 1 }, null).sentence).toBe("full: 1 of 1 thread running");
  });

  it("reads Full for a computer with no room under its cap, and keeps no room in the sentence", () => {
    expect(placeStateOf({ ...spoo, running: 1, forks: { running: 1, room: 0 } }, null)).toEqual({ word: "Full", tone: "warning", sentence: "no room on spoo" });
  });

  it("reads At limit only with a spend figure, and never answers it without one", () => {
    const spent = { ...solari, cap: { machines: 3, spendPerDayUsd: 10 } };
    expect(placeStateOf(spent, null).word).toBe("Ready");
    expect(placeStateOf(spent, null, 9.99).word).toBe("Ready");
    expect(placeStateOf(spent, null, 10)).toEqual({ word: "At limit", tone: "warning", sentence: "spend limit reached today" });
    // A $0 limit is a cloud that starts nothing today.
    expect(placeStateOf({ ...solari, cap: { machines: 3, spendPerDayUsd: 0 } }, null, 0).word).toBe("At limit");
    // A computer has no spend limit whatever figure is handed in.
    expect(placeStateOf(spoo, null, 100).word).toBe("Ready");
  });

  it("reads a spend limit only off a cloud's cap, and the refusal opens with the row's own sentence", () => {
    expect(placeSpendLimit(solari)).toBe(10);
    expect(placeSpendLimit({ ...solari, cap: { machines: 3, spendPerDayUsd: 0 } })).toBe(0);
    expect(placeSpendLimit(spoo)).toBeUndefined();
    expect(placeSpendLimit({ ...solari, cap: undefined })).toBeUndefined();
    expect(placeStateOf(solari, null, 10).sentence).toBe(SPEND_LIMIT_LINE);
    expect(spendCapRefusal("solari", 10.02, 10)).toBe(`${SPEND_LIMIT_LINE} on solari ($10.02/$10); raise its spend per day or start the machine after midnight`);
  });

  it("puts blocked, then not answering, then At limit, then Full, then the setup running, then behind", () => {
    const all: PlaceView = { ...solari, blocked: "no overlay", running: 3, setup: running, daemonVersion: DAEMON_VERSION - 1 };
    const away = absentComputer("solari", null);
    expect(placeStateOf(all, away, 20)).toEqual({ word: PLACE_BLOCKED_WORD, sentence: "no overlay" });
    const { blocked: _b, ...unblocked } = all;
    expect(placeStateOf(unblocked, away, 20)).toEqual({ word: away.away, sentence: away.sentence });
    expect(placeStateOf(unblocked, null, 20).word).toBe("At limit");
    expect(placeStateOf(unblocked, null).word).toBe("Full");
    expect(placeStateOf({ ...unblocked, running: 0 }, null)).toEqual({ word: "Setting up", sentence: "setting up the agents" });
    // A setup that waits on the person, or failed, wins over the spend and the cap: nothing new runs there until it is through.
    expect(placeStateOf({ ...unblocked, setup: { ...running, state: "failed", said: "no agent installed" } }, null, 20)).toEqual({ word: "Setup failed", sentence: "no agent installed" });
    const { setup: _s, ...settled } = unblocked;
    expect(placeStateOf({ ...settled, running: 0 }, null).word).toBe(`daemon ${DAEMON_VERSION - 1}, host ${DAEMON_VERSION}`);
  });
});
