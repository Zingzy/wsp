// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road for a computer that joined another wsp: what the join
// screen asks for turned into the one wsp join every terminal runs, the host
// record the same code buys so the window opens over there, what the two files
// say afterwards, and leaving. The join and the dial are handed in, since a
// real one reaches a host; what this file reads is which refusal a reason
// becomes, that a word which is no address never dials at all, what is written
// on this computer once a join lands, and that leaving takes it all away
// whether or not the wsp over there answered.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { JoinRefused, placeFilePath, readHost } from "@wsp/host";
import { placeFileText, type PlaceReport } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LEFT_ALONE_LINE, NOT_JOINED_LINE, TOKEN_LEFT_LINE, joinRoad, parseJoinAsk, type JoinRoad, type JoinRoadDeps } from "../src/join.js";

const DIRS: string[] = [];
function freshDir(tag: string): string {
  const dir = mkdtempSync(joinPath(tmpdir(), `wsp-${tag}-`));
  DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHIM = "/Users/someone/.wsp/bin/wsp";

/** What this computer told the host about itself on the join frame, which is what the joined screen then reads. */
const REPORT = {
  name: "old-macbook",
  platform: "darwin",
  arch: "arm64",
  os: "Darwin 25.4.0",
  shape: { cpu: 4, memMb: 8192 },
  diskFreeBytes: 97_710_505_984,
  login: {},
  runsWorkspaces: false,
  engine: "none",
  daemonVersion: 1,
  wsp: [SHIM],
  agents: ["claude"],
  dialed: "http://192.168.1.20:4420",
} as unknown as PlaceReport;

const JOINED = {
  placeId: "pl_1",
  hostName: "zingzy-mbp",
  hostUrls: ["http://192.168.1.20:4420"],
  report: REPORT,
  device: { deviceId: "d_1", deviceToken: "tok_1" },
};

type JoinArgs = Parameters<NonNullable<JoinRoadDeps["join"]>>[1];

/** A join that never happened, standing in for the one that dials: it records what it was handed and answers what
 * the case is about. */
function fakeJoin(answer: typeof JOINED | Error | { silent: true }): { asks: JoinArgs[]; join: NonNullable<JoinRoadDeps["join"]> } {
  const asks: JoinArgs[] = [];
  const join: NonNullable<JoinRoadDeps["join"]> = (io, opts) => {
    asks.push(opts);
    if (answer instanceof Error) return Promise.reject(answer);
    io.log("the launchd unit is loaded; it dials again at every login");
    const { device, ...rest } = JOINED;
    return Promise.resolve("silent" in answer ? rest : answer);
  };
  return { asks, join };
}

/** The place file a join of the app's own leaves behind. */
function standAsJoined(home: string, awake = false): void {
  const file = placeFilePath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    placeFileText({
      placeId: "pl_1",
      name: "old-macbook",
      hostName: "zingzy-mbp",
      hostUrls: ["http://192.168.1.20:4420"],
      hostPublicKey: Buffer.alloc(32).toString("base64"),
      keyPath: joinPath(home, ".wsp", "place-key.pem"),
      joinedAt: new Date(0).toISOString(),
      awake,
    }),
  );
}

interface Shell {
  road: JoinRoad;
  home: string;
  wspHome: string;
  said: string[];
  asked: Array<{ op: string; params?: Record<string, unknown> }>;
  disconnected: string[][];
  swept: string[];
}

/** The road as the shell builds it, with the join, the dial, the hand back and the local sweep all faked. */
function shell(
  given: { join?: NonNullable<JoinRoadDeps["join"]>; request?: (op: string) => Promise<Record<string, unknown>>; disconnect?: () => Promise<number> } = {},
): Shell {
  const home = freshDir("join-home");
  const wspHome = freshDir("join-wsp");
  const said: string[] = [];
  const asked: Array<{ op: string; params?: Record<string, unknown> }> = [];
  const disconnected: string[][] = [];
  const swept: string[] = [];
  const road = joinRoad({
    home,
    wspHome,
    statePath: joinPath(wspHome, "state.json"),
    shim: SHIM,
    log: line => said.push(line),
    join: given.join ?? fakeJoin(JOINED).join,
    dial: () =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, ...(params === undefined ? {} : { params }) });
          return (given.request ?? ((_op: string) => Promise.resolve({ removed: true, swept: ["the launchd unit"] })))(op);
        },
        close: () => {},
      } as never),
    disconnect: (_io, _opts, args) => {
      disconnected.push([...args]);
      return (given.disconnect ?? (() => Promise.resolve(0)))();
    },
    leave: (at: string) => {
      swept.push(at);
      rmSync(placeFilePath(at), { force: true });
      return Promise.resolve(["the place file", "the key"]);
    },
  });
  return { road, home, wspHome, said, asked, disconnected, swept };
}

describe("the road a computer that joined another wsp runs on", () => {
  it("dials the address a person typed as an http one, with the code as the host takes it and the app's own wsp as the line the service runs, and buys the token this window holds", async () => {
    const fake = fakeJoin(JOINED);
    const road = shell({ join: fake.join });
    const answer = await road.road.join({ address: " 192.168.1.20:4420 ", code: "qw4k-7pzx" });
    expect(fake.asks).toHaveLength(1);
    expect(fake.asks[0]).toMatchObject({ home: road.home, addresses: ["http://192.168.1.20:4420"], code: "QW4K7PZX", client: true, wsp: expect.objectContaining({ shim: SHIM }) });
    // The joined screen's card: this computer's name, its shape and disk in the app's own words, and whether it
    // forks, all off the report the join frame carried rather than a second read of this computer.
    expect(answer).toEqual({ ok: true, here: { name: "old-macbook", facts: "4 cores · 8 GB · 91 GB free".replace(/ /g, "\u00a0"), runsWorkspaces: false } });
  });

  it("writes the host record the window opens on, named after the wsp it joined and reached the way it was reached", async () => {
    const road = shell();
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    const record = readHost(road.wspHome, "192.168.1.20");
    expect(record).toMatchObject({ url: "http://192.168.1.20:4420", deviceId: "d_1", deviceToken: "tok_1", label: "zingzy-mbp", road: "direct" });
    // A computer that was paired with nothing takes the wsp it joined as the one every wsp line on it runs against.
    expect(readFileSync(joinPath(road.wspHome, "hosts", "default"), "utf8").trim()).toBe("192.168.1.20");
  });

  it("leaves a default that was already set where it is, since the person named it", async () => {
    const road = shell();
    mkdirSync(joinPath(road.wspHome, "hosts"), { recursive: true });
    writeFileSync(joinPath(road.wspHome, "hosts", "box.json"), JSON.stringify({ url: "http://box:4400", deviceId: "d_0", deviceToken: "tok_0", pairedAt: new Date(0).toISOString() }));
    writeFileSync(joinPath(road.wspHome, "hosts", "default"), "box\n");
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    expect(readFileSync(joinPath(road.wspHome, "hosts", "default"), "utf8").trim()).toBe("box");
  });

  it("writes no host record for a join that bought no token, so the window stays on this computer", async () => {
    const road = shell({ join: fakeJoin({ silent: true }).join });
    expect(await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" })).toMatchObject({ ok: true });
    expect(readHost(road.wspHome, "192.168.1.20")).toBeUndefined();
    expect(road.road.alias()).toBeUndefined();
  });

  it("refuses a word that is no address without dialling anything", async () => {
    const fake = fakeJoin(JOINED);
    for (const word of ["box", "", "ws://192.168.1.20:4420", "192.168.1.20"]) {
      const road = shell({ join: fake.join });
      expect(await road.road.join({ address: word, code: "QW4K7PZX" })).toEqual({ ok: false, why: "address" });
    }
    expect(fake.asks).toEqual([]);
  });

  it("refuses a computer that already runs threads for another wsp, in its own words rather than the join's", async () => {
    const fake = fakeJoin(JOINED);
    const road = shell({ join: fake.join });
    standAsJoined(road.home);
    expect(await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" })).toEqual({ ok: false, why: "already" });
    expect(fake.asks).toEqual([]);
  });

  it("puts each refusal where the screen has a slot for it: the address, the code, and everything else", async () => {
    const cases = [
      { threw: new JoinRefused("address", "http://192.168.1.20:4420 could not be reached: connect ECONNREFUSED"), why: "answer" },
      { threw: new JoinRefused("code", "that join code is not one this host is waiting for"), why: "code" },
      { threw: new Error("the host at http://192.168.1.20:4420 did not prove the key this computer learned at join"), why: "shell" },
    ];
    for (const one of cases) {
      const road = shell({ join: fakeJoin(one.threw).join });
      expect(await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" })).toEqual({ ok: false, why: one.why, said: one.threw.message });
      expect(readHost(road.wspHome, "192.168.1.20")).toBeUndefined();
    }
  });

  it("reads what this computer is to that wsp off the two files it wrote, and names the record only while both stand", async () => {
    const road = shell();
    expect(road.road.standing()).toBeUndefined();
    expect(road.road.alias()).toBeUndefined();
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    standAsJoined(road.home);
    expect(road.road.standing()).toEqual({
      hostName: "zingzy-mbp",
      hostUrl: "http://192.168.1.20:4420",
      alias: "192.168.1.20",
      joinedAt: new Date(0).toISOString(),
      awake: false,
    });
    expect(road.road.alias()).toBe("192.168.1.20");
    rmSync(joinPath(road.wspHome, "hosts", "192.168.1.20.json"));
    // The place file still stands, so this computer still runs threads over there; the window has nothing to open on.
    expect(road.road.standing()).toMatchObject({ hostName: "zingzy-mbp" });
    expect(road.road.alias()).toBeUndefined();
  });

  it("holds this computer out of idle sleep by writing the file the agent watches, and says so", async () => {
    const road = shell();
    standAsJoined(road.home);
    expect(await road.road.setAwake(true)).toMatchObject({ awake: true, hostName: "zingzy-mbp" });
    expect(road.road.standing()?.awake).toBe(true);
    expect(await road.road.setAwake(false)).toMatchObject({ awake: false });
  });

  it("leaves by asking the wsp over there to remove this computer, then handing its token back", async () => {
    const road = shell();
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    standAsJoined(road.home);
    expect(await road.road.leave()).toEqual({ ok: true });
    expect(road.asked).toEqual([{ op: "places.remove", params: { placeId: "pl_1" } }]);
    expect(road.disconnected).toEqual([["192.168.1.20"]]);
    expect(road.road.standing()).toBeUndefined();
  });

  it("leaves on its own when the wsp over there does not answer, and says it still lists this computer", async () => {
    const road = shell({ request: () => Promise.reject(new Error("connect ECONNREFUSED 192.168.1.20:4420")) });
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    standAsJoined(road.home);
    expect(await road.road.leave()).toEqual({ ok: false, at: "url", error: LEFT_ALONE_LINE });
    expect(road.swept).toEqual([road.home]);
    expect(road.road.standing()).toBeUndefined();
    // The record is a road to a wsp this computer has left, and the mark that every line on it takes that road;
    // both go, since nothing over there is this computer's to reach any more.
    expect(readHost(road.wspHome, "192.168.1.20")).toBeUndefined();
    expect(existsSync(joinPath(road.wspHome, "hosts", "default"))).toBe(false);
  });

  it("says the token is the one thing left over there when the removal landed and the hand back did not", async () => {
    const road = shell({ disconnect: () => Promise.reject(new Error("connect ECONNREFUSED 192.168.1.20:4420")) });
    await road.road.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    standAsJoined(road.home);
    // The wsp over there took the removal, so telling the person it was never told would be false; what stands is
    // the token, and only its person can take that away.
    expect(await road.road.leave()).toEqual({ ok: false, at: "url", error: TOKEN_LEFT_LINE });
    expect(road.asked).toEqual([{ op: "places.remove", params: { placeId: "pl_1" } }]);
    expect(road.road.standing()).toBeUndefined();
    expect(readHost(road.wspHome, "192.168.1.20")).toBeUndefined();
  });

  it("says there is nothing to leave on a computer that is in no wsp", async () => {
    const road = shell();
    expect(await road.road.leave()).toEqual({ ok: false, at: "url", error: NOT_JOINED_LINE });
    expect(road.asked).toEqual([]);
  });

  it("takes only the join screen's own shape off the wire", () => {
    expect(parseJoinAsk({ address: "192.168.1.20:4420", code: "QW4K7PZX" })).toEqual({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    for (const raw of [null, undefined, "192.168.1.20:4420", { address: "192.168.1.20:4420" }, { address: 1, code: "QW4K7PZX" }, { address: "a".repeat(201), code: "x" }]) {
      expect(parseJoinAsk(raw)).toBeUndefined();
    }
  });
});
