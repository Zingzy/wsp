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
import { PAIR_CODE_REFUSAL } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { connectCommand, disconnectCommand, hostsCommand, type ConnectDeps } from "../src/connect.js";
import { cli, type CliIO } from "../src/cli.js";
import { runningWsp } from "../src/mcp-install.js";
import { defaultHost, dialWindowMs, hostsDir, readHost, writeHost } from "../src/hosts.js";
import { dialer } from "../src/mcp.js";
import { CLI_VERBS, dialHost, runVerb, type DialOpts, type HostClient } from "../src/verbs.js";
import { startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { startTcpProxy, type TcpProxy } from "../../runtime/test/tcp-proxy.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[] = [], err: string[] = []): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

let dirs: string[] = [];
let handle: HostHandle | undefined;
let roads: TcpProxy[] = [];
afterEach(async () => {
  for (const road of roads) await road.close();
  roads = [];
  await handle?.close();
  handle = undefined;
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
  relayUrl: () => Promise.reject(new Error("this line names an alias, so no relay is asked")),
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

function testRuntime(): Runtime {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
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

/** A host of this process, the folder wsp connect writes into, and a fresh code from that host. */
async function boxAndHome(): Promise<{ url: string; home: string; code: () => Promise<string>; devices: () => Promise<string[]> }> {
  handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
  const up = handle;
  return {
    url: `http://127.0.0.1:${up.port}`,
    home: tempDir("connect-home"),
    code: async () => (await overHostToken(up.wsPort, up.authToken, "pair.issue"))["code"] as string,
    devices: async () => ((await overHostToken(up.wsPort, up.authToken, "devices.list"))["devices"] as { id: string }[]).map(d => d.id),
  };
}

const STATE = "/nowhere/state.json";

describe("wsp connect", () => {
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
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: "ZZZZZZZZ", name: "box" }, [box.url])).rejects.toThrow(PAIR_CODE_REFUSAL);
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
      relayUrl: () => Promise.reject(new Error("this line names an address, so no relay is asked")),
      window: dialWindowMs,
    };
    // ws and wss are addresses a socket is dialled at, not ones a host is served at, and an http:// with no
    // computer after it reached the URL parser and threw a TypeError nobody could act on.
    for (const word of ["http://", "https://", "ws://x", "wss://x:4410", "http:/box", "box", "box:4400"]) {
      await expect(connectCommand(io(), { statePath: STATE, home }, { code: "ABCD1234" }, [word], never)).rejects.toThrow(
        `wsp connect takes the address the host is served at, and got ${JSON.stringify(word)}. An address starts http:// or https:// and names the computer it runs on.`,
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
      relayUrl: () => Promise.reject(new Error("this line names an address, so no relay is asked")),
      window: dialWindowMs,
    };
    await expect(connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "../evil" }, [box.url], watched)).rejects.toThrow(/not a host alias/);
    // The host is untouched: a code spent for a name nothing can hold would leave a device over there whose only
    // token went nowhere, and no record here to disconnect it with.
    expect(dialled).toBe(false);
    expect(await box.devices()).toEqual([]);
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

  it("takes the road through that host, not a runtime in this process, even though nothing serves the state file here", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const err: string[] = [];
    let builtHere = false;
    const newWorkspace = CLI_VERBS.find(v => v.name === "new")!;
    await runVerb(newWorkspace, ["new", "--local", "here", "--host", "box"], io([], err), () => STATE, {
      env: { WSP_HOME: box.home },
      runtime: () => {
        builtHere = true;
        throw new Error("a runtime in this process is not the road to a host somewhere else");
      },
    });
    // The state file here has no host, which is the one case the verb builds a runtime in this process for; the
    // line names a host somewhere else, so it goes there and the answer is that host's own.
    expect(builtHere).toBe(false);
    expect(err.join("\n")).toContain("this host");
  });

  it("keeps the note for the dial, so a line that never reaches a host does not claim its state file went unread", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const err: string[] = [];
    // Refused on its own words before anything dials, which is where a verb that reads the state file and never
    // dials would be: nothing has been left unread, so nothing says it was.
    const newWorkspace = CLI_VERBS.find(v => v.name === "new")!;
    const ran = await runVerb(newWorkspace, ["new", "--local", "--ssh", "maya@box", "--host", "box", "--state", STATE], io([], err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(ran).toBe(3);
    expect(err.join("\n")).toContain("not both");
    expect(err.join("\n")).not.toContain("--state names");
  });

  it("refuses an address where a name goes on any verb but connect, since an address carries no token", async () => {
    const box = await boxAndHome();
    const err: string[] = [];
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    const ran = await runVerb(threads, ["threads", "--host", box.url], io([], err), () => STATE, { env: { WSP_HOME: box.home } });
    expect(err.join("\n")).toContain(`wsp connect ${box.url} --code <code>`);
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
    expect(line).toContain("wsp connect");
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

describe("wsp hosts", () => {
  it("lists every connected host with its address and marks the default, and never prints a token", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "box" }, [box.url]);
    const log: string[] = [];
    expect(await hostsCommand(io(log), { statePath: STATE, home: box.home }, [])).toBe(0);
    expect(log[0]).toMatch(/^ALIAS/);
    expect(log[1]).toContain("box");
    expect(log[1]).toContain(box.url);
    expect(log[1]).toContain("default");
    expect(log.join("\n")).not.toContain(readHost(box.home, "box")!.deviceToken);
  });

  it("says so when this computer is connected to none", async () => {
    const log: string[] = [];
    expect(await hostsCommand(io(log), { statePath: STATE, home: tempDir("connect-home") }, [])).toBe(0);
    expect(log[0]).toContain("wsp connect");
  });

  it("moves the default to the alias named, and refuses an alias nothing is stored for", async () => {
    const box = await boxAndHome();
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "one" }, [box.url]);
    await connectCommand(io(), { statePath: STATE, home: box.home }, { code: await box.code(), name: "two" }, [box.url]);
    expect(await hostsCommand(io(), { statePath: STATE, home: box.home }, ["default", "two"])).toBe(0);
    expect(defaultHost(box.home)).toBe("two");
    await expect(hostsCommand(io(), { statePath: STATE, home: box.home }, ["default", "three"])).rejects.toThrow(/three/);
    await expect(hostsCommand(io(), { statePath: STATE, home: box.home }, ["default"])).rejects.toThrow(/usage/);
    await expect(hostsCommand(io(), { statePath: STATE, home: box.home }, ["nonsense"])).rejects.toThrow(/usage/);
  });
});

describe("wsp disconnect", () => {
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
    expect(err.join("\n")).toContain(`wsp devices revoke ${kept.deviceId}`);
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
    expect(err.join("\n")).toContain(`wsp devices revoke ${kept.deviceId}`);
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
    expect(err.join("\n")).toContain(`wsp devices revoke ${kept.deviceId}`);
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
