// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { execFile, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { configHardLinkRefusal, PLACE_DOOR_UNSERVED, doorPortHeldLine, joinToken, placeDaemonPaths, placeOwnedPaths, shellQuote, workFolderIn, type PlaceDoorView } from "@wsp/protocol";
import { SSH_LINE_CAP, keyFingerprint } from "@wsp/engine";
import { ADD_FOUND_END, ADD_TAKEN_LINE, DAEMON_GONE_LINE, addFound, addFoundScript, addUndoScript, joinedAddWrites, joinedPlace, profileSourceLine } from "../src/doctor.js";
import { refusedPort } from "../../runtime/test/held-port.js";
import { addCommand, placeHeldRefusal, reachScript, reachedUrls, unreachedLine, hostKeyHere, placeUnit } from "../src/places.js";
import { heldPlaceScript } from "@wsp/protocol";
import { captured } from "./verbs-fixture.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { fakeRunner, noBoxSignIn, opts, sweepPlace, tmp } from "./places-fixture.js";

describe("what a failed add takes back off a box, run by a real shell", () => {
  const bash = (script: string): string => execFileSync("/bin/bash", ["-c", script], { encoding: "utf8" });

  /** Everything a joined add lays down under the home, as the deploy and the join on that box write it. */
  function wroteTheAdd(home: string): void {
    const at = placeDaemonPaths(home);
    mkdirSync(join(at.dir, "x86_64"), { recursive: true });
    writeFileSync(join(at.dir, "x86_64", "wsp-daemon"), "");
    writeFileSync(at.bundle, "");
    mkdirSync(at.inbox, { recursive: true });
    writeFileSync(at.tokenPath, "t");
    writeFileSync(at.profileFile, "");
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(join(at.binDir, "wsp-open"), "");
    symlinkSync(join(at.binDir, "wsp-open"), join(at.binDir, "xdg-open"));
    mkdirSync(at.unitDir, { recursive: true });
    appendFileSync(join(home, ".profile"), `${profileSourceLine(at.profileFile)}\n`);
    writeFileSync(at.placeFile, "{}");
    writeFileSync(at.placeKey, "k");
    writeFileSync(at.placeLog, "");
    writeFileSync(at.placeFound, "");
    mkdirSync(workFolderIn(home), { recursive: true });
  }

  /** The add's writes under this home alone: the unit and the workspace profile are the box's, and no test writes /etc. */
  function underHome(home: string): { place: ReturnType<typeof joinedPlace>; writes: ReturnType<typeof joinedAddWrites> } {
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    return { place, writes: joinedAddWrites(place, "/nonexistent/wsp-place.service").filter(w => w.path.startsWith(`${home}/`)) };
  }

  it("takes what the add wrote and leaves every file and folder the home held before it", () => {
    const home = tmp("undo-held");
    const at = placeDaemonPaths(home);
    // Their own bin folder with a tool in it, their login file, and a wsp folder a host on this login keeps its state in.
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(join(at.binDir, "mytool"), "#!/bin/sh\n");
    writeFileSync(join(home, ".profile"), "export EDITOR=vi\n");
    mkdirSync(at.wsp, { recursive: true });
    writeFileSync(join(at.wsp, "state.json"), "{}\n");
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    expect(bash(addUndoScript(place, writes, found, "true", true))).toContain(DAEMON_GONE_LINE);
    expect(readdirSync(at.wsp)).toEqual(["state.json"]);
    expect(readdirSync(at.binDir)).toEqual(["mytool"]);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("export EDITOR=vi\n");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(workFolderIn(home))).toBe(false);
  });

  it("leaves a home that held nothing of the add's as bare as it found it", () => {
    const home = tmp("undo-bare");
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    bash(addUndoScript(place, writes, found, "true", true));
    expect(readdirSync(home)).toEqual([]);
  });

  it("says the undo did not finish, and keeps the record's road, where a removal failed", () => {
    const home = tmp("undo-stuck");
    const at = placeDaemonPaths(home);
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    chmodSync(at.wsp, 0o555);
    try {
      expect(bash(`${addUndoScript(place, writes, found, "true", true)} || true`)).not.toContain(DAEMON_GONE_LINE);
      expect(existsSync(at.placeFile)).toBe(true);
    } finally {
      chmodSync(at.wsp, 0o755);
    }
  });

  it("never follows a folder of the add's that was swapped for a link after the read", () => {
    const home = tmp("undo-swapped");
    const at = placeDaemonPaths(home);
    const { place, writes } = underHome(home);
    const found = addFound(bash(addFoundScript(place, writes, "systemctl")), writes.length)!;
    wroteTheAdd(home);
    const elsewhere = tmp("undo-swapped-elsewhere");
    mkdirSync(join(elsewhere, posix.basename(at.dir)), { recursive: true });
    writeFileSync(join(elsewhere, posix.basename(at.dir), "precious"), "");
    writeFileSync(join(elsewhere, posix.basename(at.placeFile)), "{}");
    writeFileSync(join(elsewhere, "keep"), "");
    rmSync(at.wsp, { recursive: true });
    symlinkSync(elsewhere, at.wsp);
    expect(bash(`${addUndoScript(place, writes, found, "true", true)} || true`)).not.toContain(DAEMON_GONE_LINE);
    expect(readdirSync(elsewhere).sort()).toEqual([posix.basename(at.dir), posix.basename(at.placeFile), "keep"].sort());
    expect(readdirSync(join(elsewhere, posix.basename(at.dir)))).toEqual(["precious"]);
  });

  it("takes nothing where another add completed on the box after this add read it bare and failed before its join", () => {
    const home = tmp("undo-raced-b");
    const { place, writes } = underHome(home);
    // B reads a bare box, then A's add completes, then B's deploy fails at the files step.
    const found = addFound(bash(addFoundScript(place, writes, "false")), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    const before = execFileSync("/usr/bin/find", [home], { encoding: "utf8" });
    const said = bash(addUndoScript(place, writes, found, "false", false));
    expect(said).toContain(ADD_TAKEN_LINE);
    expect(said).not.toContain(DAEMON_GONE_LINE);
    expect(execFileSync("/usr/bin/find", [home], { encoding: "utf8" })).toBe(before);
  });

  it("says the undo did not finish while a unit this add wrote fresh still runs", () => {
    const home = tmp("undo-fresh-unit");
    const state = tmp("undo-fresh-unit-state");
    // A systemctl that keeps active and enabled as files, and refuses disable --now.
    const systemctl = join(tmp("undo-fresh-unit-bin"), "systemctl");
    const refusing = `#!/bin/sh\nS=${shellQuote(state)}\ncase "$1" in\n  is-active) [ -f "$S/active-$3" ];;\n  is-enabled) [ -f "$S/enabled-$3" ];;\n  stop) rm -f "$S/active-$2";;\n  disable) [ "$2" = --now ] && exit 1; rm -f "$S/enabled-$2";;\n  *) exit 0;;\nesac\n`;
    writeStub(systemctl, refusing);
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    const unitPath = join(home, ".config/systemd/user/wsp-place.service");
    const writes = joinedAddWrites(place, unitPath).filter(w => w.path.startsWith(`${home}/`));
    const found = addFound(bash(addFoundScript(place, writes, systemctl)), writes.length)!;
    expect(found.size).toBe(0);
    wroteTheAdd(home);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "[Service]\n");
    writeFileSync(join(state, "active-wsp-place.service"), "");
    writeFileSync(join(state, "enabled-wsp-place.service"), "");
    expect(bash(`${addUndoScript(place, writes, found, systemctl, true)} || true`)).not.toContain(DAEMON_GONE_LINE);
    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(join(state, "active-wsp-place.service"))).toBe(true);
    // The same box where disable --now works: the unit stops and the undo says it finished.
    writeStub(systemctl, refusing.replace('[ "$2" = --now ] && exit 1;', '[ "$2" = --now ] && rm -f "$S/active-$3";'));
    wroteTheAdd(home);
    writeFileSync(unitPath, "[Service]\n");
    expect(bash(addUndoScript(place, writes, found, systemctl, true))).toContain(DAEMON_GONE_LINE);
    expect(existsSync(join(state, "active-wsp-place.service"))).toBe(false);
  });

  it("names every path a leave takes as the add's own, and never a folder above a home of /", () => {
    const home = "/home/maya";
    const at = placeDaemonPaths(home);
    const writes = joinedAddWrites(joinedPlace({ home, path: "/usr/bin" }, { hostUrls: [], codeFile: `${at.wsp}/join-code`, name: "box" }), placeUnit(home).path);
    const own = writes.filter(w => w.as === "own").map(w => w.path);
    for (const path of placeOwnedPaths(home).filter(path => path !== at.wsp)) expect(own).toContain(path);
    expect(own).not.toContain(at.wsp);
    const root = joinedAddWrites(joinedPlace({ home: "/", path: "/usr/bin" }, { hostUrls: [], codeFile: "/.wsp/join-code", name: "box" }), placeUnit("/").path);
    expect(root.filter(w => w.as === "folder").map(w => w.path)).not.toContain("/");
  });

  it("reads nothing as held where the box never finished saying, and only the writes it was asked about", () => {
    expect(addFound("WSP_HAD 0\n", 3)).toBeUndefined();
    expect([...addFound(`WSP_HAD 0\nWSP_HAD 2\nWSP_HAD 9\nWSP_HAD x\n${ADD_FOUND_END}\n`, 3)!]).toEqual([0, 2]);
  });
});

describe("the place file an add reads off a box before anything lands", () => {
  it("reads at most 64 KiB of it, whatever the box holds there", async () => {
    const home = tmp("held-home");
    const file = placeDaemonPaths(home).placeFile;
    mkdirSync(dirname(file), { recursive: true });
    const run = async (): Promise<string> => (await promisify(execFile)("/bin/bash", ["-c", heldPlaceScript(home)], { timeout: 10_000, maxBuffer: 1 << 24 })).stdout;
    writeFileSync(file, "x".repeat(200_000));
    expect((await run()).length).toBe(65_536);
    rmSync(file);
    symlinkSync("/dev/zero", file);
    expect((await run()).length).toBe(65_536);
    rmSync(file);
    expect(await run()).toBe("");
  });

  it("names another wsp's host in one bounded line with nothing the box wrote to move the terminal, and a url only where it is one", () => {
    const held = { placeId: "p_x", name: "spoo\x1b]0;owned\x07", hostName: `studio\x1b[2J\n${"h".repeat(5000)}`, hostUrls: ["/etc/passwd"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" };
    const line = placeHeldRefusal("root@spoo", held, undefined);
    expect(line.length).toBeLessThanOrEqual(SSH_LINE_CAP);
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line).not.toContain("/etc/passwd");
    expect(line.startsWith("root@spoo already belongs to the wsp on studio[2J")).toBe(true);
    expect(placeHeldRefusal("root@spoo", { ...held, hostName: "studio", hostUrls: ["http://192.168.1.5:4640"] }, undefined)).toContain("studio at http://192.168.1.5:4640;");
    expect(placeHeldRefusal("root@spoo", { ...held, hostUrls: [`http://h/${"a".repeat(9000)}`] }, undefined)).not.toContain("http://h/");
    expect(placeHeldRefusal("root@spoo", { ...held, hostPublicKey: "dGhpcyBob3N0" }, keyFingerprint("dGhpcyBob3N0"))).toBe("root@spoo is already a place in this wsp as spoo]0;owned");
  });
});

describe("the check a box runs for whether it can reach this host", () => {
  /** A folder standing in for a box's PATH: bash always, and `timeout` or curl only where a case gives them. */
  function boxPath(name: string, tools: { timeout?: boolean; curl?: boolean }): string {
    const dir = tmp(name);
    symlinkSync("/bin/bash", join(dir, "bash"));
    if (tools.curl === true) symlinkSync("/usr/bin/curl", join(dir, "curl"));
    if (tools.timeout === true) writeStub(join(dir, "timeout"), '#!/bin/bash\nshift\nexec "$@"\n');
    return dir;
  }

  it("reaches an address that answers and not one nobody listens on, by curl, by bash under timeout, and by neither", async () => {
    const listening = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>(done => listening.listen(0, "127.0.0.1", done));
    const refused = await refusedPort();
    onTestFinished(refused.close);
    const urls = [`http://127.0.0.1:${refused.port}`, `http://127.0.0.1:${(listening.address() as { port: number }).port}`];
    const run = async (PATH: string): Promise<string> => (await promisify(execFile)("/bin/bash", ["-c", reachScript(urls)], { env: { PATH }, timeout: 20_000 })).stdout;
    try {
      expect(reachedUrls(await run(boxPath("reach-curl", { curl: true })), urls)).toEqual([urls[1]]);
      expect(reachedUrls(await run(boxPath("reach-tcp", { timeout: true })), urls)).toEqual([urls[1]]);
      const neither = await run(boxPath("reach-neither", {}));
      expect(reachedUrls(neither, urls)).toEqual([]);
      expect(neither).toContain(`WSP_REACH no ${urls[1]}`);
    } finally {
      await new Promise<void>(done => listening.close(() => done()));
    }
  });

  it("reaches an address directly under a proxy in the box's environment, as the join and the daemon dial it", async () => {
    const listening = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>(done => listening.listen(0, "127.0.0.1", done));
    const urls = [`http://127.0.0.1:${(listening.address() as { port: number }).port}`];
    const dead = "http://127.0.0.1:9";
    try {
      const said = (await promisify(execFile)("/bin/bash", ["-c", reachScript(urls)], { env: { PATH: boxPath("reach-proxy", { curl: true }), http_proxy: dead, HTTP_PROXY: dead, all_proxy: dead }, timeout: 20_000 })).stdout;
      expect(reachedUrls(said, urls)).toEqual(urls);
    } finally {
      await new Promise<void>(done => listening.close(() => done()));
    }
  });

  it("says every address it cannot reach while they fit the line, and how many more past that, keeping the fix", () => {
    const urls = Array.from({ length: 12 }, (_, i) => `http://100.64.${i}.${i + 10}:4640`);
    const line = unreachedLine("root@spoo", urls);
    expect(line.length).toBeLessThanOrEqual(SSH_LINE_CAP);
    expect(line).toContain(urls[0]);
    expect(line).toMatch(/ and \d+ more, so nothing of wsp's went onto it; link this host to your relay/);
    expect(unreachedLine("root@spoo", urls.slice(0, 2))).toBe(
      `root@spoo cannot reach this computer at ${urls[0]}, ${urls[1]}, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address root@spoo can reach`,
    );
  });

  it("keeps the order the addresses were handed in and ignores a line naming one it was not handed", () => {
    const urls = ["http://100.129.166.28:4640", "https://wsp-box.example.com", "http://192.168.1.20:4640"];
    expect(reachedUrls("WSP_REACH ok http://192.168.1.20:4640\nWSP_REACH ok https://wsp-box.example.com\nWSP_REACH ok http://10.9.9.9:1\nWSP_REACH no http://100.129.166.28:4640\n", urls)).toEqual([urls[1], urls[2]]);
    // A tunnel's address names no port, and the fallback try dials the one its scheme implies.
    expect(reachScript(["https://wsp-box.example.com", "http://[fd00::1]:4640"])).toContain("reach 'https://wsp-box.example.com' 'wsp-box.example.com' 443 &");
    expect(reachScript(["http://[fd00::1]:4640"])).toContain("reach 'http://[fd00::1]:4640' 'fd00::1' 4640 &");
  });
});

describe("the sweep a computer runs on itself", () => {
  it("takes the browser name it left even once the shim it pointed at has gone, and its own line out of the login file", async () => {
    const home = tmp("sweep-leftovers");
    const at = placeDaemonPaths(home);
    mkdirSync(at.binDir, { recursive: true });
    writeFileSync(`${at.binDir}/wsp-open`, "#!/bin/sh\n");
    // The name every tool execs, pointing at the shim: once the shim goes it is a link to nothing, which every
    // read that follows a link calls absent while the person is still left holding it.
    symlinkSync(`${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`);
    // Both spellings: the one a computer joined before the line was guarded carries, and the one a deploy writes
    // now. The sweep matches wsp's line by the file it names, so it takes out either.
    writeFileSync(join(home, ".profile"), `# theirs\n. ${at.profileFile}\nexport EDITOR=vi\n[ -f ${at.profileFile} ] && . ${at.profileFile}\n`);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(existsSync(`${at.binDir}/xdg-open`)).toBe(false);
    expect(swept.removed).toContain(`${at.binDir}/xdg-open`);
    // Their file keeps everything of theirs and loses the one line wsp put in it.
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\nexport EDITOR=vi\n");
    expect(swept.removed).toContain(`. ${at.profileFile}; [ -f ${at.profileFile} ] && . ${at.profileFile} (out of ${join(home, ".profile")})`);
  });

  it("takes its line out of the login file by the one config write: a killed write's temp swept, a hard-linked file left whole and said", async () => {
    const home = tmp("sweep-profile-write");
    const at = placeDaemonPaths(home);
    const line = `[ -f ${at.profileFile} ] && . ${at.profileFile}`;
    writeFileSync(join(home, ".profile"), `# theirs\n${line}\n`);
    const stale = join(home, ".wsp-config-tmp.dead01");
    writeFileSync(stale, "half a file");
    const aged = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, aged, aged);
    await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\n");
    expect(existsSync(stale)).toBe(false);

    writeFileSync(join(home, ".profile"), `# theirs\n${line}\n`);
    linkSync(join(home, ".profile"), join(home, "profile-twin"));
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, "profile-twin"), "utf8")).toBe(`# theirs\n${line}\n`);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`# theirs\n${line}\n`);
    expect(swept.kept).toContain(`${line} stays in ${join(home, ".profile")}: ${configHardLinkRefusal(join(home, ".profile"))}`);
  });

  it("leaves a login file it never wrote to exactly as it was", async () => {
    const home = tmp("sweep-untouched");
    writeFileSync(join(home, ".profile"), "# theirs\n");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\n");
    expect(swept.removed.some(line => line.includes(".profile"))).toBe(false);
  });
});

describe("what wsp add asks the host for", () => {
  /** A host answering the two ops wsp add sends, with what it was asked kept. A door named as a sentence is a host
   * that refused the ask with it; nothing at all is a host that serves no door. */
  const fakeClient = (door: PlaceDoorView | string | undefined): { client: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      client: () =>
        Promise.resolve({
          request: (op: string) => {
            asked.push(op);
            if (op === "pair.issue") return Promise.resolve({ code: "7QK3M2VD", expiresAt: 600_000 } as never);
            if (op === "places.door") {
              if (door === undefined) return Promise.reject(new Error(PLACE_DOOR_UNSERVED));
              return typeof door === "string" ? Promise.reject(new Error(door)) : Promise.resolve({ door } as never);
            }
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const addDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("opens the door by asking for it and prints its address, so a host on loopback alone is still one a computer can join", async () => {
    const home = tmp("add-door");
    const io = captured();
    const fake = fakeClient({ port: 4420, addresses: ["http://192.168.1.20:4420"], hostKey: `SHA256:${"c".repeat(43)}` });
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(fake.asked).toEqual(["pair.issue", "places.door"]);
    // The token names the key the host on this computer signs with, off the pair beside its state file, so the
    // computer typing this line can tell that host from anything else answering at that address.
    expect(io.lines.join("\n")).toContain(`wsp join http://192.168.1.20:4420 --code ${joinToken("7QK3M2VD", hostKeyHere(opts.statePath))}`);
    // The loopback refusal is about a host nothing can dial; a host that just opened a door is not one.
    expect(io.errors.join("\n")).not.toContain("--listen");
  });

  it("prints the door's own sentence when the host has one and could not open it, and points at no other fix", async () => {
    const home = tmp("add-door-held");
    const io = captured();
    const fake = fakeClient(doorPortHeldLine(4420));
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(io.errors.join("\n")).toContain(doorPortHeldLine(4420));
    expect(io.errors.join("\n")).not.toContain("--listen");
  });

  it("falls back to the host's own address and says a loopback host can be dialled by nothing when it serves no door", async () => {
    const home = tmp("add-no-door");
    const io = captured();
    const fake = fakeClient(undefined);
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(io.errors.join("\n")).toContain("--listen");
    expect(io.lines.join("\n")).toContain("wsp join http://127.0.0.1:");
    // A door that would not open still leaves the key readable here, so the line it prints names one.
    expect(io.lines.join("\n")).toContain(hostKeyHere(opts.statePath));
  });
});
