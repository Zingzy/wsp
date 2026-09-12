// SPDX-License-Identifier: AGPL-3.0-only
// The shell's join road: what the join screen asks for, turned into the one
// wsp join every terminal runs, and its answer turned back into what the
// screen draws. The join itself is handed in here, since a real one dials a
// host; what this file reads is which refusal a reason becomes, that a word
// which is no address never dials at all, and that the facts the joined screen
// shows are this computer's own row.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { JoinRefused, placeFilePath } from "@wsp/host";
import { placeFileText } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { joinWsp } from "../src/join.js";

const HOMES: string[] = [];
function freshHome(): string {
  const home = mkdtempSync(joinPath(tmpdir(), "wsp-join-"));
  HOMES.push(home);
  return home;
}

afterEach(() => {
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** This computer as the host's own row for it reads, so the road is driven without reading the Mac it runs on. */
const HERE = { name: "old-macbook", os: "Darwin 25.4.0", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 97_710_505_984, docker: false };
const here = (): typeof HERE => HERE;

const ARGV = ["/Users/someone/.wsp/bin/wsp", "join", "--serve"];

/** A join that never happened, standing in for the one that dials: it records what it was handed and answers what
 * the case is about. */
function fakeJoin(answer: number | Error): { calls: Array<{ args: readonly string[]; code?: string; home?: string; argv?: string[] }>; join: (io: { log(l: string): void; error(l: string): void }, args: readonly string[], flags: { code?: string }, given?: { home?: string; argv?: () => string[] }) => Promise<number> } {
  const calls: Array<{ args: readonly string[]; code?: string; home?: string; argv?: string[] }> = [];
  return {
    calls,
    join: (io, args, flags, given) => {
      calls.push({ args, ...(flags.code !== undefined ? { code: flags.code } : {}), ...(given?.home !== undefined ? { home: given.home } : {}), ...(given?.argv !== undefined ? { argv: given.argv() } : {}) });
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer !== 0) io.error("wsp join: launchd would not load the agent");
      return Promise.resolve(answer);
    },
  };
}

type Road = Parameters<typeof joinWsp>[1];
const road = (home: string, join: Road["join"]): Road => ({ home, argv: ARGV, join, here: here as Road["here"] });

describe("the join behind the first launch's join screen", () => {
  it("dials the address a person typed as an http one, with the code as the host takes it and the app's own wsp as the line the service runs", async () => {
    const home = freshHome();
    const fake = fakeJoin(0);
    const answer = await joinWsp({ address: " 192.168.1.20:7788 ", code: "QW4K7PZX" }, road(home, fake.join as Road["join"]));
    expect(fake.calls).toEqual([{ args: ["http://192.168.1.20:7788"], code: "QW4K7PZX", home, argv: ARGV }]);
    // The joined screen's card: this computer's name, its shape and disk in the app's own words, and whether it forks.
    // The facts are one phrase about one computer, so the words in it are joined by no-break spaces.
    expect(answer).toEqual({ ok: true, here: { name: "old-macbook", facts: "4 cores · 8 GB · 91 GB free".replace(/ /g, "\u00a0"), docker: false } });
  });

  it("refuses a word that is no address without dialling anything", async () => {
    const fake = fakeJoin(0);
    for (const word of ["box", "", "ws://192.168.1.20:7788", "192.168.1.20"]) {
      expect(await joinWsp({ address: word, code: "QW4K7PZX" }, road(freshHome(), fake.join as Road["join"]))).toEqual({ ok: false, why: "address" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a computer that already runs threads for another wsp, in its own words rather than the join's", async () => {
    const home = freshHome();
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      placeFileText({
        placeId: "pl_1",
        name: "old-macbook",
        hostName: "zingzy-mbp",
        hostUrls: ["http://192.168.1.9:7788"],
        hostPublicKey: Buffer.alloc(32).toString("base64"),
        keyPath: `${home}/.wsp/place-key.pem`,
        joinedAt: new Date(0).toISOString(),
        awake: false,
      }),
    );
    const fake = fakeJoin(0);
    expect(await joinWsp({ address: "192.168.1.20:7788", code: "QW4K7PZX" }, road(home, fake.join as Road["join"]))).toEqual({ ok: false, why: "already" });
    expect(fake.calls).toEqual([]);
  });

  it("puts each refusal where the screen has a slot for it: the address, the code, and everything else", async () => {
    const cases = [
      { threw: new JoinRefused("address", "http://192.168.1.20:7788 could not be reached: connect ECONNREFUSED"), why: "answer" },
      { threw: new JoinRefused("code", "that join code is not one this host is waiting for"), why: "code" },
      { threw: new Error("the host at http://192.168.1.20:7788 did not prove the key this computer learned at join"), why: "shell" },
    ];
    for (const one of cases) {
      const fake = fakeJoin(one.threw);
      expect(await joinWsp({ address: "192.168.1.20:7788", code: "QW4K7PZX" }, road(freshHome(), fake.join as Road["join"]))).toEqual({ ok: false, why: one.why, said: one.threw.message });
    }
    // A join that wrote its files and then could not be kept running exits non-zero with its own words, and those
    // are what the slot's title carries.
    const refused = fakeJoin(1);
    expect(await joinWsp({ address: "192.168.1.20:7788", code: "QW4K7PZX" }, road(freshHome(), refused.join as Road["join"]))).toEqual({
      ok: false,
      why: "shell",
      said: "wsp join: launchd would not load the agent",
    });
  });
});
