// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DAEMON_VERSION, PLACE_SUDO_KIND, hostKeyMismatchRefusal, PLACE_LEAVE_VERB, PlaceReport, placeDaemonPaths, shellQuote, workFolderIn, wsUrlOf } from "@wsp/protocol";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { PlaceHostKeyChangedError, PlaceLoginRefusedError } from "@wsp/runtime";
import { SSH_SUDO_READ, keyFingerprint, type SshReach, type SshTransport } from "@wsp/engine";
import { daemonBinaryHere } from "../src/assets.js";
import { noPlaceSystemLine } from "../src/daemon-binary.js";
import { DAEMON_GONE_LINE, daemonFlags, sshDaemonPlace } from "../src/doctor.js";
import { deviceLeftLine, joinCommand, placeDaemonFlags, preparePlaceHome, joinPlace, placeNameHere, removeCommand, placeLeaver, placeRunner, placeLeaveFailedLine, placeNoKeyForSudoLine, placeSudoReader, placeUndoer, placeUndoNeedsSudoLine, placeUndoNoKeyLine, placeUndoOtherKeyLine, sudoPasswordAsk } from "../src/places.js";
import { placeFilePath, placeKeyPath, readPlaceFile, sweptLine, writePlaceFile } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { type ServiceRunner } from "../src/service.js";
import { codeFor, fakeHost, fakeRunner, joinDepsFor, leaveCommand, noBoxSignIn, NOWHERE_CODE, opts, sweepPlace, tmp, unitsUnder } from "./places-fixture.js";

describe("the leave over the ssh road, which a remove takes wherever this host holds a login", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the line it was asked to run. */
  const leaver = (answer: { exitCode: number; stdout?: string; stderr?: string }) => {
    const asked: { reach: SshReach; script: string; sudoPassword?: string }[] = [];
    const transport: SshTransport = async (reach, script, opts) => {
      asked.push({ reach, script, ...(opts.sudoPassword === undefined ? {} : { sudoPassword: opts.sudoPassword }) });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    };
    return { asked, leave: placeLeaver({ transport }) };
  };

  /** The line that box said starts its own wsp, which is the one this road runs the leave with. */
  const WSP = ["/usr/bin/node", "/home/maya/.wsp/daemon/wsp/dist/bin.js"];

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "vps",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: DAEMON_VERSION,
    agents: [],
    wsp: WSP,
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  const asking = (report: PlaceReport = reportOf()) => ({
    placeId: "p_1",
    name: "vps",
    report,
    ssh: { ssh: "root@65.21.4.12:2222", keyPath: "/Users/lena/.ssh/hetzner" },
  });

  it("runs the leave that computer already carries, over the login on the record, and spells no sweep of its own", async () => {
    const { asked, leave } = leaver({ exitCode: 0 });
    await leave(asking());
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toMatchObject({ user: "root", host: "65.21.4.12", port: 2222, keyPath: "/Users/lena/.ssh/hetzner" });
    // The line the box itself reported for running wsp there, word for word, with the verb off its one spelling.
    expect(asked[0]!.script).toBe(`${WSP.join(" ")} ${PLACE_LEAVE_VERB}`);
    // What comes off that computer and in what order is its own leave's: a manager command or a path written from
    // here would be a second copy of the sweep, one that ages the day the unit scheme or the path list moves.
    expect(asked[0]!.script).not.toContain("systemctl");
    expect(asked[0]!.script).not.toContain("rm ");
    const at = placeDaemonPaths("/home/maya");
    for (const path of [at.placeFile, at.placeKey, at.tokenPath, at.inbox]) expect(asked[0]!.script).not.toContain(path);
  });

  it("runs one script over the same login for a remove that finds no link up, and says ssh's own line where the login would not stand", async () => {
    const asked: { reach: SshReach; script: string; timeoutMs?: number }[] = [];
    const transport: SshTransport = async (reach, script, o) => {
      asked.push({ reach, script, ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });
      return { exitCode: 1, stdout: "", stderr: "Plugin is in use" };
    };
    const said = await placeRunner({ transport })({ ssh: "root@65.21.4.12:2222", keyPath: "/Users/lena/.ssh/hetzner" }, "claude plugin uninstall 'x@y'", 5_000);
    expect(said).toEqual({ exitCode: 1, stdout: "", stderr: "Plugin is in use" });
    expect(asked[0]!.reach).toMatchObject({ user: "root", host: "65.21.4.12", port: 2222, keyPath: "/Users/lena/.ssh/hetzner" });
    expect(asked[0]!.script).toBe(`bash -c ${shellQuote("claude plugin uninstall 'x@y'")}`);
    expect(asked[0]!.timeoutMs).toBe(5_000);
    const refused = placeRunner({ transport: async () => ({ exitCode: 255, stdout: "", stderr: "ssh: connect to host 65.21.4.12 port 2222: Connection refused" }) });
    await expect(refused({ ssh: "root@65.21.4.12:2222" }, "true", 5_000)).rejects.toBeInstanceOf(PlaceLoginRefusedError);
  });

  it("reads back what that leave said it took, and none of the sentences a person reads around them", async () => {
    const home = tmp("leave-over-ssh");
    const at = placeDaemonPaths(home);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "vps", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    writeFileSync(placeKeyPath(home), "key");
    writeFileSync(at.tokenPath, "token");
    mkdirSync(at.inbox, { recursive: true });
    const io = captured();
    expect(await leaveCommand(io, [], { home, run: fakeRunner().run, platform: "linux" })).toBe(0);
    // The box's own leave, printed as that computer would print it: this road reads it back by the one rule that
    // leave marks what it took with, so the two cannot drift apart.
    const { leave } = leaver({ exitCode: 0, stdout: `${io.lines.join("\n")}\n` });
    const swept = await leave(asking());
    expect(swept).toContain(placeFilePath(home));
    expect(swept).toContain(at.tokenPath);
    // The work folder is the person's and stayed; which wsp the computer left and what the host still has to be
    // told are its terminal's to say, not things that came off it.
    expect(swept.some(line => line.includes("stays: the work your threads did there is yours"))).toBe(false);
    expect(swept.some(line => line.includes("left the wsp at"))).toBe(false);
    expect(swept.some(line => line.includes("wsp remove"))).toBe(false);
  });

  it("hands back ssh's own line where the login will not stand, so the remove says the agent is still installed", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const { leave } = leaver({ exitCode: 255, stderr: `debug1: Reading configuration data\n${said}\n` });
    await expect(leave(asking())).rejects.toThrow(said);
    await expect(leave(asking())).rejects.not.toThrow(/debug/);
    // The refusal of the login itself, as its own kind: nothing ran on that computer, and the line a remove reads
    // out turns on telling that from a leave that ran there and stopped.
    await expect(leave(asking())).rejects.toBeInstanceOf(PlaceLoginRefusedError);
  });

  it("carries that computer's own words where the leave ran there and stopped, rather than ssh's", async () => {
    const { leave } = leaver({ exitCode: 1, stdout: "this computer is not a place in any wsp, so there is nothing to leave\n" });
    await expect(leave(asking())).rejects.toThrow(placeLeaveFailedLine("vps", { stdout: "this computer is not a place in any wsp, so there is nothing to leave\n", stderr: "" }));
    await expect(leave(asking())).rejects.not.toThrow(/refused the login over ssh/);
    // The login stood, so this is not the refusal kind: what came back is that computer talking.
    await expect(leave(asking())).rejects.not.toBeInstanceOf(PlaceLoginRefusedError);
  });

  it("says the wait ran out where that computer answered nothing at all, rather than ending on a colon", async () => {
    const { leave } = leaver({ exitCode: 124 });
    await expect(leave(asking())).rejects.toThrow("vps ran the leave and had not finished it within 180s");
    expect(placeLeaveFailedLine("vps", { stdout: "", stderr: "" })).not.toMatch(/:$/);
  });

  it("runs whatever line that computer said starts its wsp, including the bare word a box with none falls back to", async () => {
    const { asked, leave } = leaver({ exitCode: 0 });
    await leave(asking(reportOf({ wsp: ["wsp"] })));
    expect(asked[0]!.script).toBe(`wsp ${PLACE_LEAVE_VERB}`);
  });

  it("brings back a sweep that stopped the agent and disabled it while its unit file stood, and reloaded once it had gone", async () => {
    const home = tmp("leave-road-unit");
    const manager = unitsUnder(home);
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "vps", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
    const unit = manager.unit({ role: "place", statePath: placeFilePath(home), home, uid: 0 });
    mkdirSync(dirname(unit.path), { recursive: true });
    writeFileSync(unit.path, "[Unit]\n");
    // What the manager was asked, and whether the unit file was still there when it was asked: the removal is the
    // one step of the order that runs no command, and a sweep that took the file first leaves systemd restarting
    // an agent with nothing to serve.
    const seen: { argv: string[]; unitThere: boolean }[] = [];
    const watching: ServiceRunner = argv => {
      seen.push({ argv: [...argv], unitThere: existsSync(unit.path) });
      return runner.run(argv);
    };
    // The computer at the end of the road, running the leave it already carries: the sweep is that computer's own
    // and this host reads back what it printed by the one mark those lines carry.
    const said = await sweepPlace({ home, manager, run: watching, uid: 0 });
    expect(seen).toEqual([
      { argv: ["systemctl", "stop", unit.name], unitThere: true },
      { argv: ["systemctl", "disable", unit.name], unitThere: true },
      { argv: ["systemctl", "daemon-reload"], unitThere: false },
      { argv: ["systemctl", "--user", "stop", unit.name], unitThere: false },
      { argv: ["systemctl", "--user", "disable", unit.name], unitThere: false },
    ]);
    const printed = ["vps left the wsp at http://192.168.1.20:4400; removed:", ...said.removed.map(line => sweptLine(line)), ...said.kept];
    const { leave } = leaver({ exitCode: 0, stdout: `${printed.join("\n")}\n` });
    // What came back over the road names the unit among what went, so a person reading a remove sees the service
    // go and not only the files.
    expect(await leave(asking())).toContain(`systemd system unit ${unit.name} (stopped)`);
    expect(await leave(asking())).toContain(placeFilePath(home));
  });
});

describe("root over a login whose sudo asks for a password, for a remove and an update", () => {
  /** A box whose login read and password try answer the way sudo there would. */
  const box = (road: string, tried: { stdout?: string; stderr?: string } = {}) => {
    const asked: { script: string; asLogin?: boolean; stdin?: string; sudoPassword?: string }[] = [];
    const transport: SshTransport = async (_reach, script, opts) => {
      asked.push({ script, ...(opts.asLogin === true ? { asLogin: true } : {}), ...(opts.stdin === undefined ? {} : { stdin: Buffer.from(opts.stdin).toString() }), ...(opts.sudoPassword === undefined ? {} : { sudoPassword: opts.sudoPassword }) });
      if (script === SSH_SUDO_READ) return { exitCode: 0, stdout: `WSP_SUDO ${road}\n`, stderr: "" };
      return { exitCode: tried.stdout === undefined ? 1 : 0, stdout: tried.stdout ?? "", stderr: tried.stderr ?? "" };
    };
    return { asked, transport };
  };
  const KEPT = "ssh-ed25519 SHA256:kept-at-the-add";
  const login = { ssh: "maya@box", hostKey: KEPT };
  const act = { verb: "remove" as const, name: "vps" };
  /** The key the box answers with now, as this computer's ssh client reads it, and where it wrote it. */
  const keys = (now: string | undefined = KEPT) => ({ hostKey: async () => now, knownHosts: async () => ({ file: "/root/.ssh/known_hosts", target: "box" }) });

  it("refuses with the add's kind and the remove's own fix where sudo asks, and tries a typed password as the login", async () => {
    const asks = box("asks", { stdout: "WSP_SUDO taken\n" });
    const read = placeSudoReader({ transport: asks.transport, ...keys() });
    const said = await read(login, undefined, act).catch((e: unknown) => e as Error & { kind?: string; fix?: string });
    expect(said).toMatchObject({ kind: PLACE_SUDO_KIND, message: "sudo on maya@box asks for maya's password. Type it in the app's Remove confirm, or at wsp remove vps in a terminal, which hand it to sudo there and keep it nowhere." });
    expect(await read(login, "Tq-not-a-real-pw", act)).toBe("taken");
    expect(asks.asked.map(a => [a.script === SSH_SUDO_READ ? "read" : "try", a.asLogin, a.stdin])).toEqual([["read", true, undefined], ["read", true, undefined], ["try", true, "Tq-not-a-real-pw\n"]]);
    const update = await read(login, undefined, { verb: "update", name: "vps" }).catch((e: unknown) => e as Error);
    expect((update as Error).message).toContain("Type it at wsp add vps --update in a terminal");
    expect(await placeSudoReader({ transport: box("free").transport, ...keys() })(login, "stray", act)).toBe("free");
    await expect(placeSudoReader({ transport: box("tty").transport })(login, undefined, act)).rejects.toThrow("Defaults:maya !requiretty");
  });

  it("holds the box's key against the one the add kept before the password is asked for or tried, and refuses a record that kept none", async () => {
    // The add's own mismatch line tells a person to take the old entry out; after that ssh's accept-new takes any
    // key, so the remove that follows is held against the record's key, not ssh's.
    const changed = box("asks", { stdout: "WSP_SUDO taken\n" });
    const said = await placeSudoReader({ transport: changed.transport, ...keys("ssh-ed25519 SHA256:somebody-else") })(login, "Tq-not-a-real-pw", act).catch((e: unknown) => e as Error & { kind?: string });
    expect((said as Error).message).toBe(hostKeyMismatchRefusal({ address: "maya@box", pinned: KEPT, wrote: "ssh-ed25519 SHA256:somebody-else", target: "box", file: "/root/.ssh/known_hosts" }));
    expect((said as { kind?: string }).kind).toBeUndefined();
    // Its own class, which a remove reads as a login reaching another machine and lets the record go on.
    expect(said).toBeInstanceOf(PlaceHostKeyChangedError);
    expect(changed.asked.map(a => a.script)).toEqual([SSH_SUDO_READ]);
    expect(changed.asked.some(a => a.stdin !== undefined || a.sudoPassword !== undefined)).toBe(false);
    // A record made before the key was kept, or one whose add could read none: no password road at all.
    const bare = box("asks", { stdout: "WSP_SUDO taken\n" });
    await expect(placeSudoReader({ transport: bare.transport, ...keys() })({ ssh: "maya@box" }, "Tq-not-a-real-pw", act)).rejects.toThrow(placeNoKeyForSudoLine("maya@box", "box"));
    expect(bare.asked.map(a => a.script)).toEqual([SSH_SUDO_READ]);
    expect(placeNoKeyForSudoLine("maya@box", "box")).toContain("remove it as root@box");
    // A login that reaches root with no password sends none, so it is not held to a key it never needed.
    expect(await placeSudoReader({ transport: box("free").transport, ...keys("ssh-ed25519 SHA256:somebody-else") })({ ssh: "maya@box" }, undefined, act)).toBe("free");
  });

  it("hands the password the remove carries to the leave and the scripts it runs over ssh, as sudo's input and never their own", async () => {
    const asked: { script: string; sudoPassword?: string }[] = [];
    const transport: SshTransport = async (_reach, script, opts) => {
      asked.push({ script, ...(opts.sudoPassword === undefined ? {} : { sudoPassword: opts.sudoPassword }) });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await placeLeaver({ transport })({ placeId: "p_1", name: "vps", report: { wsp: ["wsp"] } as unknown as PlaceReport, ssh: login, sudoPassword: "Tq-not-a-real-pw" });
    await placeRunner({ transport })(login, "true", 1000, "Tq-not-a-real-pw");
    await placeRunner({ transport })(login, "true", 1000);
    expect(asked.map(a => a.sudoPassword)).toEqual(["Tq-not-a-real-pw", "Tq-not-a-real-pw", undefined]);
    expect(asked.map(a => a.script).join("\n")).not.toContain("Tq-not-a-real-pw");
  });

  it("says an undo on a box whose sudo asks for a password stays undone, with the line to run there", async () => {
    const transport: SshTransport = async () => ({ exitCode: 1, stdout: "", stderr: "sudo: a password is required\n" });
    await expect(placeUndoer({ transport, hostKey: async () => KEPT })(login, "true")).rejects.toThrow(placeUndoNeedsSudoLine("maya@box"));
    expect(placeUndoNeedsSudoLine("maya@box")).toContain("log in there and run wsp leave");
  });

  it("runs an undo only on the box that answers with the key the add saw, and nothing where it kept none", async () => {
    const ran: string[] = [];
    const transport: SshTransport = async (_reach, script) => (ran.push(script), { exitCode: 0, stdout: `${DAEMON_GONE_LINE}\n`, stderr: "" });
    await expect(placeUndoer({ transport, hostKey: async () => "ssh-ed25519 SHA256:another-box" })(login, "true")).rejects.toThrow(placeUndoOtherKeyLine("maya@box"));
    await expect(placeUndoer({ transport, hostKey: async () => undefined })(login, "true")).rejects.toThrow(placeUndoOtherKeyLine("maya@box"));
    await expect(placeUndoer({ transport, hostKey: async () => KEPT })({ ssh: "maya@box" }, "true")).rejects.toThrow(placeUndoNoKeyLine("maya@box"));
    expect(ran).toEqual([]);
    await placeUndoer({ transport, hostKey: async () => KEPT })(login, "true");
    expect(ran).toHaveLength(1);
  });

  it("asks at the terminal once for a remove the host refused for the password, and removes again carrying it", async () => {
    const home = tmp("remove-sudo");
    const asked: string[] = [];
    const io = { ...captured(), isTTY: true, askSecret: async (q: string) => (asked.push(q), "Tq-not-a-real-pw") };
    const removes: (string | undefined)[] = [];
    const dial = () =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          if (op === "places.list") return Promise.resolve({ places: [{ id: "p_1", kind: "computer", name: "vps", default: true, joinedAt: new Date(0).toISOString(), road: { ssh: "maya@box" } }] } as never);
          if (op === "places.remove") {
            removes.push(params?.["sudoPassword"] as string | undefined);
            if (params?.["sudoPassword"] === undefined) return Promise.reject(Object.assign(new Error("maya@box runs sudo only with maya's password. Type it at wsp remove vps in a terminal."), { kind: PLACE_SUDO_KIND }));
            return Promise.resolve({ removed: true, swept: [] } as never);
          }
          if (op === "devices.list") return Promise.resolve({ devices: [] } as never);
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: () => () => {},
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await removeCommand(io, opts, ["vps"], { dial, now: () => 0, run: fakeRunner().run, platform: "linux", checkKey: async () => ({ state: "taken" }), ...noBoxSignIn })).toBe(0);
    expect(asked).toEqual([sudoPasswordAsk("maya@box", false)]);
    expect(removes).toEqual([undefined, "Tq-not-a-real-pw"]);
    expect(io.screen).not.toContain("Tq-not-a-real-pw");
  });
});

describe("what a remove says about the device the join bought", () => {
  const removeClient = (devices: { id: string; name: string }[]): NonNullable<Parameters<typeof removeCommand>[3]>["dial"] => () =>
    Promise.resolve({
      request: (op: string) => {
        if (op === "places.list") return Promise.resolve({ places: [{ id: "p_1", kind: "computer", name: "old-macbook", default: true, joinedAt: new Date(0).toISOString() }] } as never);
        if (op === "places.remove") return Promise.resolve({ removed: true, swept: ["/Users/maya/.wsp/place.json"], dropped: [] } as never);
        if (op === "devices.list") return Promise.resolve({ devices } as never);
        return Promise.reject(new Error(`unexpected op ${op}`));
      },
      events: () => Promise.resolve(),
      onFrame: () => () => {},
      closed: Promise.resolve(),
      closeWords: () => "",
      close: () => {},
      drop: () => {},
    } as never);

  const removeDeps = (dial: NonNullable<Parameters<typeof removeCommand>[3]>["dial"]): Parameters<typeof removeCommand>[3] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("names the token that computer's window still holds and how to take it back", async () => {
    const home = tmp("remove-device");
    const io = captured();
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await removeCommand(io, opts, ["old-macbook"], removeDeps(removeClient([{ id: "d_1", name: "old-macbook" }])))).toBe(0);
    const said = io.lines.join("\n");
    expect(said).toContain(deviceLeftLine("old-macbook", ["d_1"]));
    expect(said).toContain("wsp host devices revoke d_1 takes it back.");
    // One command per id, since wsp host devices revoke takes exactly one.
    expect(deviceLeftLine("old-macbook", ["d_1", "d_2"])).toContain("wsp host devices revoke d_1, wsp host devices revoke d_2 take them back.");
    // The line sits before the last one, so what is gone is still the sentence the remove ends on.
    expect(io.lines.at(-1)).toBe("old-macbook is no longer a place in this wsp.");
  });

  it("says nothing about devices when no device wears that computer's name", async () => {
    const home = tmp("remove-no-device");
    const io = captured();
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await removeCommand(io, opts, ["old-macbook"], removeDeps(removeClient([{ id: "d_2", name: "a browser tab" }])))).toBe(0);
    expect(io.lines.join("\n")).not.toContain("wsp host devices revoke");
  });
});

describe("a join as the app's shell runs it", () => {
  it("names the shim it was handed as this computer's wsp, writes the wsp's name and buys the window its token", async () => {
    const home = tmp("join-shell");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    const joined = await joinPlace(io, {
      home,
      addresses: [host.url],
      code: "7QK3M2VD",
      hostKey: keyFingerprint(host.publicKey),
      name: "old-macbook",
      client: true,
      wsp: { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "", shim: `${home}/.wsp/bin/wsp` },
      platform: "linux",
      manager: unitsUnder(home),
      uid: 0,
      run: runner.run,
      dial: url => new WebSocket(wsUrlOf(url)),
    });
    expect(joined).toMatchObject({ hostName: "zingzy-mbp", hostUrls: [host.url], device: { deviceId: "d_1", deviceToken: "dev-token" } });
    expect(joined.report.name).toBe("old-macbook");
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ hostName: "zingzy-mbp", name: "old-macbook" });
    const unitDir = join(home, "etc-systemd-system");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    // The unit runs the daemon; the shim is what the daemon reports as the wsp a turn's agent runs here.
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain(`'--wsp-argv' '${home}/.wsp/bin/wsp'`);
    // The client rode the join frame, which is what the one code bought a device for, and it wears the place's own
    // name rather than this computer's: wsp remove finds the token a computer still holds by the place's name, so a
    // second word here would be a device nothing could ever name. The two are different words in this run.
    expect(placeNameHere()).not.toBe("old-macbook");
    expect(host.frames.find(f => f["op"] === "place.prove")!["client"]).toEqual({ name: "old-macbook" });
  });

  it("is the same road the command line takes, which hands the daemon binary and its flags", async () => {
    const home = tmp("join-cli-argv");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, "etc-systemd-system");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    // Nothing on that road asks for a window, so nothing on it buys a device.
    expect(host.frames.find(f => f["op"] === "place.prove")!["client"]).toBeUndefined();
  });

  it("takes a bare host and port as the join screen shows it, and refuses a word that is no address", async () => {
    const home = tmp("join-bare");
    const host = await fakeHost();
    const bare = new URL(host.url).host;
    expect(await joinCommand(captured(), [bare], { code: codeFor(host, "A") }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([`http://${bare}`]);
    await expect(joinCommand(captured(), ["box"], { code: NOWHERE_CODE }, joinDepsFor(tmp("join-word"), fakeRunner().run))).rejects.toThrow(/not an address/);
  });
});

describe("the daemon's line on a joined computer", () => {
  it("is the flags every daemon under a login takes, told the place kind, then the place file, the home, the wsp line and the agents", () => {
    const home = "/home/maya";
    const file = placeDaemonPaths(home).placeFile;
    const flags = placeDaemonFlags(home, file, { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "" });
    const at = placeDaemonPaths(home);
    // Loopback, a port of the machine's own, every file under the login's folder, and the kind that picks the readings.
    expect(flags.slice(0, flags.indexOf("--home"))).toEqual(daemonFlags(sshDaemonPlace({ home, path: "" })));
    expect(flags).toContain("127.0.0.1");
    expect(flags[flags.indexOf("--kind") + 1]).toBe("place");
    expect(flags[flags.indexOf("--port-file") + 1]).toBe(at.portFile);
    expect(flags[flags.indexOf("--token-path") + 1]).toBe(at.tokenPath);
    expect(flags[flags.indexOf("--home") + 1]).toBe(home);
    expect(flags[flags.indexOf("--work-folder") + 1]).toBe(workFolderIn(home));
    expect(flags[flags.indexOf("--place-file") + 1]).toBe(file);
    // The line that runs wsp here, one word per flag, with the verb left for the daemon to add.
    const wsp = flags.flatMap((word, i) => (word === "--wsp-argv" ? [flags[i + 1]] : []));
    expect(wsp).toEqual(["/usr/bin/node", "/opt/wsp/bin.js"]);
    // Every catalog agent as id=command: the daemon looks each one up on PATH at every dial.
    const agents = flags[flags.indexOf("--agents") + 1]!.split(",");
    expect(agents).toEqual(CATALOG_AGENTS.map(a => `${a.id}=${a.bin}`));
    expect(agents.length).toBeGreaterThan(0);
  });

  it("what the daemon needs on disk is made before it starts: wsp's folder, the inbox, the work folder and a fresh token nobody else can read", () => {
    const home = tmp("place-home");
    preparePlaceHome(home);
    const at = placeDaemonPaths(home);
    for (const dir of [at.wsp, at.inbox, workFolderIn(home)]) expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(at.tokenPath).mode & 0o777).toBe(0o600);
    const first = readFileSync(at.tokenPath, "utf8");
    expect(first).toMatch(/^[0-9a-f]{48}\n$/);
    // Minted again at every start: the host replaces it on its first reach either way.
    preparePlaceHome(home);
    expect(readFileSync(at.tokenPath, "utf8")).not.toBe(first);
  });
});

describe("the sweep a joined computer runs on itself", () => {
  it("leaves no unit, no place file and no key after a join, and keeps the work folder", async () => {
    const home = tmp("leave-after-join");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: codeFor(host, "A") }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, "etc-systemd-system");
    const work = join(home, "wsp-work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a-thread-wrote-this"), "mine");
    // The sweep is given the manager the join wrote its unit with, so it looks under this test's home and not the machine's.
    const manager = unitsUnder(home);
    const { removed } = await sweepPlace({ home, manager, run: runner.run, uid: 0 });
    expect(readdirSync(unitDir)).toEqual([]);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(readFileSync(join(work, "a-thread-wrote-this"), "utf8")).toBe("mine");
    expect(removed.some(line => line.includes("wsp-place-"))).toBe(true);
  });
});

describe("a join typed on a Mac", () => {
  it("refuses in the Mac sentence before it writes or dials anything, though a Mac has a manager", async () => {
    const host = await fakeHost();
    const home = tmp("join-mac");
    const runner = fakeRunner();
    await expect(
      joinPlace(captured(), { home, addresses: [host.url], code: "A", hostKey: keyFingerprint(host.publicKey), platform: "darwin", uid: 501, run: runner.run, dial: url => new WebSocket(wsUrlOf(url)) }),
    ).rejects.toThrow(noPlaceSystemLine("Darwin", "this computer"));
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(host.frames.filter(f => f["op"] === "place.join")).toEqual([]);
    expect(runner.ran).toEqual([]);
  });
});

describe("which manager holds the agent's unit", () => {
  it("takes the manager the platform has, and refuses a computer that has none before it writes or dials anything", async () => {
    const host = await fakeHost();
    const none = tmp("manager-none");
    await expect(joinPlace(captured(), { home: none, addresses: [host.url], code: "A", hostKey: keyFingerprint(host.publicKey), platform: "win32", dial: url => new WebSocket(wsUrlOf(url)) })).rejects.toThrow("writes no service on win32");
    // Nothing would keep the daemon up there, so nothing of a join lands: no place file, no key, no frame to the host.
    expect(existsSync(placeFilePath(none))).toBe(false);
    expect(host.frames.filter(f => f["op"] === "place.join")).toEqual([]);
    const home = tmp("manager-own");
    const own = captured();
    const runner = fakeRunner();
    await joinPlace(own, { home, addresses: [host.url], code: "B", hostKey: keyFingerprint(host.publicKey), platform: "linux", uid: 0, manager: unitsUnder(home), run: runner.run, dial: url => new WebSocket(wsUrlOf(url)) });
    // Linux's own module, with only the folder its unit lands in moved off this machine's real one: a platform that
    // has a manager is asked to take the unit, which the branch above never does.
    expect(runner.ran.length).toBeGreaterThan(0);
    expect(own.errors.join("\n")).not.toContain("writes no service");
  });
});
