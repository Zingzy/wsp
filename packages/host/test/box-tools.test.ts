// SPDX-License-Identifier: AGPL-3.0-only
// The wsp tools of a thread running on a computer the person joined: the wsp on
// its PATH opens a session on that computer's own daemon, which holds it until
// this host watches and carries it up the one link the computer holds, and this
// host serves it off that link for as long as the link is up, whichever thread
// opened it. The computer is a fake on the link that holds sessions the way its
// daemon does; the tool server is a kind that records what reached it.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_VERSION, HOST_TOKEN_ENV, MCP_SERVER_NAME, UNAUTHORIZED, guestNoTokenRefusal, placeDaemonBehind, placeNoToolsLine, type Caller, type PlaceReport, type ThreadScope, type TurnResult } from "@wsp/protocol";
import type { GuestKindModule, GuestOpening, HarnessAdapterFactory, HarnessStartOptions, Runtime } from "@wsp/runtime";
import { ctx, sockets, serving, code, join, KEEPS_NO_IMAGE } from "../../runtime/test/places-fixture.js";
import { report } from "../../runtime/test/place-join.js";
import type { WsClient } from "../../runtime/test/ws-client.js";
import { guestDoor } from "../src/guest.js";
import { startCallbackRelay, type CallbackRelay } from "../src/relay.js";

/** A joined computer as its daemon answers the host: the login read and the folder an add claims, every other command
 * with nothing, and the guest sessions its threads open held until the link asks to watch them, each named again to
 * every watch after, as a host that restarted holds none of them. */
function box(client: WsClient) {
  const seen = { ops: [] as string[], downward: [] as Record<string, unknown>[] };
  let watched = false;
  const sessions: Record<string, unknown>[] = [];
  const held: Record<string, unknown>[] = [];
  client.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const say = (payload: Record<string, unknown>): void => client.say({ id: frame["id"], ok: true, ...payload });
    seen.ops.push(op);
    if (op === "machine.backend") return say(KEEPS_NO_IMAGE);
    if (op === "machine.capacity") return say({ cores: 4, memMb: 8192, memRoomMb: 4096, machineMemMb: 4096, diskFreeBytes: 10 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } });
    if (op === "ports.watch") return say({ ports: [] });
    if (op === "guest.watch") {
      watched = true;
      for (const e of [...sessions, ...held.splice(0)]) client.say(e);
      return say({});
    }
    if (op === "guest.reply" || op === "guest.close") {
      seen.downward.push({ op, ...frame });
      return say({});
    }
    if (op !== "exec") return say({});
    const cmd = String(frame["cmd"]);
    const out = (stdout: string): void => say({ exitCode: 0, stdout, stderr: "", truncated: false });
    if (cmd.includes("command -v runuser")) return out("Linux\n0\nroot\nroot\n1\n/root\n/usr/bin\n");
    const claim = /mkdir '([^']+)'"\$n"/.exec(cmd);
    if (claim !== null) return out(`${claim[1]!}\n`);
    return out("");
  });
  /** A frame a thread's wsp sent, as the daemon relays it: held while nobody watches, pushed once somebody does. */
  const guest = (e: Record<string, unknown>): void => {
    if (e["type"] === "guest.opened") sessions.push(e);
    else if (!watched) held.push(e);
    if (watched) client.say(e);
  };
  return { seen, guest };
}

/** One turn as the harness was started on it, running until the case lets it answer: a thread's token stands while
 * its turn runs, which is when its wsp opens a session. */
interface Started {
  o: HarnessStartOptions;
  env: Readonly<Record<string, string>>;
  answer(): void;
}

/** A harness that takes the wsp tools and records what each turn was started with. */
function running(starts: Started[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    mcpServers: true as const,
    start: o => {
      const sessionId = randomUUID();
      const result: TurnResult = { status: "completed", text: "ok" };
      let answer = (): void => {};
      const finished = new Promise<TurnResult>(resolve => {
        answer = () => {
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      starts.push({ o, env: hctx.env, answer });
      o.onEvent({ type: "session.start", sessionId });
      return { localId: sessionId, finished, interrupt: async () => answer() };
    },
  });
}

/** The tool server's door, standing for it: every session it was asked to open and every message that reached one. */
function toolServer() {
  const opened: GuestOpening[] = [];
  const messages: unknown[] = [];
  const kind: GuestKindModule = {
    open: opening => {
      opened.push(opening);
      return { message: m => void messages.push(m), close: () => {} };
    },
  };
  return { opened, messages, kinds: { mcp: kind, cli: kind } };
}

const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

let relay: CallbackRelay | undefined;
const turns: Started[] = [];
/** What each turn's start answered, and the computer it ran on, so every turn has ended and its checkpoint reached
 * the computer before the computer's socket goes. */
const ending: Promise<unknown>[] = [];
let on: ReturnType<typeof box> | undefined;
afterEach(async () => {
  const checkpoints = (): number => on?.seen.ops.filter(op => op === "git.checkpoint").length ?? 0;
  const before = checkpoints();
  const ended = turns.splice(0);
  for (const turn of ended) turn.answer();
  await Promise.all(ending.splice(0));
  await expect.poll(checkpoints).toBeGreaterThanOrEqual(before + ended.length);
  on = undefined;
  await relay?.close();
  relay = undefined;
});

/** What that computer's daemon says of itself: this host's own version, with the door for its threads standing. */
const DOOR_STANDS: Partial<PlaceReport> = { daemonVersion: DAEMON_VERSION, wspDoor: true };

async function joined(said: Partial<PlaceReport> = DOOR_STANDS) {
  const starts = turns;
  const { hostKey } = await serving({ adapters: { claude: running(starts) } });
  let fake!: ReturnType<typeof box>;
  const { client, placeId } = await join(hostKey, {
    code: await code(),
    report: report("hetzner", { login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, ...said }),
    answers: c => void (on = fake = box(c)),
  });
  sockets.push(client.ws);
  const rt = ctx.runtime!;
  const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "hetzner", name: "spoo-ts" });
  const server = toolServer();
  /** This host's relay and guest door, made afresh as a host that started again makes them, holding no session. */
  const relayUp = async (): Promise<void> => {
    await relay?.close();
    const door = guestDoor({
      authorize: token => rt.devices.match(token).then(device => (device === undefined ? undefined : { kind: "device" as const, device })),
      hostUrl: () => "http://127.0.0.1:1",
      kinds: server.kinds,
    });
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, places: true, listenHosts: ["127.0.0.1"], guest: door });
  };
  return { rt, placeId, project, starts, box: fake, server, relayUp };
}

/** One session the wsp of a thread opened on that computer, as its daemon names it: no workspace, since the door it
 * came in through is the computer's own. */
function opens(token: string, session: string): Record<string, unknown> {
  return { type: "guest.opened", session, life: "life-1", kind: "mcp", token, argv: ["mcp"], cwd: "/root/spoo-ts" };
}

/** A thread started on the project there by the person, its turn running. */
async function leadOn(rt: Runtime, projectId: string, starts: Started[]) {
  const home = await rt.workspaces.folderFor({ project: projectId });
  const lead = await rt.sessions.start(home.workspace.id, { prompt: "lead", harness: "claude" });
  ending.push(lead.finished);
  await expect.poll(() => lead.view().threadId).toBeDefined();
  return { workspaceId: home.workspace.id, threadId: lead.view().threadId!, token: starts.at(-1)!.env[HOST_TOKEN_ENV]! };
}

describe("the wsp tools of a thread on a computer the person joined", () => {
  it("launch from the wsp that computer's daemon writes, and a session sent before anything here listened for that thread is served off the computer's own link", async () => {
    const { rt, project, starts, box, server, relayUp } = await joined();
    const lead = await leadOn(rt, project.id, starts);
    const launched = starts.at(-1)!;
    expect(launched.o.mcpServers?.[MCP_SERVER_NAME]).toMatchObject({ command: "wsp", args: ["mcp"] });
    expect(lead.token).toMatch(/\S/);

    // The thread's wsp opens its session and sends its first frame before this host holds any link of that thread's,
    // or of anything else on that computer: the daemon holds both.
    box.guest(opens(lead.token, "g1"));
    box.guest({ type: "guest.message", session: "g1", message: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    await relayUp();
    await expect.poll(() => server.opened.length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => server.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
    expect(server.opened[0]!.env[HOST_TOKEN_ENV]).toBe(lead.token);
    expect(server.opened[0]!.cwd).toBe("/root/spoo-ts");
    expect(box.seen.ops).toContain("guest.watch");

    // A second thread's session is served the moment it is opened: the one listener stands for the whole computer.
    const second = await leadOn(rt, project.id, starts);
    box.guest(opens(second.token, "g2"));
    await expect.poll(() => server.opened.length).toBe(2);
    expect(box.seen.downward.filter(d => d["op"] === "guest.close")).toEqual([]);
  });

  it("serves the first session of a sub-thread started beside a thread there with no project, in the same folder", async () => {
    const { rt, project, starts, box, server, relayUp } = await joined();
    await relayUp();
    const lead = await leadOn(rt, project.id, starts);
    const scope: ThreadScope = { kind: "thread", threadId: lead.threadId, workspaceId: lead.workspaceId, rootThreadId: lead.threadId };
    const beside = await rt.workspaces.folderFor({}, asThread(scope));
    expect(beside.workspace.id).toBe(lead.workspaceId);
    ending.push((await rt.sessions.start(beside.workspace.id, { prompt: "child", harness: "claude" }, asThread(scope))).finished);
    await expect.poll(() => starts.length).toBe(2);
    const child = starts.at(-1)!;
    expect(child.o.cwd).toBe("/root/spoo-ts");
    expect(child.o.mcpServers?.[MCP_SERVER_NAME]).toMatchObject({ command: "wsp", args: ["mcp"], noSlate: true });
    const token = child.env[HOST_TOKEN_ENV]!;
    expect(token).not.toBe(lead.token);

    box.guest(opens(token, "g7"));
    await expect.poll(() => server.opened.length, { timeout: 5000 }).toBe(1);
    expect(server.opened[0]!.env[HOST_TOKEN_ENV]).toBe(token);
    expect(server.opened[0]!.noSlate).toBe(true);
  });

  it("serves a session again from the host that started after it, and the first session of a thread started after that", async () => {
    const { rt, project, starts, box, server, relayUp } = await joined();
    await relayUp();
    const lead = await leadOn(rt, project.id, starts);
    box.guest(opens(lead.token, "g1"));
    await expect.poll(() => server.opened.length, { timeout: 5000 }).toBe(1);
    // The app goes and comes back: a new relay and a new door, and the computer names the session it still holds.
    await relayUp();
    await expect.poll(() => server.opened.length, { timeout: 5000 }).toBe(2);
    expect(server.opened[1]!.env[HOST_TOKEN_ENV]).toBe(lead.token);
    const next = await leadOn(rt, project.id, starts);
    box.guest(opens(next.token, "g2"));
    await expect.poll(() => server.opened.length).toBe(3);
    expect(server.opened[2]!.env[HOST_TOKEN_ENV]).toBe(next.token);
    expect(box.seen.downward.filter(d => d["op"] === "guest.close")).toEqual([]);
  });

  it("launch with no wsp tools on a computer whose daemon is older than the door, which reads behind", async () => {
    const { rt, placeId, project, starts } = await joined({ daemonVersion: DAEMON_VERSION - 1 });
    await leadOn(rt, project.id, starts);
    expect(starts.at(-1)!.o.mcpServers?.[MCP_SERVER_NAME]).toBeUndefined();
    const row = (await rt.places!.list(Date.now())).find(p => p.id === placeId)!;
    expect(row.behind?.word).toBe(placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 1 }));
    expect(row.toolsBlocked).toBeUndefined();
  });

  it("launch with no wsp tools where that computer's daemon could not open the door, and its row says why", async () => {
    const why = "/root/.wsp/daemon.sock: Address already in use (os error 98)";
    const unit = "wsp-place-ecffdb75.service";
    const { rt, placeId, project, starts } = await joined({ ...DOOR_STANDS, wspDoor: false, wspDoorBlocked: why, daemonUnit: unit });
    await leadOn(rt, project.id, starts);
    expect(starts.at(-1)!.o.mcpServers?.[MCP_SERVER_NAME]).toBeUndefined();
    const row = (await rt.places!.list(Date.now())).find(p => p.id === placeId)!;
    expect(row.toolsBlocked).toBe(placeNoToolsLine("hetzner", { wspDoor: false, wspDoorBlocked: why, daemonUnit: unit }));
    // The restart is of the unit that daemon runs under, the one the join wrote, not a fork's unit no box has.
    expect(row.toolsBlocked).toBe(`threads on hetzner get no wsp tools: ${why}; restart wsp's daemon there with systemctl restart ${unit}`);
    expect(row.behind).toBeUndefined();
  });

  it("say to add that computer again where its daemon runs in no unit the join writes, and name no restart", async () => {
    const why = "/root/.wsp/daemon.sock: Address already in use (os error 98)";
    const { rt, placeId } = await joined({ ...DOOR_STANDS, wspDoor: false, wspDoorBlocked: why });
    const row = (await rt.places!.list(Date.now())).find(p => p.id === placeId)!;
    expect(row.toolsBlocked).toBe(`threads on hetzner get no wsp tools: ${why}; remove hetzner and add it again`);
  });

  it("refuses a line typed there outside any turn, naming that computer by its own name", async () => {
    const { box, server, relayUp } = await joined();
    await relayUp();
    box.guest(opens("", "g4"));
    await expect.poll(() => box.seen.downward.find(d => d["op"] === "guest.close"), { timeout: 5000 }).toMatchObject({ session: "g4", error: guestNoTokenRefusal("hetzner") });
    expect(server.opened).toEqual([]);
  });

  it("ends a session whose token names no thread on that computer, in the host's own word", async () => {
    const { rt, box, server, relayUp } = await joined();
    await relayUp();
    const token = (await rt.devices.mint("thread t9", { kind: "thread", threadId: "t9", workspaceId: "ws_elsewhere", rootThreadId: "t9" }, Date.now())).deviceToken;
    box.guest(opens(token, "g3"));
    await expect.poll(() => box.seen.downward.find(d => d["op"] === "guest.close"), { timeout: 5000 }).toMatchObject({ session: "g3", error: UNAUTHORIZED });
    expect(server.opened).toEqual([]);
  });
});
