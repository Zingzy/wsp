// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { ALREADY_JOINED_LINE, PLACE_ADD_WORDS, placeDaemonPaths, placeLinkTranscript, wsUrlOf, type PlaceView } from "@wsp/protocol";
import { placeLines } from "../src/verbs.js";
import {
  ADD_FLAGS_REFUSAL,
  joinUrls,
  NOTHING_TO_LEAVE_LINE,
  NOT_A_PLACE_LINE,
  addCommand,
  addFlags,
  addLines,
  addRefusal,
  hostPlaceKey,
  hostPlaceKeyPath,
  joinCommand,
  addableProviders,
  leaveCommand,
  placeNameHere,
  removeLines,
  twoPlacesLine,
} from "../src/places.js";
import { placeFilePath, placeKeyPath, placeLogPath, placeReport, readPlaceFile, stopPlaceService, sweepPlace, writePlaceFile } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS, type RunResult, type ServiceRunner } from "../src/service.js";
import { addedProviders } from "../src/providers.js";

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
        ws.send(JSON.stringify({ id: frame["id"], ok: true, placeId, hostPublicKey: key.publicKey, nonce, signature, ...(opts.hostUrls !== undefined ? { hostUrls: opts.hostUrls } : {}) }));
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

const joinDepsFor = (home: string, runner: ServiceRunner): Parameters<typeof joinCommand>[3] => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: runner,
  platform: "linux",
  home,
  argv: () => ["/usr/bin/node", "/opt/wsp/bin.js", "join", "--serve"],
  now: () => 0,
});

describe("what wsp add prints with no argument", () => {
  it("names the line to type on that computer at every address this host answers on, and the other two roads", () => {
    const lines = addLines("7QK3M2VD", 600_000, 0, joinUrls("192.168.1.20", 4400, "p_ab12cd34.singhi.me")).join("\n");
    expect(lines).toContain("wsp join http://192.168.1.20:4400 --code 7QK3M2VD");
    expect(lines).toContain("wsp join https://p_ab12cd34.singhi.me --code 7QK3M2VD");
    expect(lines).toContain("spent by the first join");
    expect(lines).toContain("wsp add user@host");
    for (const id of addableProviders()) expect(lines).toContain(`wsp add ${id}`);
  });

  it("leaves the relay line out when the host is on no relay", () => {
    expect(addLines("X", 1, 0, joinUrls("10.0.0.2", 4400, undefined)).join("\n")).not.toContain("relay");
  });

  it("takes every provider the table says how to add, and nothing it names no way of adding", () => {
    // Read off the table, never off an id: docker is added by its words and the row that holds no machine is no
    // place to add at all.
    expect(addableProviders()).toEqual(["docker", "box", "solari"]);
    expect(addedProviders().map(m => m.added)).toEqual(["words", "key", "key"]);
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
    // The key itself is never written here: which variable holds a given provider's key is the key seam's to say.
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("API_KEY");
  });

  it("puts the key to a provider that is opened by one, and writes nothing when it is refused", async () => {
    const home = tmp("add-provider-key");
    const refusing = { ...systemPlaceDeps, checkKey: async () => ({ state: "refused", said: "box said 401 invalid token" }) as const };
    const io = captured();
    expect(await addCommand(io, opts(home, { BOX_API_KEY: "sk-ant-x" }), ["box"], {}, refusing)).toBe(1);
    expect(io.errors.join("\n")).toContain("401");
    expect(existsSync(join(home, ".env"))).toBe(false);
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
    { id: "here", kind: "computer", name: "zingzys-mac", default: false, shape: { cpu: 8, memMb: 16384 }, docker: true, present: true },
    { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 831 * 1024 ** 3, docker: true, present: true, lastSeenAt: "2026-09-12T00:00:00.000Z" },
    { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.018 },
  ];

  it("carries the cores, the memory, the free disk, the docker and the presence, with the default marked once", () => {
    const printed = placeLines(rows);
    expect(printed[0]).toContain("PLACE");
    expect(printed[0]).toContain("DISK FREE");
    expect(printed[1]).toContain("zingzys-mac");
    expect(printed[2]).toContain("box");
    expect(printed[2]).toContain("default");
    expect(printed[3]).toContain("$0.018/h");
    expect(printed.filter(l => l.includes("default"))).toHaveLength(1);
  });

  it("says how to get one when the host holds none", () => {
    expect(placeLines([]).join("")).toContain("wsp add prints the join line");
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
    // The service runs the join that serves, under the place's own name rather than the host's.
    expect(runner.ran.some(argv => argv.includes("enable") && argv.some(w => w.startsWith("wsp-place-")))).toBe(true);
    const unit = join(home, ".config", "systemd", "user");
    const written = readFileSync(join(unit, readdirSync(unit)[0]!), "utf8");
    expect(written).toContain("'join' '--serve'");
    // The home is stated in the unit: the agent keeps its files under the home its place file sits in, and a
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

  it("refuses a second join on a computer that already belongs to a wsp", async () => {
    const home = tmp("join-again");
    const host = await fakeHost();
    const runner = fakeRunner();
    expect(await joinCommand(captured(), [host.url], { code: "A" }, joinDepsFor(home, runner.run))).toBe(0);
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: "B" }, joinDepsFor(home, runner.run))).toBe(1);
    expect(io.errors).toEqual([ALREADY_JOINED_LINE]);
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

  it("refuses both roads to a code at once, and a serve on a computer that is no place", async () => {
    const home = tmp("join-usage");
    await expect(joinCommand(captured(), ["http://x"], { code: "A", codeFile: "/tmp/c" }, joinDepsFor(home, fakeRunner().run))).rejects.toThrow(/--code or --code-file/);
    const io = captured();
    expect(await joinCommand(io, [], { serve: true }, joinDepsFor(home, fakeRunner().run))).toBe(1);
    expect(io.errors).toEqual([NOT_A_PLACE_LINE]);
  });
});

describe("taking wsp off the computer it is typed on", () => {
  it("unloads the unit, takes every path wsp put there and keeps the work folder, and says so", async () => {
    const home = tmp("leave-home");
    const at = placeDaemonPaths(home);
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "old-macbook", hostUrls: ["http://192.168.1.20:4400"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
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
    writePlaceFile(placeFilePath(home), { placeId: "p_1", name: "box", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: placeKeyPath(home), joinedAt: new Date(0).toISOString() });
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
  it("writes every address its host answers on, the one it reached first", async () => {
    const home = tmp("join-urls");
    const host = await fakeHost({ hostUrls: ["http://10.0.0.2:4400", "https://p_x.example.com"] });
    const io = captured();
    expect(await joinCommand(io, [host.url], { code: "7QK3M2VD" }, joinDepsFor(home, fakeRunner().run))).toBe(0);
    // The one it typed first, then the rest the host named: that is the order the link dials them in.
    expect(readPlaceFile(placeFilePath(home))!.hostUrls).toEqual([host.url, "http://10.0.0.2:4400", "https://p_x.example.com"]);
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
    const place: PlaceView = { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, present: true };
    const client = {
      request: async (op: string, params?: Record<string, unknown>) => {
        expect(op).toBe("places.add");
        expect(params).toMatchObject({ address: "root@10.0.0.9", name: "box", sshPort: 2222 });
        // The line minted the stream it asks under, since the steps reach the terminal before the reply does.
        const addId = String(params!["addId"]);
        expect(addId).toMatch(/^a_/);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "node", state: "done", note: "v22.23.2" });
          // Another client's install on the same host is another stream, and this line prints none of it.
          fn({ type: "place.stage", addId: "a_other", step: "node", state: "done", note: "somebody else" });
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
    expect(said).toContain(`${PLACE_ADD_WORDS.node}: v22.23.2`);
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
