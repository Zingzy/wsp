// SPDX-License-Identifier: AGPL-3.0-only
// A line and a host of two releases: the host names its release in the answer
// that lets the socket in, and the line refuses there in one sentence naming
// both and what to run on the older end, on every road a line dials.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, UP_RESTART_LINE } from "@wsp/protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mcpServer } from "../src/mcp.js";
import { cli, type CliIO } from "../src/cli.js";
import { hostTokenPath, lockPathFor, type HostLock } from "../src/host-lock.js";
import { dialHost, findVerb, releaseRefusal, runVerb, type DialOpts, type HostClient } from "../src/verbs.js";
import { hostRoadOf, type HostRoad } from "../src/restart.js";
import { VERSION } from "../src/version.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

let dir: string | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[], err: string[]): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

/** The lock each road writes: the app's service unit marks its host as the service, and init's host carries no mark. */
const LOCK_OF: Record<HostRoad, HostLock["startedBy"]> = { app: "service", service: "service", verb: "verb", up: "up", init: undefined };

/** A host serving a state file of its own under the release given, which names the road it comes back by beside it,
 * answers every op it is asked and records them. */
async function hostOf(release: string | undefined, road: HostRoad = "verb"): Promise<{ statePath: string; port: number; asked: string[] }> {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const asked: string[] = [];
  server.on("connection", ws => {
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      asked.push(String(frame["op"]));
      const named = frame["op"] === "auth" && release !== undefined ? { version: release, road } : {};
      ws.send(JSON.stringify({ id: frame["id"], ok: true, places: [], adds: [], pending: [], sessions: [], ...named }));
      // A host asked to restart lets its socket go, as one does on its way down, and the next dial finds it back.
      if (frame["op"] === "host.restart") ws.close();
    });
  });
  await new Promise<void>(r => server!.once("listening", () => r()));
  dir = mkdtempSync(join(tmpdir(), "wsp-host-release-"));
  const statePath = join(dir, "state", "state.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  const port = (server.address() as { port: number }).port;
  const startedBy = LOCK_OF[road];
  const lock: HostLock = { pid: process.pid, port, startedAt: new Date().toISOString(), ...(startedBy !== undefined ? { startedBy } : {}) };
  writeFileSync(lockPathFor(statePath), JSON.stringify(lock));
  writeFileSync(hostTokenPath(statePath), "host-token");
  return { statePath, port, asked };
}

const typed = async (argv: string[], env: Record<string, string> = {}): Promise<{ code: number; errors: string[] }> => {
  const errors: string[] = [];
  const code = await cli(argv, io([], errors), undefined, { WSP_HOME: join(dir!, "home"), ...env }, false);
  return { code, errors };
};

it("an older host serving this state is refused in one sentence naming both releases and the fix its own road takes, before anything is asked of it", async () => {
  const fixes: Record<HostRoad, string> = {
    verb: "restart that host with wsp restart.",
    service: "restart that host with wsp restart.",
    // The app's host runs off the app's bundle under the service mark the app writes, and comes back on its release.
    app: `quit and reopen the app that holds it once the app is on wsp ${VERSION}.`,
    up: UP_RESTART_LINE,
    init: "let the wsp init that serves it finish, then run this line again.",
  };
  for (const road of Object.keys(fixes) as HostRoad[]) {
    const { statePath, asked } = await hostOf("0.0.1", road);
    const { code, errors } = await typed(["computers", "--state", statePath]);
    expect(code, road).toBe(EXIT_CODES.usage);
    expect(errors, road).toEqual([`wsp computers: this line runs wsp ${VERSION} and the host serving ${statePath} runs wsp 0.0.1: ${fixes[road]}`]);
    expect(asked, road).toEqual(["auth"]);
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

it("names the road a host comes back by off its install and what started it: the app's bundle whatever started it, else the road, else init's", () => {
  const app = { argv: [process.execPath, "/Applications/wsp.app/Contents/Resources/wsp/bin/wsp"] };
  const npm = { argv: [process.execPath, "/usr/local/lib/node_modules/@wsp-labs/wsp/dist/bin.js"] };
  expect(hostRoadOf(app, "service")).toBe("app");
  expect(hostRoadOf(npm, "service")).toBe("service");
  expect(hostRoadOf(npm, "up")).toBe("up");
  expect(hostRoadOf(npm, undefined)).toBe("init");
});

it("a newer host is refused with the line that brings this computer's wsp to its release", async () => {
  const { statePath, asked } = await hostOf("999.0.0");
  const { code, errors } = await typed(["computers", "--state", statePath]);
  expect(code).toBe(EXIT_CODES.usage);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(new RegExp(`^wsp computers: this line runs wsp ${VERSION.replace(/\./g, "\\.")} and the host serving .* runs wsp 999\\.0\\.0: .* on this computer brings this line to 999\\.0\\.0\\.$`));
  expect(asked).toEqual(["auth"]);
});

it("a turn's launch pair on this computer is named by its address and told the fix of the host here, never to update that computer", async () => {
  const { port, asked } = await hostOf("0.0.1", "service");
  const url = `http://127.0.0.1:${port}`;
  const { code, errors } = await typed(["computers"], { WSP_HOST_URL: url, WSP_HOST_TOKEN: "scoped" });
  expect(code).toBe(EXIT_CODES.usage);
  expect(errors).toEqual([`wsp computers: this line runs wsp ${VERSION} and the host at ${url} runs wsp 0.0.1: restart that host with wsp restart.`]);
  expect(asked).toEqual(["auth"]);
});

it("an older host on another computer is told to update wsp there", () => {
  expect(releaseRefusal(VERSION, "0.0.1", { where: "attic", here: false }, "service").message).toBe(
    `this line runs wsp ${VERSION} and the host at attic runs wsp 0.0.1: update wsp to ${VERSION} on that computer and restart its host there.`,
  );
});

it("a host of the same release, and one from before the answer named a release, are dialled as before", async () => {
  for (const release of [VERSION, undefined]) {
    const { statePath, asked } = await hostOf(release);
    const client: HostClient = await dialHost(statePath, { aim: { kind: "here" } });
    await client.request("places.list");
    client.close();
    expect(asked).toEqual(["auth", "places.list"]);
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    rmSync(dir!, { recursive: true, force: true });
    dir = undefined;
  }
});

it("wsp restart dials a host of another release all the same, since the restart is the fix it is told to run", async () => {
  const dialled: DialOpts[] = [];
  const restart = findVerb(["restart"])!;
  await runVerb(restart, ["restart", "--state", "/nowhere/state.json"], io([], []), p => p ?? "/nowhere/state.json", {
    env: {},
    dial: async (_statePath, opts) => {
      dialled.push(opts ?? {});
      throw new Error("no host here");
    },
  });
  expect(dialled[0]).toMatchObject({ anyRelease: true });
  const computers = findVerb(["computers"])!;
  await runVerb(computers, ["computers", "--state", "/nowhere/state.json"], io([], []), p => p ?? "/nowhere/state.json", {
    env: {},
    dial: async (_statePath, opts) => {
      dialled.push(opts ?? {});
      throw new Error("no host here");
    },
  });
  expect(dialled[1]).not.toHaveProperty("anyRelease");
});

it("the tool server's restart tool dials past the release check, as the line's does, while its other tools are refused", async () => {
  const { statePath, asked } = await hostOf("0.0.1", "service");
  const server = mcpServer(statePath, { env: { WSP_HOME: join(dir!, "home") } });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "release", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const refused = (await client.callTool({ name: "computers", arguments: {} })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent?.error).toBe(`this line runs wsp ${VERSION} and the host serving ${statePath} runs wsp 0.0.1: restart that host with wsp restart.`);
    const restarted = (await client.callTool({ name: "restart", arguments: {} })) as { isError?: boolean; structuredContent?: unknown };
    expect(restarted.isError, JSON.stringify(restarted)).toBeUndefined();
    expect(restarted.structuredContent).toEqual({ running: [] });
    expect(asked).toContain("host.restart");
  } finally {
    await client.close();
    await server.close();
  }
});
