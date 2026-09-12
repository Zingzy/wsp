// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { ALREADY_JOINED_LINE, PLACE_ADD_WORDS, PLACE_CODE_REFUSAL, PLACE_DOOR_UNSERVED, doorPortHeldLine, placeDaemonPaths, placeLinkTranscript, shellQuote, workFolderIn, wsUrlOf, type PlaceDoorView, type PlaceView } from "@wsp/protocol";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { daemonBinaryHere } from "../src/assets.js";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";
import { daemonFlags, PLACE_JOINED_LINE, sshDaemonPlace, WSP_READY_LINE } from "../src/doctor.js";
import { BoxBackend, type KeyCheck, type MachineBackend } from "@wsp/engine";
import { placeLines } from "../src/verbs.js";
import {
  ADD_FLAGS_REFUSAL,
  NOTHING_TO_LEAVE_LINE,
  addCommand,
  addFlags,
  addLines,
  addRefusal,
  deviceLeftLine,
  hostPlaceKey,
  hostPlaceKeyPath,
  joinCommand,
  placeDaemonFlags,
  placeInstaller,
  preparePlaceHome,
  joinPlace,
  addableProviders,
  leaveCommand,
  leavePlace,
  placeNameHere,
  placeStanding,
  writePlaceAwake,
  removeCommand,
  removeLines,
  twoPlacesLine,
} from "../src/places.js";
import { placeFilePath, placeKeyPath, placeLogPath, placeReport, readPlaceFile, stopPlaceService, sweepPlace, writePlaceFile } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS, type RunResult, type ServiceRunner } from "../src/service.js";
import { addedBy, addedProviders } from "../src/providers.js";

const dirs: string[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${name}-`));
  dirs.push(dir);
  return dir;
};

/** Every manager command answered as if it worked, with what was asked kept. */
function fakeRunner(): { run: ServiceRunner; ran: string[][]; holds: boolean } {
  const state = { run: (() => Promise.resolve({ code: 0, output: "" })) as ServiceRunner, ran: [] as string[][], holds: true };
  state.run = (argv): Promise<RunResult> => {
    state.ran.push([...argv]);
    // `holds` is the one answer a stop turns on: a manager that says it has the unit is asked to unload it.
    if (argv.includes("print") || argv.includes("is-enabled")) return Promise.resolve({ code: state.holds ? 0 : 113, output: state.holds ? "" : "could not find service" });
    return Promise.resolve({ code: 0, output: "" });
  };
  return state;
}

interface FakeHost {
  url: string;
  publicKey: string;
  /** The join frames it saw, so a test can read the report and the key a computer sent. */
  frames: Record<string, unknown>[];
}

async function fakeHost(opts: { wrongKey?: boolean; refuse?: string; hostUrls?: string[] } = {}): Promise<FakeHost> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const other = generateKeyPairSync("ed25519");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", ws => {
    ws.on("error", () => {});
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      if (frame["op"] === "place.join") {
        if (opts.refuse !== undefined) {
          ws.send(JSON.stringify({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth" }));
          ws.close(4401, "unauthorized");
          return;
        }
        const placeId = "p_ab12cd34ab12cd34";
        const nonce = Buffer.alloc(32, 5).toString("base64");
        const bytes = placeLinkTranscript("host", placeId, String(frame["nonce"]), nonce);
        // A host whose signature is made by a key other than the one it sent is the one thing a join must refuse.
        const signature = sign(null, bytes, opts.wrongKey === true ? other.privateKey : createPrivateKey(key.pem)).toString("base64");
        ws.send(
          JSON.stringify({
            id: frame["id"],
            ok: true,
            placeId,
            hostPublicKey: key.publicKey,
            nonce,
            signature,
            hostName: "zingzy-mbp",
            ...(frame["client"] === undefined ? {} : { device: { deviceId: "d_1", deviceToken: "dev-token" } }),
          }),
        );
        return;
      }
      if (frame["op"] === "place.prove") ws.send(JSON.stringify({ id: frame["id"], ok: true }));
    });
  });
  const port = await new Promise<number>((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });
  return { url: `http://127.0.0.1:${port}`, publicKey: key.publicKey, frames };
}

/** A port this computer held a moment ago and holds no longer, so a dial at it is refused rather than left hanging. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port));
  });
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

const joinDepsFor = (home: string, runner: ServiceRunner): Parameters<typeof joinCommand>[3] => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: runner,
  platform: "linux",
  home,
  now: () => 0,
});

describe("what wsp add prints with no argument", () => {
  it("names the line to type on that computer at every address this host answers on, and the other two roads", () => {
    const lines = addLines("7QK3M2VD", 600_000, 0, ["http://192.168.1.20:4400"], "p_ab12cd34.singhi.me").join("\n");
    expect(lines).toContain("wsp join http://192.168.1.20:4400 --code 7QK3M2VD");
    expect(lines).toContain("wsp join https://p_ab12cd34.singhi.me --code 7QK3M2VD");
    expect(lines).toContain("spent by the first join");
    expect(lines).toContain("wsp add user@host");
    for (const id of addableProviders()) expect(lines).toContain(`wsp add ${id}`);
  });

  it("leaves the relay line out when the host is on no relay", () => {
    expect(addLines("X", 1, 0, ["http://10.0.0.2:4400"], undefined).join("\n")).not.toContain("relay");
  });

  it("takes every provider the table says how to add, and nothing it names no way of adding", () => {
    // Read off the table, never off an id: docker is added by its words and the row that holds no machine is no
    // place to add at all.
    expect(addableProviders()).toEqual(["docker", "box", "solari"]);
    // How a row is added is read off the row's own facts: a row that declares the variable it reads a key from is
    // opened by that key, and is not asked to say so twice.
    expect(addedProviders().map(m => addedBy(m))).toEqual(["words", "key", "key"]);
    expect(addedProviders().map(m => [m.id, m.keyEnv !== undefined])).toEqual([["docker", false], ["box", true], ["solari", true]]);
    expect(addableProviders()).not.toContain("none");
    expect(addRefusal("nonsense")).toContain("docker, box, solari");
    expect(addRefusal("nonsense")).toContain("user@host");
    expect(addRefusal("nonsense")).toContain("wsp add with no argument");
  });
});

/** Every dependency the two host-side words take, with the provider check answered here: a unit test calls no
 * provider. The dial is the one road that reaches a host, and the tests that take it hand their own. */
const systemPlaceDeps: Parameters<typeof addCommand>[4] = {
  dial: () => Promise.reject(new Error("no host is dialled on this road")),
  now: () => 0,
  run: fakeRunner().run,
  platform: "linux",
  checkKey: async () => ({ state: "taken" }),
};

const opts = (home: string, env: Record<string, string | undefined> = {}): Parameters<typeof addCommand>[1] => ({
  statePath: join(home, "state.json"),
  home,
  env: { HOME: home, WSP_HOME: home },
  providerEnv: env,
});

describe("a provider as a place", () => {
  it("sets this computer up for the provider and prints its place line, with the key read where the person keeps it", async () => {
    const home = tmp("add-provider");
    const io = captured();
    // docker is added by its words alone, so nothing is put to a provider and nothing of a key is read.
    expect(await addCommand(io, opts(home, {}), ["docker"], {}, systemPlaceDeps)).toBe(0);
    expect(io.lines.join("\n")).toContain("place docker");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("WSP_PROVIDER=docker");
    // The key itself is never written here: it stays where the person keeps it, under its own row's variable.
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("API_KEY");
  });

  it("puts the key to a provider that is opened by one, and writes nothing when it is refused", async () => {
    const home = tmp("add-provider-key");
    const put: MachineBackend[] = [];
    const refusing = { ...systemPlaceDeps, checkKey: async (b: MachineBackend): Promise<KeyCheck> => (put.push(b), { state: "refused", said: "box said 401 invalid token" }) };
    const io = captured();
    expect(await addCommand(io, opts(home, { BOX_API_KEY: "sk-ant-x" }), ["box"], {}, refusing)).toBe(1);
    expect(io.errors.join("\n")).toContain("401");
    expect(existsSync(join(home, ".env"))).toBe(false);
    // The key is put to the provider being added, built out of the environment that carries every row's key under
    // the variable that row declares.
    expect(put).toHaveLength(1);
    expect(put[0]).toBeInstanceOf(BoxBackend);
    // A key the provider took sets this computer up for it and nothing of the key is written or printed.
    const taking = { ...systemPlaceDeps, checkKey: async () => ({ state: "taken" }) as const };
    const good = captured();
    expect(await addCommand(good, opts(home, { BOX_API_KEY: "sk-ant-x" }), ["box"], {}, taking)).toBe(0);
    expect(good.lines.join("\n")).toContain("place box");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("WSP_PROVIDER=box\n");
    expect(good.lines.join("\n") + good.errors.join("\n")).not.toContain("sk-ant-x");
  });

  it("refuses the ssh road's own flags when no computer was named beside them", async () => {
    const home = tmp("add-name");
    const io = captured();
    expect(await addCommand(io, opts(home, {}), [], { name: "box" }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
    expect(io.errors[0]).toContain("wsp join");
  });
});

describe("the table wsp places prints", () => {
  const rows: PlaceView[] = [
    { id: "here", kind: "computer", name: "zingzys-mac", default: false, shape: { cpu: 8, memMb: 16384 }, docker: true, present: true, takesForks: false },
    { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 831 * 1024 ** 3, docker: true, present: true, lastSeenAt: "2026-09-12T00:00:00.000Z", takesForks: true },
    { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.018, takesForks: true },
  ];

  it("carries the cores, the memory, the free disk, the docker and the presence, with the default marked once", () => {
    const printed = placeLines(rows);
    expect(printed[0]).toContain("PLACE");
    expect(printed[0]).toContain("DISK FREE");
    expect(printed[1]).toContain("zingzys-mac");
    expect(printed[2]).toContain("box");
    expect(printed[2]).toContain("default");
    expect(printed[3]).toContain("$0.018/hr");
    expect(printed.filter(l => l.includes("default"))).toHaveLength(1);
  });

  it("says how to get one when the host holds none", () => {
    expect(placeLines([]).join("")).toContain("wsp add prints the join line");
  });

  it("says how many forks a place holds of how many it takes, and nothing there for one that forks nowhere", () => {
    const printed = placeLines([
      { ...rows[1]!, forks: { running: 1, room: 2 } },
      { ...rows[0]!, id: "p_2", name: "laptop", docker: false },
    ]);
    expect(printed[0]).toContain("FORKS");
    expect(printed[1]).toContain("1 of 3");
    expect(printed[2]).not.toContain("of");
  });
});

describe("what a remove prints", () => {
  it("names what came off the computer, what the workspaces said, and the note for a place that was off", () => {
    const lines = removeLines("box", { swept: ["the systemd user unit", "/home/maya/.wsp/place.json"], dropped: ["workspace box (ws_1) and its threads are gone from this host"], note: "box is off this host" }).join("\n");
    expect(lines).toContain("removed from box:");
    expect(lines).toContain("  the systemd user unit");
    expect(lines).toContain("workspace box (ws_1)");
    expect(lines).toContain("box is off this host");
    expect(lines).toContain("box is no longer a place in this wsp.");
  });

  it("names the ids when two places share a name, since ids tell them apart and names are the person's", () => {
    expect(twoPlacesLine("box", ["p_1", "p_2"])).toContain("p_1, p_2");
  });
});

describe("the host's own key", () => {
  it("is made once beside the state file, at the person's own mode, and read back after", () => {
    const dir = tmp("host-key");
    const statePath = join(dir, "state.json");
    const first = hostPlaceKey(statePath);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hostPlaceKey(statePath)).toEqual(first);
    expect(statSync(hostPlaceKeyPath(statePath)).mode & 0o777).toBe(0o600);
  });

  it("writes a fresh pair over a file that is not one, since a place that pinned the old key says so on its next dial", () => {
    const dir = tmp("host-key-bad");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostPlaceKeyPath(statePath), "not a key");
    expect(hostPlaceKey(statePath).privateKeyPem).toContain("PRIVATE KEY");
  });
});

describe("what this computer says about itself", () => {
  it("names itself by its own name lowercased, reads its own shape, and says which line runs wsp here", () => {
    const home = tmp("report-home");
    const report = placeReport({ name: placeNameHere(), home, env: { PATH: "/usr/bin", HOME: home } });
    expect(report.name).toBe(report.name.toLowerCase());
    expect(report.shape.cpu).toBeGreaterThan(0);
    expect(report.login["HOME"]).toBe(home);
    expect(report.wsp.length).toBeGreaterThan(0);
    expect(["darwin", "linux"]).toContain(report.platform);
  });

  it("reads the PATH a login shell here gives, not the one the shell that typed the join happened to hold", () => {
    const home = tmp("report-path");
    // A login file of the person's own, which a service's bare environment would never have read: without HOME a
    // login shell reads none of their files and answers the service's own PATH.
    writeFileSync(join(home, ".profile"), `export PATH=${home}/bin:$PATH\n`);
    // A service starts with almost no environment: what the agent reports has to be the person's own login PATH,
    // or every tool they installed under their home is unfindable to a turn.
    const report = placeReport({ name: "x", home, env: { PATH: "/only/this", HOME: home } });
    expect(report.login["PATH"]).not.toBe("/only/this");
    expect(report.login["PATH"]).toContain(`${home}/bin`);
  });

  it("leaves a store folder that is not a plain path out of the login, since what is there lands in a command", () => {
    const home = tmp("report-store");
    const report = placeReport({ name: "x", home, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/tmp/a; rm -rf /" } });
    expect(report.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });
});

describe("a computer joining a wsp", () => {
  it("writes the place file and the key at the person's own mode, installs the agent as a service, and says so", async () => {
    const home = tmp("join-home");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: "7QK3M2VD", name: "old-macbook" }, joinDepsFor(home, runner.run))).toBe(0);
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ placeId: "p_ab12cd34ab12cd34", name: "old-macbook", hostUrls: [host.url], hostPublicKey: host.publicKey });
    expect(statSync(placeFilePath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(placeKeyPath(home), "utf8")).toContain("PRIVATE KEY");
    expect(statSync(placeKeyPath(home)).mode & 0o777).toBe(0o600);
    // The service runs the daemon itself, under the place's own name rather than the host's.
    expect(runner.ran.some(argv => argv.includes("enable") && argv.some(w => w.startsWith("wsp-place-")))).toBe(true);
    const unit = join(home, ".config", "systemd", "user");
    const written = readFileSync(join(unit, readdirSync(unit)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    expect(written).toContain(`'--place-file' ${shellQuote(placeFilePath(home))}`);
    // The home is stated in the unit: the daemon keeps its files under the home its place file sits in, and a
    // manager handing it the login's own default would put them somewhere else.
    expect(written).toContain(`HOME=${home}`);
    expect(io.lines.join("\n")).toContain("old-macbook joined the wsp at");
    expect(io.lines.join("\n")).toContain("wsp leave takes this computer back out.");
    // The report it sent names this computer and the address it dialled.
    const sent = host.frames.find(f => f["op"] === "place.join")!;
    expect((sent["report"] as { name: string; dialed: string }).name).toBe("old-macbook");
    expect((sent["report"] as { dialed: string }).dialed).toBe(host.url);
  });

  it("writes nothing when the host could not prove the key it sent", async () => {
    const home = tmp("join-bad-key");
    const host = await fakeHost({ wrongKey: true });
    const io = captured();
    await expect(joinCommand(io, [host.url], { code: "X" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/did not prove the key/);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
  });

  it("carries the host's own refusal back and writes nothing when the code was spent", async () => {
    const home = tmp("join-spent");
    const host = await fakeHost({ refuse: "that pairing code is not one this host is waiting for" });
    await expect(joinCommand(captured(), [host.url], { code: "X" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/not one this host is waiting for/);
    expect(existsSync(placeFilePath(home))).toBe(false);
  });

  it("says which of the two things a person typed a refusal is about, where it is about one of them", async () => {
    // The code: the one refusal a host has for a code it is not holding, spent, expired or never minted.
    const spent = await fakeHost({ refuse: PLACE_CODE_REFUSAL });
    await expect(joinCommand(captured(), [spent.url], { code: "X" }, joinDepsFor(tmp("join-code"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "code" });
    // The address: nothing is listening there. The port was this computer's a moment ago and is free again.
    const closed = await freePort();
    await expect(joinCommand(captured(), [`http://127.0.0.1:${closed}`], { code: "X" }, joinDepsFor(tmp("join-gone"), fakeRunner().run))).rejects.toMatchObject({ name: "JoinRefused", about: "address" });
    // A refusal about neither field carries neither: a host that would not prove its key, and any other word of its own.
    const wrong = await fakeHost({ wrongKey: true });
    await expect(joinCommand(captured(), [wrong.url], { code: "X" }, joinDepsFor(tmp("join-key"), fakeRunner().run))).rejects.toMatchObject({ name: "Error" });
    const other = await fakeHost({ refuse: "this host takes no places while it is building your image" });
    await expect(joinCommand(captured(), [other.url], { code: "X" }, joinDepsFor(tmp("join-other"), fakeRunner().run))).rejects.toMatchObject({ name: "Error" });
  });

  it("refuses a second join on a computer that already belongs to a wsp", async () => {
    const home = tmp("join-again");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: "A" }, joinDepsFor(home, runner.run))).toBe(0);
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: "B" }, joinDepsFor(home, runner.run))).toBe(1);
    expect(io.errors).toEqual([ALREADY_JOINED_LINE]);
  });

  it("takes the code as the other screen shows it, since a person copies the code they can read", async () => {
    const home = tmp("join-dashed");
    const host = await fakeHost();
    expect(await joinCommand(captured(), [host.url], { code: "qw4k-7pzx" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(String((host.frames.find(f => f["op"] === "place.join")!)["code"])).toBe("QW4K7PZX");
  });

  it("reads the code off a file and deletes it before dialing, so a code never sits on a disk", async () => {
    const home = tmp("join-code-file");
    const host = await fakeHost();
    const codeFile = join(home, "join-code");
    writeFileSync(codeFile, "7QK3M2VD\n");
    expect(await joinCommand(captured(), [host.url], { codeFile }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(existsSync(codeFile)).toBe(false);
    expect(String((host.frames.find(f => f["op"] === "place.join")!)["code"])).toBe("7QK3M2VD");
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
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "old-macbook", hostName: "zingzy-mbp", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString(), awake: false });
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
    // The manager was asked to let the agent go, which is what a person running this wants to see.
    expect(runner.ran.some(argv => argv.includes("disable"))).toBe(true);
  });

  it("says this computer is no place when there is nothing to leave", async () => {
    const io = captured();
    expect(await leaveCommand(io, [], { home: tmp("leave-none"), run: fakeRunner().run, platform: "linux" })).toBe(1);
    expect(io.errors).toEqual([NOTHING_TO_LEAVE_LINE]);
  });

  it("makes the manager forget the agent and takes its file, and stops nothing until the caller says so", async () => {
    const home = tmp("leave-order");
    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const runner = fakeRunner();
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostName: "zingzy-mbp", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString(), awake: false });
    const unit = SERVICE_MANAGERS.systemd.unit({ role: "place", statePath: placeFilePath(home), home, uid: 1000 });
    writeFileSync(unit.path, "[Unit]\n");
    const swept = await sweepPlace({ home, manager: SERVICE_MANAGERS.systemd, run: runner.run, uid: 1000 });
    // The file is gone and the link systemd keeps beside it was taken with it, so no login brings the agent back;
    // nothing has been stopped yet, which is what lets the sweep answer the host before it dies.
    expect(existsSync(unit.path)).toBe(false);
    expect(swept.removed[0]).toContain(unit.name);
    expect(runner.ran).toEqual([["systemctl", "--user", "disable", unit.name]]);
    await stopPlaceService({ home, manager: SERVICE_MANAGERS.systemd, run: runner.run, uid: 1000 });
    expect(runner.ran.at(-2)).toEqual(["systemctl", "--user", "disable", "--now", unit.name]);
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
    expect(await joinCommand(io, args, { code: "7QK3M2VD" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    // The one that answered, then the rest: that is the order the link dials them in from now on.
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([host.url, "http://127.0.0.1:1", "http://10.0.0.2:4400"]);
  });

  it("tries the next address when the first answers nothing, and says which one went nowhere", async () => {
    const home = tmp("join-next");
    const host = await fakeHost();
    const io = captured();
    // Port 1 on loopback answers nothing at all, which is the address an installer picked that this computer cannot route to.
    expect(await joinCommand(io, ["http://127.0.0.1:1", host.url], { code: "7QK3M2VD" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(io.errors.join("\n")).toContain("http://127.0.0.1:1");
    expect(readPlaceFile(placeFilePath(home))!.hostUrls[0]).toBe(host.url);
  });

  it("stops at a host's own refusal rather than asking its other addresses the same question", async () => {
    const home = tmp("join-refused");
    const host = await fakeHost({ refuse: "that join code is not one this host is waiting for" });
    const io = captured();
    await expect(joinCommand(io, [host.url, "http://127.0.0.1:1"], { code: "SPENT" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow("not one this host is waiting for");
    expect(io.errors.join("\n")).not.toContain("http://127.0.0.1:1");
    expect(existsSync(placeFilePath(home))).toBe(false);
  });
});

describe("wsp add on a computer reached over ssh", () => {
  it("asks the host to do it, prints each step as it lands and says what joined", async () => {
    const io = captured();
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const place: PlaceView = { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, present: true, takesForks: true };
    const client = {
      request: async (op: string, params?: Record<string, unknown>) => {
        expect(op).toBe("places.add");
        expect(params).toMatchObject({ address: "root@10.0.0.9", name: "box", sshPort: 2222 });
        // The line minted the stream it asks under, since the steps reach the terminal before the reply does.
        const addId = String(params!["addId"]);
        expect(addId).toMatch(/^a_/);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "connect", state: "done", note: "Linux 6.8.0" });
          // Another client's install on the same host is another stream, and this line prints none of it.
          fn({ type: "place.stage", addId: "a_other", step: "connect", state: "done", note: "somebody else" });
        }
        return { addId, place, hostKey: "ssh-ed25519 SHA256:abc" } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    expect(await addCommand(io, opts(tmp("add-ssh")), ["root@10.0.0.9"], addFlags("box", "2222", undefined), deps)).toBe(0);
    const said = io.lines.join("\n");
    expect(said).toContain(`${PLACE_ADD_WORDS.connect}: Linux 6.8.0`);
    expect(said).toContain("box joined this wsp");
    expect(said).toContain("ssh-ed25519 SHA256:abc");
    expect(said).toContain("wsp remove box");
    expect(said).not.toContain("somebody else");
  });

  it("reads the port and the key by the rule every ssh road on this command line reads them by", () => {
    expect(addFlags("box", "2222", "/tmp/id_ed25519")).toEqual({ name: "box", sshPort: 2222, keyPath: "/tmp/id_ed25519" });
    expect(addFlags(undefined, undefined, undefined)).toEqual({});
    expect(() => addFlags(undefined, "no", undefined)).toThrow("--ssh-port");
  });

  it("refuses the ssh road's flags when no computer was named beside them, naming the word that does name one", async () => {
    const io = captured();
    expect(await addCommand(io, opts(tmp("add-flags")), [], { sshPort: 2222 }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
  });
});

describe("the install over ssh marks its steps off the lines the deploy prints", () => {
  /** A daemon asset folder with a stand-in binary per guest target, and a wsp command as npm lays it out. */
  function assets(root: string): { daemonDir: string; cliDir: string } {
    const daemonDir = join(root, "daemon");
    for (const target of GUEST_DAEMON_TARGETS) {
      mkdirSync(join(daemonDir, target.triple), { recursive: true });
      writeFileSync(daemonBinaryIn(daemonDir, target.triple), `#!/bin/sh\necho ${target.triple}\n`, { mode: 0o755 });
    }
    const cliDir = join(root, "cli");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    writeFileSync(join(cliDir, "dist", "bin.js"), "");
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "@zingzy/wsp", version: "0.0.0" }));
    return { daemonDir, cliDir };
  }

  it("reads WSP_READY and PLACE_JOINED off the script's own echo lines, and never waits on a node version", async () => {
    const root = tmp("install-steps");
    const printed: string[] = [];
    const ran: string[] = [];
    // A machine that prints what the script it is given would print: each `echo <word>` line, in order, as the
    // deploy's own output reaches the host line by line; the join on it wrote the place file, so the deploy's last
    // word is DAEMON_UP.
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Linux 6.8.0" }),
      run: async (script: string, opts?: { onLine?: (line: string) => void }) => {
        ran.push(script);
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        const lines = script.split("\n").flatMap(line => (/^echo (\S+)$/.exec(line)?.[1] === undefined ? [] : [line.slice("echo ".length)]));
        for (const line of lines) {
          printed.push(line);
          opts?.onLine?.(line);
        }
        return { exitCode: 0, stdout: `${[...lines, "DAEMON_UP"].join("\n")}\n`, stderr: "" };
      },
    };
    const backend = { adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, hostKey: "ssh-ed25519 SHA256:abc" }) };
    const stages: string[] = [];
    const installed = await placeInstaller({ backend: backend as never, ...assets(root) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`),
    );
    expect(installed).toEqual({ name: "box", hostKey: "ssh-ed25519 SHA256:abc" });
    // The deploy printed the two words the parser reads, and nothing of a node version.
    expect(printed).toEqual([WSP_READY_LINE, PLACE_JOINED_LINE]);
    expect(ran.join("\n")).not.toContain("NODE_VERSION");
    // Every step reaches done in order, off those two lines: the bundle landing is running from the connect until
    // WSP_READY, the join from then until PLACE_JOINED.
    expect(stages).toEqual(["connect running", "connect done (Linux 6.8.0)", "wsp running", "wsp done", "service running", "service done"]);
    expect(stages.some(line => line.startsWith("node"))).toBe(false);
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
    writeFileSync(join(home, ".profile"), `# theirs\n. ${at.profileFile}\nexport EDITOR=vi\n`);
    const swept = await sweepPlace({ home, manager: undefined, run: fakeRunner().run });
    expect(existsSync(`${at.binDir}/xdg-open`)).toBe(false);
    expect(swept.removed).toContain(`${at.binDir}/xdg-open`);
    // Their file keeps everything of theirs and loses the one line wsp put in it.
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# theirs\nexport EDITOR=vi\n");
    expect(swept.removed.some(line => line.includes(".profile"))).toBe(true);
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
  });

  it("opens the door by asking for it and prints its address, so a host on loopback alone is still one a computer can join", async () => {
    const home = tmp("add-door");
    const io = captured();
    const fake = fakeClient({ port: 4420, addresses: ["http://192.168.1.20:4420"] });
    const opts = { statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } };
    expect(await addCommand(io, opts, [], {}, addDeps(fake.client))).toBe(0);
    expect(fake.asked).toEqual(["pair.issue", "places.door"]);
    expect(io.lines.join("\n")).toContain("wsp join http://192.168.1.20:4420 --code 7QK3M2VD");
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
  it("names the shim it was handed as this computer's wsp, writes the wsp's name and a place that is not held awake, and buys the window its token", async () => {
    const home = tmp("join-shell");
    const host = await fakeHost();
    const runner = fakeRunner();
    const io = captured();
    const joined = await joinPlace(io, {
      home,
      addresses: [host.url],
      code: "7QK3M2VD",
      name: "old-macbook",
      client: true,
      wsp: { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "", shim: `${home}/.wsp/bin/wsp` },
      manager: SERVICE_MANAGERS.systemd,
      run: runner.run,
      dial: url => new WebSocket(wsUrlOf(url)),
    });
    expect(joined).toMatchObject({ hostName: "zingzy-mbp", hostUrls: [host.url], device: { deviceId: "d_1", deviceToken: "dev-token" } });
    expect(joined.report.name).toBe("old-macbook");
    const file = readPlaceFile(placeFilePath(home))!;
    expect(file).toMatchObject({ hostName: "zingzy-mbp", awake: false, name: "old-macbook" });
    const unitDir = join(home, ".config", "systemd", "user");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    // The unit runs the daemon; the shim is what the daemon reports as the wsp a turn's agent runs here.
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain(`'--wsp-argv' '${home}/.wsp/bin/wsp'`);
    // The client rode the join frame, which is what the one code bought a device for, and it wears the place's own
    // name rather than this computer's: wsp remove finds the token a computer still holds by the place's name, so a
    // second word here would be a device nothing could ever name. The two are different words in this run.
    expect(placeNameHere()).not.toBe("old-macbook");
    expect(host.frames.find(f => f["op"] === "place.join")!["client"]).toEqual({ name: "old-macbook" });
  });

  it("is the same road the command line takes, which hands the daemon binary and its flags", async () => {
    const home = tmp("join-cli-argv");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: "A" }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, ".config", "systemd", "user");
    const written = readFileSync(join(unitDir, readdirSync(unitDir)[0]!), "utf8");
    expect(written).toContain(`ExecStart=${shellQuote(daemonBinaryHere())} '--host' '127.0.0.1'`);
    expect(written).toContain("'--kind' 'place'");
    // Nothing on that road asks for a window, so nothing on it buys a device.
    expect(host.frames.find(f => f["op"] === "place.join")!["client"]).toBeUndefined();
  });

  it("takes a bare host and port as the join screen shows it, and refuses a word that is no address", async () => {
    const home = tmp("join-bare");
    const host = await fakeHost();
    const bare = new URL(host.url).host;
    expect(await joinCommand(captured(), [bare], { code: "A" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([`http://${bare}`]);
    await expect(joinCommand(captured(), ["box"], { code: "A" }, joinDepsFor(tmp("join-word"), fakeRunner().run))).rejects.toThrow(/not an address/);
  });
});

describe("the daemon's line on a joined computer", () => {
  it("is the flags every daemon under a login takes, told the place kind, then the place file, the home, the wsp line and the agents", () => {
    const home = "/home/maya";
    const file = placeDaemonPaths(home).placeFile;
    const flags = placeDaemonFlags(home, file, { execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", "/opt/wsp/bin.js"], version: "9.9.9", PATH: "" });
    const at = placeDaemonPaths(home);
    // Loopback, a port of the machine's own, every file under the login's folder, and the kind that picks the readings.
    expect(flags.slice(0, flags.indexOf("--home"))).toEqual(daemonFlags({ ...sshDaemonPlace({ home, path: "" }), kind: "place" }));
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

describe("holding a joined computer awake", () => {
  it("writes the hold on at the join when the flag asked for it", async () => {
    const home = tmp("join-awake");
    const host = await fakeHost();
    expect(await joinCommand(captured(), [host.url], { code: "A", awake: true }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    expect(readPlaceFile(placeFilePath(home))!.awake).toBe(true);
  });

  it("flips it on the file and keeps every other field, since the agent watches that file and nothing restarts", async () => {
    const home = tmp("awake-flip");
    const host = await fakeHost();
    expect(await joinCommand(captured(), [host.url], { code: "A" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    const before = placeStanding(home)!;
    const after = writePlaceAwake(home, true);
    expect(after).toEqual({ ...before, awake: true });
    expect(placeStanding(home)!.awake).toBe(true);
    expect(writePlaceAwake(home, false).awake).toBe(false);
  });

  it("has nothing to flip on a computer that belongs to no wsp", () => {
    expect(placeStanding(tmp("awake-none"))).toBeUndefined();
    expect(() => writePlaceAwake(tmp("awake-none-2"), true)).toThrow(NOTHING_TO_LEAVE_LINE);
  });
});

describe("the sweep a joined computer runs on itself", () => {
  it("leaves no unit, no place file and no key after a join, and keeps the work folder", async () => {
    const home = tmp("leave-after-join");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: "A" }, joinDepsFor(home, runner.run))).toBe(0);
    const unitDir = join(home, ".config", "systemd", "user");
    const work = join(home, "wsp-work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a-thread-wrote-this"), "mine");
    const removed = await leavePlace(home, runner.run, "linux");
    expect(readdirSync(unitDir)).toEqual([]);
    expect(existsSync(placeFilePath(home))).toBe(false);
    expect(existsSync(placeKeyPath(home))).toBe(false);
    expect(readFileSync(join(work, "a-thread-wrote-this"), "utf8")).toBe("mine");
    expect(removed.some(line => line.includes("wsp-place-"))).toBe(true);
  });
});

describe("which manager holds the agent's unit", () => {
  it("takes the manager the platform has, and refuses a computer that has none before it writes or dials anything", async () => {
    const host = await fakeHost();
    const none = tmp("manager-none");
    await expect(joinPlace(captured(), { home: none, addresses: [host.url], code: "A", platform: "win32", dial: url => new WebSocket(wsUrlOf(url)) })).rejects.toThrow("writes no service on win32");
    // Nothing would keep the daemon up there, so nothing of a join lands: no place file, no key, no frame to the host.
    expect(existsSync(placeFilePath(none))).toBe(false);
    expect(host.frames.filter(f => f["op"] === "place.join")).toEqual([]);
    const home = tmp("manager-own");
    const own = captured();
    const runner = fakeRunner();
    await joinPlace(own, { home, addresses: [host.url], code: "B", platform: "linux", run: runner.run, dial: url => new WebSocket(wsUrlOf(url)) });
    // Whichever manager this computer has: it was asked to take the unit, which the branch above never does.
    expect(runner.ran.length).toBeGreaterThan(0);
    expect(own.errors.join("\n")).not.toContain("writes no service");
  });
});
