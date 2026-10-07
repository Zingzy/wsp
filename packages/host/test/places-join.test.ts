// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import WebSocket from "ws";
import { ALREADY_JOINED_LINE, JOIN_NO_KEY_REFUSAL, PLACE_LEAVE_LINE, PLACE_CODE_REFUSAL, PLACE_NEEDS_ROOT_LINE, joinKeyRefusal, placeFileText, MCP_ID_PREFIX, placeDaemonPaths, placeKeptForLinkLine, placeProvisionPaths, shellQuote, wsUrlOf } from "@wsp/protocol";
import { CODEX_TOML } from "@wsp/catalog";
import { OWN_MARK, outsideAfterScript, outsideBeforeScript, keyFingerprint } from "@wsp/engine";
import { daemonBinaryHere } from "../src/assets.js";
import { GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";
import { apparmorStep, apparmorStoodLine, joinedPlace, placeFoundSkippedLine, placeFoundStep, sshDaemonPlace } from "../src/doctor.js";
import { PLACE_FOUND_END, threadCgroupsEndScript, placeOutsideLeftLine, placeOwnersUnknownLine, TOOL_PREFIX } from "@wsp/protocol";
import { pinnedDroppingPort } from "../../runtime/test/held-port.js";
import { NOTHING_TO_LEAVE_LINE, brokenJoinLine, brokenPlaceLeftLine, joinCutByLeaveLine, joinCommand } from "../src/places.js";
import { placeFilePath, placeKeyPath, placeLogPath, readPlaceFile, sweptLine, sweptSaid, writePlaceFile } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS, type ServiceAddress, type ServiceRunner } from "../src/service.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { addFoundNothing, codeFor, fakeHost, fakeRunner, homeWithLandedFiles, joinDepsFor, leaveCommand, NOWHERE_CODE, shWithSha256sum, sweepPlace, tmp, toolsUnder, unitsUnder } from "./places-fixture.js";
/** A seam between a join's key and its place file, where another process's leave or a crash would land. */
const fsHooks = vi.hoisted(() => ({ beforeLink: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync: (existing: import("node:fs").PathLike, path: import("node:fs").PathLike) => {
      fsHooks.beforeLink?.();
      return fs.linkSync(existing, path);
    },
  };
});
afterEach(() => {
  fsHooks.beforeLink = undefined;
});

describe("a computer joining a wsp", () => {
  it("writes the place file and the key at the person's own mode, installs the agent as a service, and says so", async () => {
    const home = tmp("join-home");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "7QK3M2VD"), name: "old-macbook" }, joinDepsFor(home, runner.run))).toBe(0);
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ placeId: "p_ab12cd34ab12cd34", name: "old-macbook", hostUrls: [host.url], hostPublicKey: host.publicKey });
    expect(statSync(placeFilePath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(placeKeyPath(home), "utf8")).toContain("PRIVATE KEY");
    expect(statSync(placeKeyPath(home)).mode & 0o777).toBe(0o600);
    // The service runs the daemon itself, under the place's own name rather than the host's.
    expect(runner.ran.some(argv => argv.includes("enable") && argv.some(w => w.startsWith("wsp-place-")))).toBe(true);
    const unit = join(home, "etc-systemd-system");
    const written = readFileSync(join(unit, readdirSync(unit)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    expect(written).toContain(`'--place-file' ${shellQuote(placeFilePath(home))}`);
    // The home is stated in the unit: the daemon keeps its files under the home its place file sits in, and a
    // manager handing it the login's own default would put them somewhere else.
    expect(written).toContain(`HOME=${home}`);
    expect(io.lines.join("\n")).toContain("old-macbook joined the wsp at");
    expect(io.lines.join("\n")).toContain("wsp leave takes this computer back out.");
    // Frame one carries public values only; the report names this computer and the address it dialled, and it
    // rides the prove, inside the seal, after the host proved the key the join line named.
    const first = host.frames.find(f => f["op"] === "place.join")!;
    expect(Object.keys(first).sort()).toEqual(["ephemeral", "id", "nonce", "op", "publicKey"]);
    const sent = host.frames.find(f => f["op"] === "place.prove")!;
    expect((sent["report"] as { name: string; dialed: string }).name).toBe("old-macbook");
    expect((sent["report"] as { dialed: string }).dialed).toBe(host.url);
  });

  it("refuses a login that is not root with one sentence and writes nothing, since the agent is the machine's service", async () => {
    const home = tmp("join-plain");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    const deps = { ...joinDepsFor(home, runner.run), uid: 1000 };
    // The sentence itself, not just that something threw: every other reason a join can stop here throws too.
    const said = await joinCommand(io, [host.url], { code: codeFor(host, "7QK3M2VD"), name: "old-macbook" }, deps).then(() => "", (e: unknown) => String(e));
    expect(said).toContain(PLACE_NEEDS_ROOT_LINE);
    // Before the handshake: no place file, no key, no unit, and the host was never dialled at all.
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(existsSync(join(home, "etc-systemd-system"))).toBe(false);
    expect(runner.ran).toEqual([]);
    expect(host.frames).toEqual([]);
  });

  it("writes nothing when the host could not prove the key it sent", async () => {
    const home = tmp("join-bad-key");
    const host = await fakeHost({ wrongKey: true });
    const io = captured();
    await expect(joinCommand(io, [host.url], { code: codeFor(host, "X") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/did not prove the key/);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
  });

  it("carries the host's own refusal back and writes nothing when the code was spent", async () => {
    const home = tmp("join-spent");
    const host = await fakeHost({ refuse: "that pairing code is not one this host is waiting for" });
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "X") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/not one this host is waiting for/);
    expect(existsSync(placeFilePath(home))).toBe(false);
  });

  it("says which of the two things a person typed a refusal is about, where it is about one of them", async () => {
    // The code: the one refusal a host has for a code it is not holding, spent, expired or never minted.
    const spent = await fakeHost({ refuse: PLACE_CODE_REFUSAL });
    await expect(joinCommand(captured(), [spent.url], { code: codeFor(spent, "X") }, joinDepsFor(tmp("join-code"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "code" });
    // The address: nothing answers there, on a port this test holds so no other test's listen is handed it.
    const { port: closed, bound, close: closeClosed } = await pinnedDroppingPort();
    onTestFinished(closeClosed);
    expect(bound).toBe(false);
    await expect(joinCommand(captured(), [`http://127.0.0.1:${closed}`], { code: NOWHERE_CODE }, joinDepsFor(tmp("join-gone"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "address" });
    // A refusal about neither field carries neither: a host that would not prove its key, and any other word of its own.
    const wrong = await fakeHost({ wrongKey: true });
    await expect(joinCommand(captured(), [wrong.url], { code: codeFor(wrong, "X") }, joinDepsFor(tmp("join-key"), fakeRunner().run))).rejects.toMatchObject({ name: "Error" });
    const other = await fakeHost({ refuse: "this host takes no places while it is building your image" });
    await expect(joinCommand(captured(), [other.url], { code: codeFor(other, "X") }, joinDepsFor(tmp("join-other"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "host" });
  });

  it("restarts the unit it just wrote rather than starting it, so an agent that survived runs the binary that landed", async () => {
    const home = tmp("join-restart");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, runner.run))).toBe(0);
    const unit = SERVICE_MANAGERS.systemd.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 }).name;
    // enable without --now and then restart: a start leaves a process from an earlier unit of this name running
    // the binary it was started with, which is what an install over the old one landed on, and a restart on a unit
    // that is stopped starts it.
    expect(runner.ran).toEqual([
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", unit],
      ["systemctl", "restart", unit],
    ]);
  });

  it("refuses a second join on a computer that already belongs to a wsp", async () => {
    const home = tmp("join-again");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "B") }, joinDepsFor(home, runner.run))).toBe(1);
    expect(io.errors).toEqual([ALREADY_JOINED_LINE]);
  });

  it("lets one of two joins racing on one computer write its place file, and refuses the other before it writes anything", async () => {
    const home = tmp("join-race");
    const host = await fakeHost();
    const runner = fakeRunner();
    const ios = [captured(), captured()];
    const sent: string[] = [];
    // Each join's own public key, off its first frame, so the key left on disk can be traced to the join that won.
    const dialFor = (i: number) => (url: string): WebSocket => {
      const ws = new WebSocket(wsUrlOf(url));
      const send = ws.send.bind(ws) as (data: unknown) => void;
      ws.send = ((data: unknown) => {
        if (typeof data === "string" && sent[i] === undefined) sent[i] = String((JSON.parse(data) as Record<string, unknown>)["publicKey"]);
        send(data);
      }) as typeof ws.send;
      return ws;
    };
    const both = await Promise.allSettled(ios.map((io, i) => joinCommand(io, [host.url], { code: codeFor(host, `R${i}`) }, { ...joinDepsFor(home, runner.run), dial: dialFor(i) })));
    expect(both.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const lost = both.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(String(lost?.reason)).toContain(ALREADY_JOINED_LINE);
    const won = ios[both.findIndex(r => r.status === "fulfilled")]!;
    expect(won.lines.join("\n")).toContain("joined the wsp at");
    expect(ios.filter(io => io.lines.join("\n").includes("joined the wsp at"))).toHaveLength(1);
    const onDisk = createPublicKey(createPrivateKey(readFileSync(placeKeyPath(home), "utf8"))).export({ type: "spki", format: "der" }).toString("base64");
    expect(onDisk).toBe(sent[both.findIndex(r => r.status === "fulfilled")]);
  });

  it("refuses a join over a place file it cannot read, naming the file and wsp leave, and leaves the file for leave to take", async () => {
    const home = tmp("join-broken");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{\"placeId\": \"p_1\", \"na");
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(file)]);
    expect(io.errors[0]).toContain(file);
    expect(io.errors[0]).toContain(PLACE_LEAVE_LINE);
    expect(host.frames).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{\"placeId\": \"p_1\", \"na");
  });

  it("reads a key with no place file beside it, which a join cut off between its two writes leaves, as broken: join names it, leave takes it", async () => {
    const home = tmp("join-cut");
    const key = placeKeyPath(home);
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\n");
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(key)]);
    expect(host.frames).toEqual([]);
    const left = captured();
    expect(await leaveCommand(left, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(existsSync(key)).toBe(false);
    expect(left.lines[0]).toBe(brokenPlaceLeftLine(key));
  });

  it("reads a dangling link at the place file as broken rather than as no file: join names it before any handshake, leave takes the link", async () => {
    const home = tmp("join-dangling");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(join(home, "nowhere.json"), file);
    const host = await fakeHost();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([brokenJoinLine(file)]);
    expect(host.frames).toEqual([]);
    expect(await leaveCommand(captured(), [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(() => lstatSync(file)).toThrow();
  });

  it("claims the key before the place file and never writes it through a link planted during the handshake", async () => {
    const home = tmp("join-key-link");
    const key = placeKeyPath(home);
    const theirs = join(home, "their-file");
    writeFileSync(theirs, "mine");
    const host = await fakeHost();
    const dial = (url: string): WebSocket => {
      const ws = new WebSocket(wsUrlOf(url));
      ws.once("open", () => {
        mkdirSync(dirname(key), { recursive: true });
        symlinkSync(theirs, key);
      });
      return ws;
    };
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, { ...joinDepsFor(home, fakeRunner().run), dial })).rejects.toThrow(ALREADY_JOINED_LINE);
    expect(readFileSync(theirs, "utf8")).toBe("mine");
    expect(existsSync(placeFilePath(home))).toBe(false);
  });

  it("writes the place file whole, after the key: at the moment it lands the key is there and no place file stands", async () => {
    const home = tmp("join-order");
    const host = await fakeHost();
    const seen: boolean[] = [];
    fsHooks.beforeLink = () => seen.push(existsSync(placeKeyPath(home)), existsSync(placeFilePath(home)));
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(seen).toEqual([true, false]);
    expect(readdirSync(dirname(placeFilePath(home))).filter(f => f.startsWith(`${basename(placeFilePath(home))}.`))).toEqual([]);
  });

  it("gives way to a leave that lands between its two writes, leaving neither file behind", async () => {
    const home = tmp("join-leave-race");
    const host = await fakeHost();
    // A leave in another process finds the key with no place file beside it, reads it as broken and takes it.
    fsHooks.beforeLink = () => rmSync(placeKeyPath(home), { force: true });
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(joinCutByLeaveLine);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
  });

  it("leaves a second join's key alone when that join landed both its files between this join's two writes", async () => {
    const home = tmp("join-lost-link");
    const host = await fakeHost();
    const theirs = { placeId: "p_2", name: "other", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() };
    // A leave takes this join's key, then another join writes its own key and place file, all before this link.
    fsHooks.beforeLink = () => {
      fsHooks.beforeLink = undefined;
      rmSync(placeKeyPath(home), { force: true });
      writeFileSync(placeKeyPath(home), "their key");
      writeFileSync(placeFilePath(home), placeFileText(theirs));
    };
    await expect(joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(ALREADY_JOINED_LINE);
    expect(readFileSync(placeKeyPath(home), "utf8")).toBe("their key");
    expect(readPlaceFile(placeFilePath(home))?.placeId).toBe("p_2");
  });

  it("takes the code as the other screen shows it, since a person copies the code they can read", async () => {
    const home = tmp("join-dashed");
    const host = await fakeHost();
    expect(await joinCommand(captured(), [host.url], { code: `qw4k-7pzx.${keyFingerprint(host.publicKey)}` }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(String((host.frames.find(f => f["op"] === "place.prove")!)["code"])).toBe("QW4K7PZX");
  });

  it("reads the code off a file and deletes it before dialing, so a code never sits on a disk", async () => {
    const home = tmp("join-code-file");
    const host = await fakeHost();
    const codeFile = join(home, "join-code");
    writeFileSync(codeFile, `${codeFor(host, "7QK3M2VD")}\n`);
    expect(await joinCommand(captured(), [host.url], { codeFile }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(existsSync(codeFile)).toBe(false);
    expect(String((host.frames.find(f => f["op"] === "place.prove")!)["code"])).toBe("7QK3M2VD");
  });

  it("refuses a host that proves a key the join line did not name, before it sends anything of its own", async () => {
    const home = tmp("join-stranger");
    // A peer that answered where the host was expected: its own key, its own valid signature over this computer's
    // nonce. Every signature checks out; the key is not the one the line named.
    const stranger = await fakeHost({ strangerKey: true });
    const io = captured();
    await expect(joinCommand(io, [stranger.url], { code: codeFor(stranger, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(joinKeyRefusal(stranger.url));
    // Nothing of this computer's went over: no report, no signature of its own, nothing past the first frame.
    expect(stranger.frames.map(f => f["op"])).toEqual(["place.join"]);
    // And nothing was written here: no place record, no pinned key, no unit for a daemon to hold a socket open on.
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user"))).toBe(false);
  });

  it("says a join answer it cannot read on one line, since the add reads the box's last line as its sentence", async () => {
    const home = tmp("join-unreadable");
    const host = await fakeHost({ unreadable: true });
    const said = await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run)).catch((e: unknown) => (e as Error).message);
    expect(String(said)).toContain(`${host.url} answered the join with something this computer cannot read: `);
    expect(String(said)).not.toContain("\n");
    expect(String(said)).toContain("placeId");
  });

  it("joins the host whose key the line named, as it did before", async () => {
    const home = tmp("join-named-key");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, runner.run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.hostPublicKey).toBe(host.publicKey);
    // The code that went over is the code alone: the fingerprint is this computer's to check and no part of the frame.
    expect(host.frames.find(f => f["op"] === "place.prove")!["code"]).toBe("7QK3M2VD");
    expect(runner.ran.length).toBeGreaterThan(0);
  });

  it("refuses a line that names no key and says to run wsp add again, on the flag and on the file alike", async () => {
    const home = tmp("join-keyless");
    const host = await fakeHost();
    await expect(joinCommand(captured(), [host.url], { code: "7QK3M2VD" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(JOIN_NO_KEY_REFUSAL);
    const codeFile = join(home, "join-code");
    writeFileSync(codeFile, "7QK3M2VD\n");
    await expect(joinCommand(captured(), [host.url], { codeFile }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(JOIN_NO_KEY_REFUSAL);
    // Refused before anything is dialled: the host saw no frame and this computer wrote nothing.
    expect(host.frames).toEqual([]);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(JOIN_NO_KEY_REFUSAL).toContain("wsp add");
  });

  it("refuses both roads to a code at once", async () => {
    const home = tmp("join-usage");
    await expect(joinCommand(captured(), ["http://x"], { code: "A", codeFile: "/tmp/c" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/--code or --code-file/);
  });
});

describe("taking wsp off the computer it is typed on", () => {
  it("unloads the unit, takes every path wsp put there and keeps the work folder, and says so", async () => {
    const home = tmp("leave-home");
    const at = placeDaemonPaths(home);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "old-macbook", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    writeFileSync(placeKeyPath(home), "key");
    writeFileSync(at.tokenPath, "token");
    writeFileSync(at.portFile, "7071");
    mkdirSync(at.inbox, { recursive: true });
    mkdirSync(at.runDir, { recursive: true });
    writeFileSync(placeLogPath(home), "linked\n");
    const work = join(home, "wsp-work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a-thread-wrote-this"), "mine");
    const runner = fakeRunner();
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: runner.run, platform: "linux" })).toBe(0);
    for (const path of [placeFilePath(home), placeKeyPath(home), placeLogPath(home), at.tokenPath, at.portFile, at.inbox, at.runDir]) expect(existsSync(path)).toBe(false);
    // The work folder is the person's own: a place that left a wsp keeps what its threads wrote.
    expect(readFileSync(join(work, "a-thread-wrote-this"), "utf8")).toBe("mine");
    const said = io.lines.join("\n");
    expect(said).toContain("old-macbook left the wsp at");
    expect(said).toContain("stays: the work your threads did there is yours");
    expect(said).toContain("wsp remove");
    // The manager was asked to stop the agent and to forget it, which is what a person running this wants to see.
    expect(runner.ran.some(argv => argv.includes("stop"))).toBe(true);
    expect(runner.ran.some(argv => argv.includes("disable"))).toBe(true);
  });

  it("takes every file wsp landed in an agent's home here whose bytes are still wsp's, and keeps the one the person wrote", async () => {
    const { home, rows } = homeWithLandedFiles("leave-landed");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    for (const row of rows.slice(0, -1)) {
      expect(existsSync(join(home, row.rel)), row.rel).toBe(false);
      expect(swept.removed).toContain(join(home, row.rel));
    }
    // The person's own copy of a file wsp once landed hashes differently, so the read never named it.
    const kept = rows.at(-1)!;
    expect(readFileSync(join(home, kept.rel), "utf8")).toBe("the person wrote this\n");
    expect(swept.removed).not.toContain(join(home, kept.rel));
    // A folder wsp's own files left empty goes with them, up to but never into the folder the agent itself owns.
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "theirs.md"), "utf8")).toBe("mine\n");
    // The list's server line named no path, so the leave took nothing for it and made nothing at its name.
    expect(existsSync(join(home, "agents"))).toBe(false);
    expect(swept.removed.filter(took => took.includes("agents/mcp"))).toEqual([]);
    // And wsp's own folder is gone whole, the provision folder and the ledger inside it with it.
    expect(existsSync(placeDaemonPaths(home).wsp)).toBe(false);
    expect(swept.removed.at(-1)).toBe(placeDaemonPaths(home).wsp);
  });

  it("reads what wsp owns before the folder that holds the list goes", async () => {
    const { home, rows } = homeWithLandedFiles("leave-landed-order");
    const ledger = placeProvisionPaths(home).landed;
    const sh = shWithSha256sum();
    let read = 0;
    const watched = (script: string): string => {
      read += 1;
      // The one thing the order buys: at the moment the read runs, the list it reads is still there to read.
      expect(existsSync(ledger), "the ownership read ran after the folder holding the ledger had gone").toBe(true);
      return sh(script);
    };
    await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: watched });
    // Two reads of that list, both before the folder holding it goes: which files here are wsp's own copies, and
    // which servers in the agents' own files are its own keys.
    expect(read).toBe(2);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(join(home, rows[0]!.rel))).toBe(false);
  });

  it("takes wsp's own folder whole, so nothing under it is left on a computer the person joined", async () => {
    const home = tmp("leave-whole");
    const at = placeDaemonPaths(home);
    mkdirSync(at.putDir, { recursive: true });
    writeFileSync(join(at.putDir, "797"), "half an update");
    writeFileSync(join(at.wsp, "place.json.bak-747"), "old");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => "" });
    expect(existsSync(at.wsp)).toBe(false);
    expect(swept.removed).toEqual([at.wsp]);
  });

  it("keeps every file of the person's on a computer the recipe never ran on", async () => {
    const home = tmp("leave-no-ledger");
    mkdirSync(join(home, ".claude", "skills", "wsp"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "wsp", "SKILL.md"), "theirs\n");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    expect(swept.removed.filter(line => line.startsWith("/"))).toEqual([]);
    expect(existsSync(join(home, ".claude", "skills", "wsp", "SKILL.md"))).toBe(true);
  });

  it("removes nothing through a folder a workspace replaced with a link, and says which paths stayed", async () => {
    const home = tmp("leave-linked-parent");
    const at = placeDaemonPaths(home);
    mkdirSync(at.wsp, { recursive: true });
    // The computer's own bin, holding the two names the fixed list ends on, and the shared bin a workspace
    // replaced with a link to it.
    const theirs = tmp("leave-linked-theirs");
    for (const name of ["wsp-open", "xdg-open"]) writeFileSync(join(theirs, name), "the computer's own\n");
    mkdirSync(join(home, ".local"), { recursive: true });
    symlinkSync(theirs, at.binDir);
    // And a row of the ledger whose folder is a link the same way, pointing at a file of the computer's own.
    const planted = tmp("leave-linked-planted");
    writeFileSync(join(planted, "settings.json"), "the computer's own\n");
    symlinkSync(planted, join(home, ".claude"));

    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => `${OWN_MARK}\t.claude/settings.json\n` });

    for (const name of ["wsp-open", "xdg-open"]) expect(readFileSync(join(theirs, name), "utf8"), name).toBe("the computer's own\n");
    expect(readFileSync(join(planted, "settings.json"), "utf8")).toBe("the computer's own\n");
    // The links are the workspace's own doing and stay; what the leave says is that it took nothing at those
    // three paths and why.
    for (const path of [join(at.binDir, "wsp-open"), join(at.binDir, "xdg-open"), join(home, ".claude", "settings.json")]) {
      expect(swept.removed, path).toContain(placeKeptForLinkLine(path));
      expect(swept.removed, path).not.toContain(path);
    }
    // Wsp's own folder is under no link and goes as it always did.
    expect(existsSync(at.wsp)).toBe(false);
    expect(swept.removed).toContain(at.wsp);
  });

  it("says this computer is no place when there is nothing to leave", async () => {
    const io = captured();
    expect(await leaveCommand(io, [], { home: tmp("leave-none"), run: fakeRunner().run, platform: "linux" })).toBe(1);
    expect(io.errors).toEqual([NOTHING_TO_LEAVE_LINE]);
  });

  it("takes a place file it cannot read off this computer, and says it was broken", async () => {
    const home = tmp("leave-broken");
    const file = placeFilePath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "not json");
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(io.lines[0]).toBe(brokenPlaceLeftLine(file));
    expect(io.lines.join("\n")).toContain(file);
  });

  it("stops the agent in both scopes before its unit file goes, reloads the manager after, and says it stopped it", async () => {
    const home = tmp("leave-order");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const swept = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    // The stop and the disable come while the file is still there: a manager asked to stop a unit whose file has
    // gone stops nothing, and the agent kept running with the place file it serves removed under it. The reload
    // follows the removal, so systemd is left holding no unit at all. The agent is the machine's service, so its
    // own systemctl carries no --user; the login's is asked too, since a computer joined before the unit became
    // the machine's has its file there and nothing else would take it.
    expect(runner.ran).toEqual([
      ["systemctl", "stop", unit.name],
      ["systemctl", "disable", unit.name],
      ["systemctl", "daemon-reload"],
      ["systemctl", "--user", "stop", unit.name],
      ["systemctl", "--user", "disable", unit.name],
      // A thread's turns stand in cgroups of their own, outside the unit, so they are ended once it has stopped.
      ["sh", "-c", threadCgroupsEndScript()],
    ]);
    // The file is gone and the link systemd keeps beside it was taken with it, so no start brings the agent back,
    // and the line a person reads says what a leave that left the process running never could.
    expect(existsSync(unit.path)).toBe(false);
    expect(swept.removed[0]).toBe(`systemd system unit ${unit.name} (stopped)`);
  });

  it("unloads the workspace profile and takes its file where the leave runs as root, and leaves it for any other login", async () => {
    const home = tmp("leave-apparmor");
    addFoundNothing(home);
    // A space in the folder: the path is one word to the shell or the removal takes two files that are not it.
    const profile = join(tmp("leave-apparmor-etc"), "apparmor d", "wsp-workspace");
    mkdirSync(dirname(profile));
    // A name no kernel holds: the unload runs for real as root, and the machine's own wsp-workspace must stay loaded.
    writeFileSync(profile, "profile wsp-test-never-loaded {}\n");
    const ran: string[] = [];
    const sh = (script: string): string => {
      ran.push(script);
      return execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    };
    const other = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 1000, apparmorProfile: profile });
    expect(existsSync(profile)).toBe(true);
    expect(other.removed).not.toContain(profile);
    // The leave as another login took wsp's folder here, and the record with it.
    addFoundNothing(home);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 0, apparmorProfile: profile });
    expect(ran.some(script => script.includes(`apparmor_parser -R ${shellQuote(profile)}`))).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(swept.removed).toContain(profile);
  });

  it("takes wsp's install folder and every command linked out of it where the leave runs as root, and nothing else there", async () => {
    const home = tmp("leave-tools");
    addFoundNothing(home);
    const tools = toolsUnder(home);
    mkdirSync(join(tools.prefix, "uv", "tools", "ruff", "bin"), { recursive: true });
    writeFileSync(join(tools.prefix, "uv", "tools", "ruff", "bin", "ruff"), "#!/bin/sh\n");
    mkdirSync(join(tools.prefix, "pnpm", "bin"), { recursive: true });
    mkdirSync(tools.links);
    symlinkSync(join(tools.prefix, "uv", "tools", "ruff", "bin", "ruff"), join(tools.links, "ruff"));
    // A relative link reads by where it sits, and one wsp's folder named already gone still points under it.
    symlinkSync(relative(tools.links, join(tools.prefix, "pnpm", "bin", "tsc")), join(tools.links, "tsc"));
    // The computer's own: a file, a link elsewhere, and a name that only starts like the folder.
    writeFileSync(join(tools.links, "jq"), "#!/bin/sh\n");
    symlinkSync("/usr/bin/env", join(tools.links, "env2"));
    mkdirSync(`${tools.prefix}-old`);
    symlinkSync(`${tools.prefix}-old`, join(tools.links, "old"));
    const other = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, uid: 1000 });
    expect(existsSync(tools.prefix)).toBe(true);
    expect(other.removed).not.toContain(tools.prefix);
    // The leave as another login took wsp's folder here, and the record with it.
    addFoundNothing(home);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, uid: 0 });
    expect(swept.removed).toEqual(expect.arrayContaining([join(tools.links, "ruff"), join(tools.links, "tsc"), tools.prefix]));
    expect(existsSync(tools.prefix)).toBe(false);
    expect(readdirSync(tools.links).sort()).toEqual(["env2", "jq", "old"]);
    expect(existsSync(`${tools.prefix}-old`)).toBe(true);
  });

  /** A box as it stood before a joined add: a profile of its own and an install folder holding a file and a toolchain. */
  function boxOfItsOwn(name: string): { home: string; tools: { prefix: string; links: string }; profile: string; place: ReturnType<typeof joinedPlace> } {
    const home = tmp(name);
    const tools = toolsUnder(home);
    const profile = join(home, "etc-apparmor.d", "wsp-workspace");
    mkdirSync(dirname(profile));
    writeFileSync(profile, "profile theirs-never-loaded {}\n");
    mkdirSync(join(tools.prefix, "rustup", "toolchains", "theirs", "bin"), { recursive: true });
    writeFileSync(join(tools.prefix, "rustup", "settings.toml"), "theirs\n");
    writeFileSync(join(tools.prefix, "rustup", "toolchains", "theirs", "bin", "rustc"), "theirs\n");
    writeFileSync(join(tools.prefix, "keep"), "theirs");
    // A name holding a newline, which a record split on lines would read as two names neither of which is it.
    writeFileSync(join(tools.prefix, "two\nlines"), "theirs");
    mkdirSync(tools.links);
    symlinkSync(join(tools.prefix, "rustup", "toolchains", "theirs", "bin", "rustc"), join(tools.links, "rustc-theirs"));
    mkdirSync(placeDaemonPaths(home).wsp);
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    return { home, tools, profile, place };
  }

  /** What the setup does after the add on such a box: a toolchain of its own inside the rustup it found, a command
   * linked out of it, and a manager's folder of its own. */
  function setupInstalled(tools: { prefix: string; links: string }): void {
    mkdirSync(join(tools.prefix, "rustup", "toolchains", "stable", "bin"), { recursive: true });
    writeFileSync(join(tools.prefix, "rustup", "toolchains", "stable", "bin", "rustc"), "wsp's\n");
    symlinkSync(join(tools.prefix, "rustup", "toolchains", "stable", "bin", "rustc"), join(tools.links, "rustc"));
    mkdirSync(join(tools.prefix, "uv", "bin"), { recursive: true });
    writeFileSync(join(tools.prefix, "uv", "bin", "uv"), "wsp's\n");
  }

  /** Everything under a folder, each path relative to it, read without following a link. */
  const tree = (root: string): string[] => execFileSync("/usr/bin/find", [".", "-mindepth", "1"], { cwd: root, encoding: "utf8" }).split("\n").filter(line => line !== "").sort();

  it("takes nothing outside the home where the add left no record, and names what stays", async () => {
    const { home, tools, profile } = boxOfItsOwn("leave-no-record");
    setupInstalled(tools);
    const before = tree(tools.prefix);
    const ran: string[] = [];
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: script => (ran.push(script), ""), uid: 0, apparmorProfile: profile, tools });
    expect(tree(tools.prefix)).toEqual(before);
    expect(readFileSync(profile, "utf8")).toBe("profile theirs-never-loaded {}\n");
    expect(readdirSync(tools.links).sort()).toEqual(["rustc", "rustc-theirs"]);
    expect(ran.some(script => script.includes("apparmor_parser"))).toBe(false);
    expect(swept.removed).toContain(placeOwnersUnknownLine([profile, tools.prefix]));
  });

  it("takes nothing outside the home where the record was cut short, as a deploy killed while writing it leaves it", async () => {
    const { home, tools, profile, place } = boxOfItsOwn("leave-cut-record");
    execFileSync("/bin/sh", ["-c", placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n")]);
    const record = placeDaemonPaths(home).placeFound;
    const whole = readFileSync(record);
    // Cut after the prefix's own line: every entry it held unnamed, as a kill in the middle of the listing leaves it.
    writeFileSync(record, whole.subarray(0, whole.indexOf(`${tools.prefix}\0`) + tools.prefix.length + 1));
    setupInstalled(tools);
    const before = tree(tools.prefix);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => "", uid: 0, apparmorProfile: profile, tools });
    expect(tree(tools.prefix)).toEqual(before);
    expect(existsSync(profile)).toBe(true);
    expect(swept.removed).toContain(placeOwnersUnknownLine([profile, tools.prefix]));
  });

  it("writes no record where the listing did not finish, so the leave takes nothing, and the deploy says so", () => {
    const { home, tools, profile, place } = boxOfItsOwn("found-unfinished");
    // A find that names one path and dies, as one stopped part way through a tree does.
    const bin = tmp("found-unfinished-bin");
    writeStub(join(bin, "find"), `#!/bin/sh\nprintf '%s\\0' ${shellQuote(tools.prefix)}\nexit 1\n`);
    const said = execFileSync("/bin/sh", ["-c", [`PATH=${shellQuote(bin)}:$PATH`, ...placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links })].join("\n")], { encoding: "utf8" });
    expect(said.trim()).toBe(placeFoundSkippedLine(tools.prefix));
    expect(readdirSync(placeDaemonPaths(home).wsp)).toEqual([]);
    // The same box where find runs to its end: one whole record, nothing left beside it.
    execFileSync("/bin/sh", ["-c", placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n")]);
    expect(readdirSync(placeDaemonPaths(home).wsp)).toEqual([basename(placeDaemonPaths(home).placeFound)]);
    expect(readFileSync(placeDaemonPaths(home).placeFound, "utf8").endsWith(`\0${PLACE_FOUND_END}\0`)).toBe(true);
  });

  it("keeps the first add's record through a second add of the same box, so a remove still ends with neither", async () => {
    const home = tmp("found-twice");
    const tools = toolsUnder(home);
    const profile = join(home, "etc-apparmor.d", "wsp-workspace");
    mkdirSync(dirname(profile));
    mkdirSync(tools.links);
    mkdirSync(placeDaemonPaths(home).wsp);
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    const step = placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n");
    execFileSync("/bin/sh", ["-c", step]);
    const first = readFileSync(placeDaemonPaths(home).placeFound);
    // What the first add and its setup put there, then a second add of the same box, whose join is refused after
    // its files step has run.
    writeFileSync(profile, "profile wsp-test-never-loaded {}\n");
    mkdirSync(join(tools.prefix, "uv", "bin"), { recursive: true });
    symlinkSync(join(tools.prefix, "uv", "bin", "uv"), join(tools.links, "uv"));
    execFileSync("/bin/sh", ["-c", step]);
    expect(readFileSync(placeDaemonPaths(home).placeFound)).toEqual(first);
    const sh = (script: string): string => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 0, apparmorProfile: profile, tools });
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(tools.prefix)).toBe(false);
    expect(readdirSync(tools.links)).toEqual([]);
  });

  it("writes the record again where the one standing was cut short", () => {
    const { home, tools, profile, place } = boxOfItsOwn("found-cut-again");
    const step = placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n");
    execFileSync("/bin/sh", ["-c", step]);
    const record = placeDaemonPaths(home).placeFound;
    const whole = readFileSync(record);
    // Cut one byte short, and as a path that only ends in the end entry's name: neither is whole.
    for (const cut of [whole.subarray(0, whole.length - 1), Buffer.from(`/opt/x${PLACE_FOUND_END}\0`)]) {
      writeFileSync(record, cut);
      execFileSync("/bin/sh", ["-c", step]);
      expect(readFileSync(record)).toEqual(whole);
    }
  });

  it("takes what the setup wrote inside a folder that stood before the add, and every path from before stays", async () => {
    const { home, tools, profile, place } = boxOfItsOwn("leave-deep");
    const before = tree(tools.prefix);
    execFileSync("/bin/sh", ["-c", placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n")]);
    setupInstalled(tools);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: () => "", uid: 0, apparmorProfile: profile, tools });
    expect(tree(tools.prefix)).toEqual(before);
    expect(readFileSync(join(tools.prefix, "rustup", "settings.toml"), "utf8")).toBe("theirs\n");
    expect(readdirSync(tools.links)).toEqual(["rustc-theirs"]);
    expect(swept.removed).toEqual(expect.arrayContaining([join(tools.links, "rustc"), join(tools.prefix, "rustup", "toolchains", "stable"), join(tools.prefix, "uv")]));
    // The topmost path that went stands for everything under it.
    expect(swept.removed).not.toContain(join(tools.prefix, "uv", "bin"));
  });


  it("takes the profile and the install folder whole where the add found neither", async () => {
    const home = tmp("leave-made");
    const tools = toolsUnder(home);
    const profile = join(home, "etc-apparmor.d", "wsp-workspace");
    mkdirSync(dirname(profile));
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    mkdirSync(placeDaemonPaths(home).wsp);
    execFileSync("/bin/sh", ["-c", placeFoundStep(place, { profile, prefix: tools.prefix, links: tools.links }).join("\n")]);
    expect(readFileSync(placeDaemonPaths(home).placeFound, "utf8")).toBe(`${PLACE_FOUND_END}\0`);
    writeFileSync(profile, "profile wsp-test-never-loaded {}\n");
    mkdirSync(join(tools.prefix, "uv"), { recursive: true });
    // A name no kernel holds: the unload runs for real as root, and the machine's own wsp-workspace must stay loaded.
    const sh = (script: string): string => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 0, apparmorProfile: profile, tools });
    expect(swept.removed).toEqual(expect.arrayContaining([profile, tools.prefix]));
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(tools.prefix)).toBe(false);
  });

  it("leaves a profile that stood before a joined add as it is and says so, and a fork's deploy asks nothing of one", () => {
    const home = tmp("deploy-stood");
    const profile = join(home, "etc apparmor.d", "wsp-workspace");
    mkdirSync(dirname(profile));
    writeFileSync(profile, "profile theirs {}\n");
    // A parser that would load anything it is given, so a profile written over would read as loaded.
    const bin = tmp("deploy-stood-bin");
    writeStub(join(bin, "apparmor_parser"), "#!/bin/sh\nexit 0\n");
    const place = joinedPlace({ home, path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: `${placeDaemonPaths(home).wsp}/join-code`, name: "box" });
    const step = apparmorStep(place, GUEST_DAEMON_TARGETS[0]!, profile);
    const said = execFileSync("/bin/sh", ["-c", [`PATH=${shellQuote(bin)}:$PATH`, ...step].join("\n")], { encoding: "utf8" });
    expect(said.trim()).toBe(apparmorStoodLine(profile));
    expect(readFileSync(profile, "utf8")).toBe("profile theirs {}\n");
    expect(apparmorStep(sshDaemonPlace({ home, path: "/usr/bin:/bin" }), GUEST_DAEMON_TARGETS[0]!, profile)[0]).toMatch(/^if command -v apparmor_parser/);
  });

  it("leaves wsp's install folder where it is a link, and says so", async () => {
    const home = tmp("leave-tools-link");
    addFoundNothing(home);
    const tools = toolsUnder(home);
    const elsewhere = tmp("leave-tools-elsewhere");
    writeFileSync(join(elsewhere, "keep"), "theirs");
    symlinkSync(elsewhere, tools.prefix);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, uid: 0 });
    expect(swept.removed).toContain(placeKeptForLinkLine(tools.prefix));
    expect(existsSync(join(elsewhere, "keep"))).toBe(true);
  });

  it("takes the binaries the setup wrote outside the home where the leave runs as root, and keeps the box's own", async () => {
    const home = tmp("leave-outside");
    addFoundNothing(home);
    const system = realpathSync(tmp("leave-outside-root"));
    const sh = shWithSha256sum();
    mkdirSync(join(system, "usr/local/bin"), { recursive: true });
    writeFileSync(join(system, "usr/local/bin/jq"), "the box's own jq\n");
    sh(outsideBeforeScript("agents", ["/usr/local/bin"], system));
    writeFileSync(join(system, "usr/local/bin/claude"), "claude 2.1.280\n");
    writeFileSync(join(system, "usr/local/bin/gopls"), "gopls\n");
    writeFileSync(join(system, "usr/local/bin/jq"), "jq over the box's own\n");
    sh(outsideAfterScript("agents", ["/usr/local/bin"], system));
    const tools = { prefix: join(system, TOOL_PREFIX), links: join(system, "usr/local/bin") };
    const other = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 1000, tools, systemRoot: system });
    expect(other.removed).not.toContain(join(system, "usr/local/bin/claude"));
    expect(existsSync(join(system, "usr/local/bin/claude"))).toBe(true);
    // The leave before this one took wsp's folder here, and the record with it.
    addFoundNothing(home);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh, uid: 0, tools, systemRoot: system });
    expect(swept.removed).toEqual(expect.arrayContaining([join(system, "usr/local/bin/claude"), join(system, "usr/local/bin/gopls"), tools.prefix]));
    expect(readdirSync(join(system, "usr/local/bin"))).toEqual(["jq"]);
    expect(existsSync(tools.prefix)).toBe(false);
  });

  it("keeps wsp's install folder and its list when the leave outside the home was cut short, and says so", async () => {
    const home = tmp("leave-outside-cut");
    addFoundNothing(home);
    const system = realpathSync(tmp("leave-outside-cut-root"));
    const whole = shWithSha256sum();
    mkdirSync(join(system, "usr/local/bin"), { recursive: true });
    whole(outsideBeforeScript("agents", ["/usr/local/bin"], system));
    writeFileSync(join(system, "usr/local/bin/claude"), "claude 2.1.280\n");
    whole(outsideAfterScript("agents", ["/usr/local/bin"], system));
    // The shell running the leave killed part way, as a bound kills it; the read answers nothing, as the leave's own does.
    const stub = tmp("leave-outside-cut-stub");
    writeStub(join(stub, "xargs"), "#!/bin/sh\nkill -KILL $PPID\n");
    const cut = (script: string): string => {
      try {
        return whole(`PATH=${shellQuote(stub)}:$PATH\n${script}`);
      } catch {
        return "";
      }
    };
    const tools = { prefix: join(system, TOOL_PREFIX), links: join(system, "usr/local/bin") };
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: cut, uid: 0, tools, systemRoot: system });
    expect(swept.removed).toContain(placeOutsideLeftLine(tools.prefix));
    expect(existsSync(join(tools.prefix, "landed"))).toBe(true);
    expect(existsSync(join(system, "usr/local/bin/claude"))).toBe(true);
    // The leave before this one took wsp's folder here, and the record with it.
    addFoundNothing(home);
    const again = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: whole, uid: 0, tools, systemRoot: system });
    expect(again.removed).toEqual(expect.arrayContaining([join(system, "usr/local/bin/claude"), tools.prefix]));
    expect(existsSync(tools.prefix)).toBe(false);
  });

  it("says what the manager answered when the stop refused, and still takes the file", async () => {
    const home = tmp("leave-stop-refused");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    // Every command answered as it would be, except the stop: this is a unit systemd will not let go of, which is
    // the one case where a line reading (stopped) would be telling a person something they cannot check.
    const refusing: ServiceRunner = argv => (argv[1] === "stop" || argv[2] === "stop" ? Promise.resolve({ code: 5, output: "Failed to stop: Unit is masked." }) : runner.run(argv));
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const swept = await sweepPlace({ home, manager, run: refusing, uid: 0 });
    expect(swept.removed[0]).toBe(`systemd system unit ${unit.name} (systemctl stop ${unit.name} exited 5 and said: Failed to stop: Unit is masked.)`);
    // A manager answers in as many lines as it likes, and this line is one thing among what a leave took: a host
    // reading that leave back over ssh reads the lines by the mark in front of them, which only the first of a
    // wrapped line would carry.
    const wordy: ServiceRunner = argv =>
      argv[1] === "stop" || argv[2] === "stop" ? Promise.resolve({ code: 5, output: "Failed to stop:\n  Unit is masked.\n  See systemctl status." }) : runner.run(argv);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    const wrapped = await sweepPlace({ home, manager, run: wordy, uid: 0 });
    expect(wrapped.removed[0]).toBe(`systemd system unit ${unit.name} (systemctl stop ${unit.name} exited 5 and said: Failed to stop: Unit is masked. See systemctl status.)`);
    expect(sweptSaid(wrapped.removed.map(line => sweptLine(line)).join("\n"))).toEqual(wrapped.removed);
    // The file goes all the same: a person running a leave has decided this computer is out of that wsp, and a
    // unit file left behind is what brings the agent back at the next boot.
    expect(existsSync(unit.path)).toBe(false);
    // And the rest of the teardown was still told: the refusal is this scope's line, not the end of the sweep.
    expect(runner.ran).toContainEqual(["systemctl", "disable", unit.name]);
    expect(runner.ran).toContainEqual(["systemctl", "daemon-reload"]);
  });

  it("takes the unit a computer joined on the older road left in that login's own systemd, and names the scope", async () => {
    const home = tmp("leave-user-scope");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const at: ServiceAddress = { role: "place", statePath: placeFilePath(home), home, uid: 0 };
    const name = SERVICE_MANAGERS.systemd.unit(at).name;
    // Only the login's own systemd holds one: a join before the place's unit became the machine's wrote it there,
    // and the machine's folder is empty, which is the whole of what the sweep used to look at.
    const login = join(home, ".config", "systemd", "user", name);
    mkdirSync(dirname(login), { recursive: true });
    writeFileSync(login, "[Unit]\n");
    expect(existsSync(manager.unit(at).path)).toBe(false);
    const swept = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    expect(existsSync(login)).toBe(false);
    expect(swept.removed).toContain(`systemd user unit ${name} (stopped)`);
    // That login's own systemd is the one told to forget it: a machine-scoped disable never reaches this unit.
    expect(runner.ran).toContainEqual(["systemctl", "--user", "disable", name]);
  });

  it("takes the servers wsp merged into an agent's own file here back out of it, and leaves that file's every other line", async () => {
    const home = tmp("leave-servers");
    const at = placeProvisionPaths(home);
    mkdirSync(at.dir, { recursive: true });
    const config = join(home, ".codex", "config.toml");
    mkdirSync(dirname(config), { recursive: true });
    const theirs = ['model = "gpt-5"', "", '[projects."/root/repo"]', 'trust_level = "trusted"', "", "[mcp_servers.mine]", 'command = "/usr/local/bin/mine"', ""];
    const text = [...theirs, "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', ""].join("\n");
    writeFileSync(config, text);
    const digest = createHash("sha256").update(CODEX_TOML.entryOf(text, "context7")!).digest("hex");
    // What the servers round wrote down: the key it merged in, and one whose entry the agent has rewritten since.
    writeFileSync(at.landed, `${MCP_ID_PREFIX}codex/context7\t${digest}\t${digest}\n${MCP_ID_PREFIX}codex/mine\tdeadbeef\tdeadbeef\n`);

    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run, sh: shWithSha256sum() });
    // The file is the agent's own and stays; wsp's table is out of it and every other line is where it was.
    expect(readFileSync(config, "utf8")).toBe(theirs.join("\n"));
    expect(swept.removed).toContain(`context7 (out of ${config})`);
    expect(swept.removed.some(took => took.includes("mine"))).toBe(false);
    // Nothing of wsp's own is left beside the file it wrote back.
    expect(existsSync(`${config}.wsp-new`)).toBe(false);
    expect(existsSync(placeDaemonPaths(home).wsp)).toBe(false);
  });

  it("takes nothing off a computer that took nothing: the sweep is every path named and no more", async () => {
    const home = tmp("leave-bare");
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(swept.removed.filter(line => line.startsWith("/"))).toEqual([]);
    expect(swept.kept[0]).toContain(join(home, "wsp-work"));
  });
});

describe("a join with more than one address to try", () => {
  it("keeps every address it was given, the one that answered first", async () => {
    const home = tmp("join-urls");
    const host = await fakeHost();
    const io = captured();
    const args = ["http://127.0.0.1:1", host.url, "http://10.0.0.2:4400"];
    expect(await joinCommand(io, args, { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    // The one that answered, then the rest: that is the order the link dials them in from now on.
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([host.url, "http://127.0.0.1:1", "http://10.0.0.2:4400"]);
  });

  it("tries the next address when the first answers nothing, and says which one went nowhere", async () => {
    const home = tmp("join-next");
    const host = await fakeHost();
    const io = captured();
    // Port 1 on loopback answers nothing at all, which is the address an installer picked that this computer cannot route to.
    expect(await joinCommand(io, ["http://127.0.0.1:1", host.url], { code: codeFor(host, "7QK3M2VD") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(io.errors.join("\n")).toContain("http://127.0.0.1:1");
    expect(readPlaceFile(placeFilePath(home))!.hostUrls[0]).toBe(host.url);
  });

  it("stops at a host's own refusal rather than asking its other addresses the same question", async () => {
    const home = tmp("join-refused");
    const host = await fakeHost({ refuse: "that join code is not one this host is waiting for" });
    const io = captured();
    await expect(joinCommand(io, [host.url, "http://127.0.0.1:1"], { code: codeFor(host, "SPENT") }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow("not one this host is waiting for");
    expect(io.errors.join("\n")).not.toContain("http://127.0.0.1:1");
    expect(existsSync(placeFilePath(home))).toBe(false);
  });
});
