// SPDX-License-Identifier: AGPL-3.0-only
// Connecting this computer to a host on another one: a code redeemed over the
// app's own port, the token kept in a file only this user can read, and every
// later verb dialling that host by its alias. The host here is a real one in
// this process, so the code, the token and the revoke are the host's own.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_AUTH_REFUSAL,
  DEVICE_REVOKED_REFUSAL,
  EXIT_CODES,
  PAIR_CODE_REFUSAL,
  PAIR_NO_KEY_REFUSAL,
  PLACE_LINK_NONCE_BYTES,
  SEAL_CLIENT,
  UNAUTHORIZED,
  deviceAdmissionTranscript,
  deviceAuthOldHostLine,
  pairKeyRefusal,
  pairToken,
  placeLinkTranscript,
  type AccountDevice,
  type DeviceView,
} from "@wsp/protocol";
import { freshEphemeral, keyFingerprint, makeSeal, newPlaceKeyPair, openFrame, sealKeys, sharedSecret, signPlaceBytes, type Seal } from "@wsp/keys";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { deviceKeyHere } from "../src/account.js";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { connectCommand, disconnectCommand, hostDefaultCommand, type ConnectDeps } from "../src/connect.js";
import { cli, type CliIO } from "../src/cli.js";
import { runningWsp } from "../src/mcp-install.js";
import { defaultHost, dialWindowMs, hostsDir, readHost, writeHost } from "../src/hosts.js";
import { dialer } from "../src/mcp.js";
import { CLI_VERBS, dialHost, runVerb, type DialOpts, type HostClient } from "../src/verbs.js";
import { startHost, type HostHandle } from "../src/server.js";
import { hostKeyHere, placeWiring } from "../src/places.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { startTcpProxy, type TcpProxy } from "../../runtime/test/tcp-proxy.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[] = [], err: string[] = []): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

let dirs: string[] = [];
let handle: HostHandle | undefined;
let roads: TcpProxy[] = [];
/** Every stand-in host this file started, closed with the rest: a server left listening holds the run open. */
let servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const road of roads) await road.close();
  roads = [];
  await handle?.close();
  handle = undefined;
  for (const server of servers) await new Promise<void>(done => server.close(() => done()));
  servers = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A road between this computer and the host, which can be made to carry nothing the way an edge whose tunnel is
 * not answering does. The host is reached at this road's own address, so the record a connect writes holds it. */
async function roadTo(port: number): Promise<TcpProxy> {
  const road = await startTcpProxy(port);
  roads.push(road);
  return road;
}

/** Waits for the road to hold nothing, which is what a line free to go looks like from outside it. */
async function roadEmpty(road: TcpProxy, withinMs = 1_000): Promise<number> {
  const until = Date.now() + withinMs;
  while (road.live() !== 0 && Date.now() < until) await new Promise(done => setTimeout(done, 20));
  return road.live();
}

/** What the hand back is handed beside the dial; the window is the test's own, since a road's is seconds long. */
const handBackDeps = (dial: ConnectDeps["dial"], windowMs = 300): ConnectDeps => ({
  dial,
  now: Date.now,
  deviceName: () => "a test",
  window: () => windowMs,
});

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

/** The built page the host serves, which it refuses to start without. */
function fakeWebDir(): string {
  const dir = tempDir("connect-web");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')\n");
  writeFileSync(join(dir, "index.html"), `<!doctype html>\n<html><body><div id="root"></div>\n<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>\n</body></html>\n`);
  return dir;
}

/** A runtime with the place wiring every host a person starts has, since the key it proves to a pairing client
 * is the one the place door holds. The state file is a path in this test's own folder; nothing serves it. */
function testRuntime(): { runtime: Runtime; statePath: string } {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  const statePath = join(tempDir("connect-state"), "state.json");
  return { runtime: createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: placeWiring(statePath, {}) }), statePath };
}

/** One request over a raw socket that authed with the host's own token: how a person at the host's terminal mints a
 * code, which is the one road to one. */
async function overHostToken(wsPort: number, token: string, op: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const replies: ((m: Record<string, unknown>) => void)[] = [];
  ws.on("message", raw => replies.shift()!(JSON.parse(String(raw)) as Record<string, unknown>));
  const request = (id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise(done => {
      replies.push(done);
      ws.send(JSON.stringify({ id, ...body }));
    });
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  try {
    const authed = await request(1, { op: "auth", token });
    expect(authed["ok"], String(authed["error"])).toBe(true);
    return await request(2, { op });
  } finally {
    ws.close();
  }
}

/** A host of this process, the folder wsp host connect writes into, and a fresh code from that host. */
async function boxAndHome(): Promise<{ url: string; home: string; hostKey: string; code: () => Promise<string>; codeAlone: () => Promise<string>; devices: () => Promise<string[]> }> {
  const { runtime, statePath } = testRuntime();
  handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, wsPort: 0 });
  const up = handle;
  const issued = async (): Promise<{ code: string; hostKey: string }> => {
    const answer = await overHostToken(up.wsPort, up.authToken, "pair.issue");
    return { code: answer["code"] as string, hostKey: answer["hostKey"] as string };
  };
  return {
    url: `http://127.0.0.1:${up.port}`,
    home: tempDir("connect-home"),
    hostKey: hostKeyHere(statePath),
    // What a person copies off wsp host pair: the code and the fingerprint of the key this host proves.
    code: async () => {
      const { code, hostKey } = await issued();
      return pairToken(code, hostKey);
    },
    codeAlone: async () => (await issued()).code,
    devices: async () => ((await overHostToken(up.wsPort, up.authToken, "devices.list"))["devices"] as { id: string }[]).map(d => d.id),
  };
}

const STATE = "/nowhere/state.json";

describe("wsp host connect", () => {
  it("redeems the code, keeps the token in a file only this user can read and makes that host the default", async () => {
    const box = await boxAndHome();
    const log: string[] = [];
    expect(await connectCommand(io(log), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url])).toBe(0);

    const kept = readHost(box.home, "box")!;
    expect(kept.url).toBe(box.url);
    expect(kept.deviceId).toMatch(/^d_/);
    expect(kept.deviceToken).toMatch(/\S/);
    expect(await box.devices()).toEqual([kept.deviceId]);
    expect(statSync(join(hostsDir(box.home), "box.json")).mode & 0o777).toBe(0o600);
    expect(defaultHost(box.home)).toBe("box");
    expect(log.join("\n")).toContain("box");
    expect(log.join("\n")).toContain(box.url);
    expect(log.join("\n")).not.toContain(kept.deviceToken);
  });

  it("leaves the default where it is when this computer already had one", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "one" }, [box.url]);
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "two" }, [box.url]);
    expect(defaultHost(box.home)).toBe("one");
  });

  it("names the host after its address when no name is given", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code() }, [box.url]);
    expect(readHost(box.home, "127.0.0.1")).toBeDefined();
  });

  it("refuses a code the host is not holding, in the host's own words, and writes nothing", async () => {
    const box = await boxAndHome();
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: pairToken("ZZZZZZZZ", box.hostKey), name: "box" }, [box.url])).rejects.toThrow(PAIR_CODE_REFUSAL);
    expect(readHost(box.home, "box")).toBeUndefined();
    expect(defaultHost(box.home)).toBeUndefined();
  });

  it("refuses a code already spent, which reads the same as one that ran out", async () => {
    const box = await boxAndHome();
    const code = await box.code();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code, name: "first" }, [box.url]);
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code, name: "second" }, [box.url])).rejects.toThrow(PAIR_CODE_REFUSAL);
    expect(readHost(box.home, "second")).toBeUndefined();
  });

  it("refuses a line with no code, no address, or an address that is not one", async () => {
    const home = tempDir("connect-home");
    await expect(connectCommand(io(), { statePath: STATE, home }, {}, ["http://box:4400"])).rejects.toThrow(/--code/);
    await expect(connectCommand(io(), { statePath: STATE, home }, { code: "ABCD1234" }, [])).rejects.toThrow(/usage/);
    await expect(connectCommand(io(), { statePath: STATE, home }, { code: "ABCD1234" }, ["box"])).rejects.toThrow(/http/);
  });

  it("answers every address it cannot dial with the one sentence, and dials none of them", async () => {
    const home = tempDir("connect-home");
    const never = {
      dial: () => Promise.reject(new Error("no address this refuses is dialled")),
      now: Date.now,
      deviceName: () => "a test",
      window: dialWindowMs,
    };
    // ws and wss are addresses a socket is dialled at, not ones a host is served at, and an http:// with no
    // computer after it reached the URL parser and threw a TypeError nobody could act on.
    for (const word of ["http://", "https://", "ws://x", "wss://x:4410", "http:/box", "box", "box:4400"]) {
      await expect(connectCommand(io(), { statePath: STATE, home }, { code: "ABCD1234" }, [word], never)).rejects.toThrow(
        `wsp host connect takes the address the host is served at, and got ${JSON.stringify(word)}. An address starts http:// or https:// and names the computer it runs on.`,
      );
    }
    expect(readHost(home, "x")).toBeUndefined();
  });

  it("refuses a name that could never be a host record before it spends the code", async () => {
    const box = await boxAndHome();
    let dialled = false;
    const watched = {
      dial: (statePath: string, opts: Parameters<typeof dialHost>[1]) => {
        dialled = true;
        return dialHost(statePath, opts);
      },
      now: Date.now,
      deviceName: () => "a test",
      window: dialWindowMs,
    };
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "../evil" }, [box.url], watched)).rejects.toThrow(/not a host alias/);
    // The host is untouched: a code spent for a name nothing can hold would leave a device over there whose only
    // token went nowhere, and no record here to disconnect it with.
    expect(dialled).toBe(false);
    expect(await box.devices()).toEqual([]);
  });

  it("refuses a code that names no key before it dials anything, and spends nothing", async () => {
    const box = await boxAndHome();
    let dialled = false;
    const watched: ConnectDeps = {
      dial: (statePath: string, opts: DialOpts) => {
        dialled = true;
        return dialHost(statePath, opts);
      },
      now: Date.now,
      deviceName: () => "a test",
      window: dialWindowMs,
    };
    const code = await box.codeAlone();
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code, name: "box" }, [box.url], watched)).rejects.toThrow(PAIR_NO_KEY_REFUSAL);
    expect(dialled).toBe(false);
    expect(readHost(box.home, "box")).toBeUndefined();
    // The code is still the host's to hand to a line that carries the whole token.
    expect(await box.devices()).toEqual([]);
    expect(await connectCommand(io(), { statePath: STATE, home: box.home }, { code: pairToken(code, box.hostKey), name: "box" }, [box.url])).toBe(0);
    expect(readHost(box.home, "box")!.hostKey).toBe(box.hostKey);
  });

  it("sends nothing at all to a host that proves another key, and leaves the code unspent", async () => {
    const box = await boxAndHome();
    const code = await box.codeAlone();
    const wrong = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: pairToken(code, wrong), name: "box" }, [box.url])).rejects.toThrow(pairKeyRefusal(box.url));
    expect(readHost(box.home, "box")).toBeUndefined();
    // Nothing of this computer's crossed: no device over there, and the code still buys one for a line that
    // names the key this host really proves.
    expect(await box.devices()).toEqual([]);
    expect(await connectCommand(io(), { statePath: STATE, home: box.home }, { code: pairToken(code, box.hostKey), name: "box" }, [box.url])).toBe(0);
    expect(await box.devices()).toEqual([readHost(box.home, "box")!.deviceId]);
  });

  it("says a host that answered the seal with a refusal did not prove its key, rather than that a token was taken away", async () => {
    // A runtime with no place door proves no key and refuses the first frame. No token and no code of this
    // computer's crossed, so the line says which host did not prove itself rather than reading the refusal as a
    // device this host revoked, which is what the alias road says for a refused token.
    const store = memoryStore();
    void store.put("goldens", copyKey("default", "default"), GOLDEN);
    const bare = await startHost({ runtime: createRuntime({ backend: stubBackend(), store, adapters: {} }), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    try {
      const url = `http://127.0.0.1:${bare.port}`;
      const home = tempDir("connect-unsealed");
      writeHost(home, "box", { url, deviceId: "d_1", deviceToken: "tok-1", hostKey: "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A", pairedAt: "2026-09-20T00:00:00.000Z" });
      await expect(dialHost(STATE, { host: "box", home, env: {} })).rejects.toThrow(pairKeyRefusal(url));
    } finally {
      await bare.close();
    }
  });

  it("refuses a second connect under a name this computer already holds rather than dropping the token it has", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const kept = readHost(box.home, "box")!;
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url])).rejects.toThrow(/already/);
    expect(readHost(box.home, "box")).toEqual(kept);
  });
});

describe("a verb against a connected host", () => {
  it("dials the alias over the app's own port with the device token it was paired with", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const client = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    try {
      expect(await client.request("workspaces.list")).toMatchObject({ ok: true });
    } finally {
      client.close();
    }
  });

  it("dials the alias WSP_HOST names, with no flag on the line", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const client = await dialHost(STATE, { home: box.home, env: { WSP_HOST: "box" } });
    try {
      expect(await client.request("workspaces.list")).toMatchObject({ ok: true });
    } finally {
      client.close();
    }
  });

  it("runs a verb against the alias --host names, and notes that --state is not read for a host elsewhere", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const log: string[] = [];
    const err: string[] = [];
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    const ran = await runVerb(threads, ["threads", "--host", "box", "--state", STATE], io(log, err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(err.join("\n"), log.join("\n")).toContain("--state");
    expect(ran).toBe(0);
  });

  it("takes --host wherever it sits: before the verb's words, between them and after them", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const env = { WSP_HOME: box.home };

    const before: string[] = [];
    expect(await cli(["--host", "box", "threads"], io(before), undefined, env)).toBe(0);
    const after: string[] = [];
    expect(await cli(["threads", "--host", "box"], io(after), undefined, env)).toBe(0);
    expect(before).toEqual(after);

    // Between the verb's own words the flag still aims the line: this thread is on no host, and the answer is the
    // one that host gives rather than a usage dump from a line that never read the flag.
    const err: string[] = [];
    expect(await cli(["thread", "--host", "box", "read", "th_none"], io([], err), undefined, env)).toBe(EXIT_CODES.usage);
    expect(err).toEqual(["wsp thread read: no thread th_none"]);
  });

  it("takes the road through that host, and starts no host here, even though nothing serves the state file here", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const err: string[] = [];
    let startedHere = false;
    const newWorkspace = CLI_VERBS.find(v => v.name === "new")!;
    await runVerb(newWorkspace, ["new", "nowhere", "here", "--host", "box"], io([], err), () => STATE, {
      env: { WSP_HOME: box.home },
      start: () => {
        startedHere = true;
        throw new Error("a host on this computer is not the road to a host somewhere else");
      },
    });
    // Nothing serves the state file here, which is the one case a line starts a host for itself; the line names a
    // host somewhere else, so it goes there and the answer is that host's own.
    expect(startedHere).toBe(false);
    expect(err.join("\n")).toContain("wsp new: ");
  });

  it("keeps the note for the dial, so a line that never reaches a host does not claim its state file went unread", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const err: string[] = [];
    // Refused on its own words before anything dials, which is where a verb that reads the state file and never
    // dials would be: nothing has been left unread, so nothing says it was.
    const newWorkspace = CLI_VERBS.find(v => v.name === "new")!;
    const ran = await runVerb(newWorkspace, ["new", "one", "two", "three", "--host", "box", "--state", STATE], io([], err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(ran).toBe(3);
    expect(err.join("\n")).toContain("wsp new takes the work you are doing");
    expect(err.join("\n")).not.toContain("--state names");
  });

  it("refuses an address where a name goes on any verb but connect, since an address carries no token", async () => {
    const box = await boxAndHome();
    const err: string[] = [];
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    const ran = await runVerb(threads, ["threads", "--host", box.url], io([], err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(err.join("\n")).toContain(`wsp host connect ${box.url} --code <code>`);
    expect(err.join("\n").split("\n")).toHaveLength(1);
    expect(ran).toBe(3);
    await expect(dialHost(STATE, { host: box.url, home: box.home, env: {} })).rejects.toThrow(/--host takes the name/);
  });

  it("reads no lock and prints no note when the line names no host elsewhere", async () => {
    const box = await boxAndHome();
    const err: string[] = [];
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    await runVerb(threads, ["threads", "--state", STATE], io([], err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(err.join("\n")).not.toContain("--state names");
  });

  it("says in one sentence that the host took this computer's token away, and how to pair again", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const kept = readHost(box.home, "box")!;
    await overHostToken(handle!.wsPort, handle!.authToken, "devices.list");
    const revoker = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    await revoker.request("devices.revoke", { deviceId: kept.deviceId });
    revoker.close();

    const refused = await dialHost(STATE, { host: "box", home: box.home, env: {} }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    const line = (refused as Error).message;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("box");
    expect(line).toContain("wsp host connect");
    expect((refused as { kind?: string }).kind).toBe("auth");
  });

  it("waits the window the road gets, and says how long it waited in the one sentence", async () => {
    const box = await boxAndHome();
    const road = await roadTo(handle!.port);
    const at = `http://127.0.0.1:${road.port}`;
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [at]);
    // A road that carries nothing: the socket is accepted here and the upgrade never reaches the host, so the dial
    // has only its window to end on. This one is loopback, which is the window a host on this computer answers in.
    road.stall();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const refused = dialHost(STATE, { host: "box", home: box.home, env: {} }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const e = (await refused) as Error & { kind?: string };
      expect(e.message).toBe(`the host at ${at} did not answer: nothing came back within 5000 ms`);
      expect(e.kind).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says in one sentence that the host did not answer, naming its address and not its token", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const kept = readHost(box.home, "box")!;
    await handle!.close();
    handle = undefined;

    const refused = await dialHost(STATE, { host: "box", home: box.home, env: {} }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message.split("\n")).toHaveLength(1);
    expect((refused as Error).message).toContain(box.url);
    expect((refused as Error).message).not.toContain(kept.deviceToken);
  });
});

describe("wsp host default", () => {
  it("moves the default to the alias named, and refuses an alias nothing is stored for", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "one" }, [box.url]);
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "two" }, [box.url]);
    expect(await hostDefaultCommand(io(), { statePath: STATE, home: box.home }, ["two"])).toBe(0);
    expect(defaultHost(box.home)).toBe("two");
    await expect(hostDefaultCommand(io(), { statePath: STATE, home: box.home }, ["three"])).rejects.toThrow(/three/);
    await expect(hostDefaultCommand(io(), { statePath: STATE, home: box.home }, [])).rejects.toThrow(/usage/);
    await expect(hostDefaultCommand(io(), { statePath: STATE, home: box.home }, ["two", "three"])).rejects.toThrow(/usage/);
  });
});

describe("wsp host forget", () => {
  it("hands the token back to the host and takes the record off this computer", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    expect(await box.devices()).toHaveLength(1);
    const log: string[] = [];
    expect(await disconnectCommand(io(log), { statePath: STATE, home: box.home }, ["box"])).toBe(0);
    expect(await box.devices()).toEqual([]);
    expect(readHost(box.home, "box")).toBeUndefined();
    expect(defaultHost(box.home)).toBeUndefined();
    expect(log.join("\n")).toContain("box");
  });

  it("takes the record off this computer when the host does not answer, and says what is left to do there", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const kept = readHost(box.home, "box")!;
    await handle!.close();
    handle = undefined;
    const log: string[] = [];
    const err: string[] = [];
    expect(await disconnectCommand(io(log, err), { statePath: STATE, home: box.home }, ["box"])).toBe(0);
    expect(readHost(box.home, "box")).toBeUndefined();
    expect(err.join("\n")).toContain(`wsp host devices revoke ${kept.deviceId}`);
    // A host that is off refuses the connection at once, so the second try costs nothing and the person is told
    // there was one rather than reading one refusal for two.
    expect(err.join("\n")).toContain(`still asking the host at ${box.url}`);
  });

  it("says the token was already taken away when the host refuses it, rather than leaving a job that is done", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const kept = readHost(box.home, "box")!;
    const revoker = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    await revoker.request("devices.revoke", { deviceId: kept.deviceId });
    revoker.close();
    const log: string[] = [];
    const err: string[] = [];
    let dials = 0;
    const counted = handBackDeps((statePath, opts) => {
      dials += 1;
      return dialHost(statePath, opts);
    });
    expect(await disconnectCommand(io(log, err), { statePath: STATE, home: box.home }, ["box"], counted)).toBe(0);
    expect(log.join("\n")).toContain("already");
    expect(err).toEqual([]);
    expect(readHost(box.home, "box")).toBeUndefined();
    // What the host itself said stands on the first answer: only a road that carried nothing is asked twice.
    expect(dials).toBe(1);
  });

  it("asks again when the road carried nothing, rather than leaving the device standing over there", async () => {
    const box = await boxAndHome();
    const road = await roadTo(handle!.port);
    const at = `http://127.0.0.1:${road.port}`;
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [at]);
    expect(await box.devices()).toHaveLength(1);

    // Nothing crosses the road on the first try, which is an edge holding a request while its tunnel comes up, and
    // the second try finds the road carrying again.
    road.stall();
    let dials = 0;
    const flaky = handBackDeps((statePath, opts) => {
      dials += 1;
      if (dials === 2) road.resume();
      return dialHost(statePath, opts);
    });
    const log: string[] = [];
    const err: string[] = [];
    expect(await disconnectCommand(io(log, err), { statePath: STATE, home: box.home }, ["box"], flaky)).toBe(0);
    expect(dials).toBe(2);
    expect(await box.devices()).toEqual([]);
    expect(readHost(box.home, "box")).toBeUndefined();
    // A second try nobody was told about is a wait with no words on it; this is the only thing on stderr.
    expect(err).toEqual([`still asking the host at ${at}; this try waits up to 300 ms`]);
  });

  it("says the host did not answer when the socket opened and the reply never came, and still lets the record go", async () => {
    const box = await boxAndHome();
    const road = await roadTo(handle!.port);
    const at = `http://127.0.0.1:${road.port}`;
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [at]);
    const kept = readHost(box.home, "box")!;

    // The dial and its auth are answered and then the road goes quiet, which is the half dead link nothing closes:
    // a reply nobody has a window for is a line that says nothing at all.
    const quiet = handBackDeps(async (statePath, opts) => {
      road.resume();
      const client = await dialHost(statePath, opts);
      road.stall();
      return client;
    });
    const log: string[] = [];
    const err: string[] = [];
    expect(await disconnectCommand(io(log, err), { statePath: STATE, home: box.home }, ["box"], quiet)).toBe(0);
    expect(readHost(box.home, "box")).toBeUndefined();
    expect(err.join("\n")).toContain(`the host at ${at} did not answer: nothing came back within 300 ms`);
    expect(err.join("\n")).toContain(`wsp host devices revoke ${kept.deviceId}`);
    // Honest about what is left over there: the revoke never reached the host, so the device is still standing.
    expect(await box.devices()).toEqual([kept.deviceId]);
    // And the road is not held past the window: a graceful close waits on an answer a dead road never carries, and
    // the socket behind it keeps the line alive for as long as the operating system holds the connection.
    expect(await roadEmpty(road)).toBe(0);
  });

  it("lets the record go when the record's own address is no address, rather than throwing over it", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    // The hosts folder is a folder of files, and a hand that edited one is the reason the record goes whatever
    // comes back: a word no dial can read must still leave this computer holding no token.
    const kept = readHost(box.home, "box")!;
    writeHost(box.home, "box", { ...kept, url: "not-an-address" });
    const log: string[] = [];
    const err: string[] = [];
    expect(await disconnectCommand(io(log, err), { statePath: STATE, home: box.home }, ["box"])).toBe(0);
    expect(readHost(box.home, "box")).toBeUndefined();
    expect(err.join("\n")).toContain(`wsp host devices revoke ${kept.deviceId}`);
    // The words are the ones this file already holds every address to, never the URL parser's, which names nothing
    // the person can act on.
    expect(err.join("\n")).toContain(`"not-an-address" is not an address this computer can dial`);
    expect(err.join("\n")).not.toContain("Invalid URL");
  });

  it("stands while a reply the window gave up on arrives after the socket goes", async () => {
    const box = await boxAndHome();
    const road = await roadTo(handle!.port);
    const at = `http://127.0.0.1:${road.port}`;
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [at]);
    const quiet = handBackDeps(async (statePath, opts) => {
      road.resume();
      const client = await dialHost(statePath, opts);
      road.stall();
      return client;
    });
    const err: string[] = [];
    expect(await disconnectCommand(io([], err), { statePath: STATE, home: box.home }, ["box"], quiet)).toBe(0);
    // The close this line sent sat on the stalled road; the road carrying again lets the host answer it, which
    // fails the reply nobody is waiting for any more. The race the window is built on is what keeps that failure
    // handled, and this is the guard on it: unhandled, it would end the whole run.
    road.resume();
    await new Promise(done => setTimeout(done, 200));
    expect(err.join("\n")).toContain("did not answer");
  });

  it("refuses an alias nothing is stored for, and a line with no alias", async () => {
    const home = tempDir("connect-home");
    await expect(disconnectCommand(io(), { statePath: STATE, home }, ["box"])).rejects.toThrow(/box/);
    await expect(disconnectCommand(io(), { statePath: STATE, home }, [])).rejects.toThrow(/usage/);
  });
});

describe("the command line's own environment", () => {
  it("reads the hosts folder out of the environment the run was handed, not this process's own", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const lines: string[] = [];
    const out: CliIO = { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
    expect(await cli(["hosts"], out, runningWsp(), { WSP_HOME: box.home })).toBe(0);
    expect(lines.join("\n")).toContain("box");
    expect(lines.join("\n")).toContain(box.url);
    // A computer signed in to no account still reads what it paired with a code, and is told which line signs in.
    expect(lines.join("\n")).toContain("wsp login");
  });
});

describe("the tool server against a connected host", () => {
  it("dials the alias it was started with and keeps that one socket across calls", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const dial = dialer(STATE, { host: "box", home: box.home, env: {} });
    try {
      const client = await dial();
      expect(await client.request("workspaces.list")).toMatchObject({ ok: true });
      expect(await dial()).toBe(client);
    } finally {
      await dial.close();
    }
  });
});

describe("a host on the account, reached with no code", () => {
  /** The key the computer that linked the host signs an admission with, which the host trusts. */
  const signerKey = newPlaceKeyPair();

  /** One admission as a wsp already in signs it: the key admitted, the signer's, the moment, and the signature. */
  const admissionFor = (device: string): { by: string; issuedAt: string; signature: string } => {
    const by = keyFingerprint(signerKey.publicKey);
    const issuedAt = "2026-09-22T00:00:00.000Z";
    return { by, issuedAt, signature: signPlaceBytes(signerKey.privateKeyPem, deviceAdmissionTranscript(device, by, issuedAt)) };
  };

  /** A host of this process that is on an account: the key it trusts and the listing its beat learned, which a
   * test moves under it. The home is this computer's, holding the key this computer signs with and the record wsp
   * hosts wrote off the listing. */
  async function accountBox(): Promise<{ url: string; home: string; devices: () => Promise<DeviceView[]>; listed: (rows: AccountDevice[]) => void; wsPort: number; authToken: string }> {
    const { runtime, statePath } = testRuntime();
    let listed: AccountDevice[] = [];
    handle = await startHost({
      runtime,
      webDir: fakeWebDir(),
      port: 0,
      wsPort: 0,
      admitted: { signer: () => ({ fingerprint: keyFingerprint(signerKey.publicKey), publicKey: signerKey.publicKey }), list: () => listed, refresh: async () => {} },
    });
    const up = handle;
    const home = tempDir("connect-home");
    // What wsp hosts writes for a host on the account: the address and the key off the listing, and no token.
    writeHost(home, "box", { url: `http://127.0.0.1:${up.port}`, deviceId: "", deviceToken: "", hostKey: hostKeyHere(statePath), pairedAt: "2026-09-22T00:00:00.000Z", via: { kind: "account", hostId: "hbox1" } });
    const laptop = deviceKeyHere(home);
    listed = [{ id: "c_laptop", name: "the laptop", fingerprint: keyFingerprint(laptop.publicKey), admissions: [admissionFor(keyFingerprint(laptop.publicKey))] }];
    return {
      url: `http://127.0.0.1:${up.port}`,
      home,
      wsPort: up.wsPort,
      authToken: up.authToken,
      devices: async () => (await overHostToken(up.wsPort, up.authToken, "devices.list"))["devices"] as DeviceView[],
      listed: rows => {
        listed = rows;
      },
    };
  }

  it("proves this computer's key on the first dial, keeps the token the host answered and is listed there as an account device", async () => {
    const box = await accountBox();
    const client = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    expect((await client.request("workspaces.list")).ok).toBe(true);
    client.close();

    const kept = readHost(box.home, "box")!;
    expect(kept.deviceId).toMatch(/^d_/);
    expect(kept.deviceToken).toMatch(/\S/);
    // The record keeps everything else it had: the road it came by, the address and the key it pinned.
    expect(kept.via).toEqual({ kind: "account", hostId: "hbox1" });
    const [device] = await box.devices();
    expect(device).toMatchObject({ id: kept.deviceId, via: { kind: "account", relayDeviceId: "c_laptop", admittedBy: keyFingerprint(signerKey.publicKey) } });
    // The next line takes the token the first one bought, and admits nobody again.
    const second = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    second.close();
    expect(await box.devices()).toHaveLength(1);
    expect(readHost(box.home, "box")!.deviceId).toBe(kept.deviceId);
  });

  it("is re-admitted once when that host no longer holds this computer's token, and writes the fresh one", async () => {
    const box = await accountBox();
    const first = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    first.close();
    const before = readHost(box.home, "box")!;
    // A token that host never minted and no key it refuses: a state file put back from a copy, or a record carried
    // over from a host that was rebuilt. The account still names this computer, so it proves its key and carries on.
    writeHost(box.home, "box", { ...before, deviceToken: "a token no host minted" });

    const again = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    expect((await again.request("workspaces.list")).ok).toBe(true);
    again.close();
    const kept = readHost(box.home, "box")!;
    expect(kept.deviceId).not.toBe(before.deviceId);
    expect((await box.devices()).map(d => d.id)).toContain(kept.deviceId);
  });

  it("writes no token into the record on a dial that spent a code there, since this computer proved no key for it", async () => {
    const box = await accountBox();
    const issued = await overHostToken(box.wsPort, box.authToken, "pair.issue");
    const held = readHost(box.home, "box")!;
    const client = await dialHost(STATE, { host: "box", home: box.home, env: {}, redeem: { code: issued["code"] as string, name: "the laptop", hostKey: held.hostKey! } });
    expect((await client.request("workspaces.list")).ok).toBe(true);
    client.close();

    // The token a redeem bought belongs to the line that spent the code, which writes its own record; the account
    // record stands as the listing wrote it until this computer proves its key at that host.
    expect(readHost(box.home, "box")).toMatchObject({ deviceId: "", deviceToken: "" });
  });

  it("is not re-admitted at a host that revoked it and remembers the key, whatever admission the account still carries", async () => {
    const box = await accountBox();
    const first = await dialHost(STATE, { host: "box", home: box.home, env: {} });
    first.close();
    const gone = readHost(box.home, "box")!.deviceId;
    const host = await dialHost(STATE, { aim: { kind: "url", url: box.url, token: box.authToken } });
    expect(await host.request("devices.revoke", { deviceId: gone })).toMatchObject({ revoked: true });
    host.close();

    const refused = await dialHost(STATE, { host: "box", home: box.home, env: {} }).then(() => undefined, (e: unknown) => e as Error);
    expect(refused!.message).toContain(DEVICE_REVOKED_REFUSAL);
    expect(await box.devices()).toEqual([]);
  });

  it("prints the host's own sentence when it will not admit this computer, and writes nothing", async () => {
    const box = await accountBox();
    // The account no longer holds this computer, so nothing there admits it: the host's own refusal is the answer.
    box.listed([]);
    const refused = await dialHost(STATE, { host: "box", home: box.home, env: {} }).then(() => undefined, (e: unknown) => e as Error);
    expect(refused!.message).toContain(DEVICE_AUTH_REFUSAL);
    expect(readHost(box.home, "box")!.deviceToken).toBe("");
    expect(await box.devices()).toEqual([]);
  });

  it("dials a host that proves another key once, since only a refused token is worth a second dial", async () => {
    const other = await olderHost();
    const home = tempDir("connect-moved");
    deviceKeyHere(home);
    // A record with a token and a key that host does not prove: the seal refuses before any frame of this
    // computer's crosses, and proving the device key at the same seal would refuse for the same reason.
    writeHost(home, "box", {
      url: other.url,
      deviceId: "d_1",
      deviceToken: "t",
      hostKey: keyFingerprint(newPlaceKeyPair().publicKey),
      pairedAt: "2026-09-22T00:00:00.000Z",
      via: { kind: "account", hostId: "hbox1" },
    });
    const refused = await dialHost(STATE, { host: "box", home, env: {} }).then(() => undefined, (e: unknown) => e as Error);
    expect(refused!.message).toBe(pairKeyRefusal(other.url));
    expect(other.dials()).toBe(1);
  });

  it("reads an older host's refusal of that frame as an older wsp, and names the code road there", async () => {
    // A host whose door knows no device.auth: it answers the frame with its request schema's own words, no kind
    // on the frame and the unauthorized close behind it, which is what every wsp before this one does.
    const older = await olderHost();
    const home = tempDir("connect-older");
    deviceKeyHere(home);
    writeHost(home, "box", { url: older.url, deviceId: "", deviceToken: "", hostKey: older.hostKey, pairedAt: "2026-09-22T00:00:00.000Z", via: { kind: "account", hostId: "hbox1" } });
    const refused = await dialHost(STATE, { host: "box", home, env: {} }).then(() => undefined, (e: unknown) => e as Error);
    expect(refused!.message).toBe(deviceAuthOldHostLine(older.url));
    expect(refused!.message).toContain("wsp host pair");
    expect(readHost(home, "box")!.deviceToken).toBe("");
  });
});

/** A host of an older wsp, for the one case about what this computer reads off one: it proves its key as every host
 * has since keys were pinned, seals what follows, and answers the frame it does not know with its schema's own
 * refusal, no kind and the unauthorized close. */
async function olderHost(): Promise<{ url: string; hostKey: string; dials: () => number }> {
  const key = newPlaceKeyPair();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  let dials = 0;
  server.on("connection", ws => {
    dials += 1;
    let seal: Seal | undefined;
    ws.on("message", raw => {
      const frame = JSON.parse(openFrame(seal, raw)) as { id: number; op: string; nonce?: string; ephemeral?: string };
      if (frame.op === "seal.open" && seal === undefined) {
        const mine = freshEphemeral();
        const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
        ws.send(
          JSON.stringify({
            id: frame.id,
            ok: true,
            nonce,
            hostPublicKey: key.publicKey,
            ephemeral: mine.publicKey,
            signature: signPlaceBytes(key.privateKeyPem, placeLinkTranscript("host", SEAL_CLIENT, frame.nonce!, nonce, { challenger: frame.ephemeral!, answerer: mine.publicKey })),
          }),
        );
        seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, frame.ephemeral!), SEAL_CLIENT), "host");
        return;
      }
      // The words an older door answers a frame its schema does not know with: the schema's own, and no kind.
      ws.send(seal!.seal(JSON.stringify({ id: frame.id, ok: false, error: "invalid_union at op" })));
      ws.close(4401, UNAUTHORIZED);
    });
  });
  await new Promise<void>(done => server.once("listening", () => done()));
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`, hostKey: keyFingerprint(key.publicKey), dials: () => dials };
}
