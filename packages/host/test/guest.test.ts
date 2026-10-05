// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of the guest road, against a real host on loopback: what a
// session is refused for, what the tool server serves, and what the command
// line streams back. The link is a fake standing for one machine's daemon, so
// what is driven here is the door and its two kinds and nothing of the wire
// under them, which the daemon's own suite drives.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, GUEST_SESSIONS_PER_WORKSPACE_CAP, GUEST_WORKSPACE_FULL, guestNoTokenRefusal, guestTurnNoTokenRefusal, guestHostFlagLine, guestNamesWorkspaceLine, guestNoFileLine, guestNoKindLine, guestNoLoopbackLine, guestNoSessionLine, guestPersonsComputerLine, LOOPBACK, UNAUTHORIZED, type DaemonEvent } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type GuestKindModule, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "../src/cli.js";
import { guestRefusal } from "../src/guest-cli.js";
import { guestKinds, guestTools } from "../src/guest-tools.js";
import { guestDoor, type GuestDoor, type GuestLink } from "../src/guest.js";
import { placeWiring } from "../src/places.js";
import type { HostHandle } from "../src/server.js";
import { hasTool, readsHere, toolName, VERBS } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { captured, PAGE } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

/** One frame the door sent down a link, as the daemon would have carried it. */
interface Sent {
  op: string;
  params: Record<string, unknown>;
}

describe("a guest session on the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let door: GuestDoor;
  let sent: Sent[];
  let link: GuestLink;
  let workspaceId: string;

  /** A thread's own token on the named workspace, minted by the same door every other road reads. */
  const tokenOn = async (on: string, rootThreadId = "t1"): Promise<string> =>
    (await rt.devices.mint("thread t1", { kind: "thread", threadId: "t1", workspaceId: on, rootThreadId }, Date.now())).deviceToken;

  const replies = (): unknown[] => sent.filter(s => s.op === "guest.reply").map(s => s.params["message"]);
  const closes = (): Sent[] => sent.filter(s => s.op === "guest.close");
  /** Everything the line printed on the out stream, as one screen. */
  const outText = (): string => replies().filter((m): m is { stream: string; text: string } => (m as { stream?: string }).stream === "out").map(m => m.text).join("");
  const errText = (): string => replies().filter((m): m is { stream: string; text: string } => (m as { stream?: string }).stream === "err").map(m => m.text).join("");
  const exitCode = (): number | undefined => replies().map(m => (m as { exit?: number }).exit).find(code => code !== undefined);

  const opened = (o: { token: string; turnToken?: string | null; kind?: "mcp" | "cli"; argv?: string[]; life?: string; session?: string }): DaemonEvent => ({
    type: "guest.opened",
    session: o.session ?? "g0",
    life: o.life ?? "life-1",
    kind: o.kind ?? "cli",
    token: o.token,
    ...(o.turnToken === null ? {} : { turnToken: o.turnToken ?? "turn-1" }),
    argv: o.argv ?? ["threads", "--json"],
    cwd: "/root",
  });

  /** One JSON-RPC call over the session, answered with the reply that carries its id. */
  async function call(_token: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = replies().length;
    door.event(link, { type: "guest.message", session: "g0", message });
    await settled(() => replies().length > before);
    return replies()[before] as Record<string, unknown>;
  }

  /** Waits until the session has answered, which every case here does within a turn or two of the loop. */
  async function settled(until: () => boolean): Promise<void> {
    for (let tries = 0; tries < 400 && !until(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(until(), `nothing came back: ${JSON.stringify(sent).slice(0, 400)}`).toBe(true);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-guest-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_guest_key");
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    rt = createRuntime({ backend, store, adapters: {}, placeLinks: placeWiring(statePath) });
    handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    await handle.addProject("https://github.com/dev/alpha.git", "default");
    workspaceId = (await handle.createWorkspace("alpha")).id;
    sent = [];
    link = {
      workspaceId,
      request: async (op, params) => {
        sent.push({ op, params });
        return {};
      },
    };
    const port = handle.port;
    door = guestDoor({
      authorize: token => rt.devices.match(token).then(device => (device === undefined ? undefined : { kind: "device", device })),
      hostUrl: () => `http://${LOOPBACK}:${port}`,
      kinds: guestKinds(statePath),
    });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("what a session is refused for", () => {
    it("closes a turn's line that carried no thread's token by saying the turn was launched without one, never by telling the person to turn the switch on, and dials nothing", async () => {
      // Every turn is launched with a thread's token, whatever the switch says, so one without it was launched by a
      // host that minted none, and the switch has nothing to do with it.
      door.event(link, opened({ token: "" }));
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: guestTurnNoTokenRefusal(workspaceId) });
      expect(guestTurnNoTokenRefusal(workspaceId)).not.toContain("--spawn");
      expect(replies()).toEqual([]);
    });

    it("closes a line that carried neither token by saying it came from no turn, never by telling the person to turn the switch on", async () => {
      // A `wsp exec` or a shell pane on the machine: turning the switch on changes nothing for it.
      door.event(link, opened({ token: "", turnToken: null }));
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: guestNoTokenRefusal(workspaceId) });
      expect(guestNoTokenRefusal(workspaceId)).not.toContain("--spawn on");
      expect(replies()).toEqual([]);
    });

    it("closes a token this host does not know, and one scoped to another workspace", async () => {
      door.event(link, opened({ token: "made-up" }));
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: UNAUTHORIZED });

      sent = [];
      const elsewhere = await tokenOn("wsp-somewhere-else");
      door.event(link, opened({ token: elsewhere }));
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: UNAUTHORIZED });
      expect(replies()).toEqual([]);
    });

    it("ends a session on a host that listens on no loopback address in so many words, and opens nothing", async () => {
      const token = await tokenOn(workspaceId);
      const lines: string[][] = [];
      const kind: GuestKindModule = { open: o => (lines.push([...o.argv]), { message: () => undefined, close: () => undefined }) };
      const bound = guestDoor({
        authorize: t => rt.devices.match(t).then(device => (device === undefined ? undefined : { kind: "device", device })),
        hostUrl: () => undefined,
        kinds: { mcp: kind, cli: kind },
      });
      bound.event(link, opened({ token }));
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: guestNoLoopbackLine });
      expect(lines).toEqual([]);
    });

    it("closes a kind this host serves no module for in its own words, not the token's", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, { ...(opened({ token }) as Record<string, unknown>), kind: "shell" } as unknown as DaemonEvent);
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: guestNoKindLine("shell") });
    });

    it("ends a session it no longer holds rather than dropping the frame, so the guest reads one line and stops", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, kind: "mcp", argv: ["mcp"] }));
      await settled(() => sent.length === 0 || closes().length > 0 || replies().length > 0 || true);
      // The workspace went: the machine's daemon may still hold the session, and the guest's next frame is the
      // only thing that can tell it nobody is on this end.
      door.closeAll(workspaceId);
      sent = [];
      door.event(link, { type: "guest.message", session: "g0", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      await settled(() => closes().length > 0);
      expect(closes()[0]!.params).toEqual({ session: "g0", error: guestNoSessionLine });
    });
  });

  describe("a path or a folder the line names", () => {
    it("refuses a file the line names before any path is resolved, and reads nothing of the person's", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["run", "alpha", "look", "--file", "/etc/hosts"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toContain(guestNoFileLine);
      expect(exitCode()).toBe(EXIT_CODES.usage);
    });

    it("keeps the files input off the tool server, so a session cannot name one at all", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, kind: "mcp", argv: ["mcp"] }));
      const hello = await call(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      expect(hello["result"]).toBeDefined();
      door.event(link, { type: "guest.message", session: "g0", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
      const called = await call(token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run", arguments: { project: "alpha", message: "look", files: ["/etc/hosts"] } } });
      expect(JSON.stringify(called)).toContain(guestNoFileLine);
    });

    it("refuses a line that leaves the workspace to the folder it was typed in, before that folder is walked", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["run", "look at this"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toContain(guestNamesWorkspaceLine);
      expect(exitCode()).toBe(EXIT_CODES.usage);
    });
  });

  describe("the tool server kind", () => {
    it("answers the handshake as this host's own server and lists exactly the verbs that are tools", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, kind: "mcp", argv: ["mcp"] }));
      const hello = await call(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      expect((hello["result"] as { serverInfo: { name: string } }).serverInfo.name).toBe("wsp");

      door.event(link, { type: "guest.message", session: "g0", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
      const listed = await call(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = (listed["result"] as { tools: { name: string }[] }).tools.map(t => t.name).sort();
      // Every verb that is a tool, less the ones whose work is on the computer the process runs on: here that is
      // the person's computer, and a fork's agent asking about "this computer" means the machine it is on.
      const served = VERBS.filter(hasTool).filter(v => readsHere(v) === undefined);
      expect(names).toEqual(served.map(v => toolName(v.name)).sort());
      expect(VERBS.filter(hasTool).filter(v => readsHere(v) !== undefined).map(v => v.name)).toEqual(["recipe scan", "recipe", "terminal config"]);
    });

    it("tells the server of a thread another thread started that it has no slate, and a lead's that it has one", async () => {
      const hello = async (token: string): Promise<string> => {
        sent = [];
        door.event(link, opened({ token, kind: "mcp", argv: ["mcp"], session: "g0" }));
        const answer = await call(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        door.event(link, { type: "guest.closed", session: "g0" });
        return (answer["result"] as { instructions?: string }).instructions ?? "";
      };
      expect(await hello(await tokenOn(workspaceId))).toContain("slate");
      expect(await hello(await tokenOn(workspaceId, "t0"))).not.toContain("slate");
    });

    it("puts the word on the line of this computer's binary for a thread another thread started, and only there", async () => {
      const seen = join(dir, "argv");
      const server = join(dir, "tool-server");
      writeFileSync(server, `#!/bin/sh\necho "$@" >> ${seen}\n`, { mode: 0o755 });
      const kind = guestTools(statePath, server);
      for (const noSlate of [false, true]) {
        kind.open({ argv: ["mcp"], cwd: "/root", env: {}, ...(noSlate ? { noSlate: true as const } : {}), reply: () => undefined, close: () => undefined });
      }
      await settled(() => existsSync(seen) && readFileSync(seen, "utf8").split("\n").length > 2);
      expect(readFileSync(seen, "utf8").trim().split("\n").sort()).toEqual([`mcp --state ${statePath} --scoped --guest`, `mcp --state ${statePath} --scoped --guest --no-slate`]);
    });

    it("drives this host with the thread's own token: a tool call answers off the host the session named", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, kind: "mcp", argv: ["mcp"] }));
      await call(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      door.event(link, { type: "guest.message", session: "g0", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
      const called = await call(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "threads", arguments: {} } });
      const structured = (called["result"] as { structuredContent?: { threads?: unknown[] } }).structuredContent;
      expect(structured?.threads).toEqual([]);
    });
  });

  describe("the command line kind", () => {
    it("streams the host's own rows on the out stream and ends with its code", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["threads", "--json"] }));
      await settled(() => exitCode() !== undefined);
      expect(exitCode()).toBe(0);
      const rows = JSON.parse(outText().trim()) as { threads: unknown[] };
      expect(rows.threads).toEqual([]);
      expect(closes()).toHaveLength(1);
    });

    it("refuses a line that runs at the person's own keyboard, in one sentence and before anything dials", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["up"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toBe(`${guestPersonsComputerLine("up")}\n`);
      expect(exitCode()).toBe(1);
      expect(outText()).toBe("");
    });

    it("refuses a line that would aim itself somewhere else, however the flag was written", async () => {
      const token = await tokenOn(workspaceId);
      for (const argv of [["threads", "--host", "box"], ["threads", "--state", "/x"], ["threads", "--host=box"]]) {
        sent = [];
        door.event(link, opened({ token, argv }));
        await settled(() => exitCode() !== undefined);
        expect(errText(), argv.join(" ")).toBe(`${guestHostFlagLine}\n`);
        expect(exitCode()).toBe(1);
      }
    });

    it("finds the verb where the command line finds it, so a shared flag in front of it opens no door", async () => {
      // The line the confirm review ran: --json is lifted off before the verb is looked for, and a wall that read
      // the first word as typed saw a dash and let the rest through, which printed the person's own Ghostty config.
      expect(guestRefusal(["--json", "terminal", "config"])).toBe(guestPersonsComputerLine("terminal config"));
      expect(guestRefusal(["--json", "recipe", "scan"])).toBe(guestPersonsComputerLine("recipe scan"));
      expect(guestRefusal(["--json", "init", "--yes"])).toBe(guestPersonsComputerLine("init"));
      expect(guestRefusal(["--json", "up"])).toBe(guestPersonsComputerLine("up"));
      // A shared flag in front of a verb this road does serve is still that verb.
      expect(guestRefusal(["--json", "threads"])).toBeUndefined();
      // And a line carrying the help flag prints a page and runs nothing, whatever word follows it.
      expect(guestRefusal(["--json", "init", "--help"])).toBeUndefined();
      expect(guestRefusal(["-h", "recipe"])).toBeUndefined();

      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["--json", "recipe", "scan"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toContain(guestPersonsComputerLine("recipe scan"));
      expect(exitCode()).toBe(1);
      expect(outText()).toBe("");
    });

    it("refuses a line that would start a build on the person's computer, however the flags are ordered", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["--json", "init", "--yes"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toContain(guestPersonsComputerLine("init"));
      expect(exitCode()).toBe(1);
      expect(outText()).toBe("");
    });

    it("lets a line ask what this command line is, and refuses a verb that is no tool even so", () => {
      expect(guestRefusal(["--help"])).toBeUndefined();
      expect(guestRefusal(["help", "run"])).toBeUndefined();
      expect(guestRefusal(["run", "--help"])).toBeUndefined();
      expect(guestRefusal(["threads", "--json"])).toBeUndefined();
      expect(guestRefusal(["thread", "read", "t1"])).toBeUndefined();
      // A line carrying the help flag prints a page and runs nothing, whichever word it names, so it passes; the
      // same word without it is the line that would run on the person's computer.
      expect(guestRefusal(["init", "--help"])).toBeUndefined();
      expect(guestRefusal(["init"])).toBe(guestPersonsComputerLine("init"));
      expect(guestRefusal(["--help", "agent"])).toBeUndefined();
      // A verb that reads the computer the process runs on: from inside a machine that is the person's computer.
      expect(guestRefusal(["recipe", "--tick", "used"])).toBe(guestPersonsComputerLine("recipe"));
      expect(guestRefusal(["recipe", "scan"])).toBe(guestPersonsComputerLine("recipe scan"));
      expect(guestRefusal(["terminal", "config"])).toBe(guestPersonsComputerLine("terminal config"));
      expect(guestRefusal(["not-a-verb"])).toBe(guestPersonsComputerLine("not-a-verb"));
      // From `--` on the words belong to the command the line runs in the workspace, where --host is not ours.
      expect(guestRefusal(["exec", "ws", "--", "curl", "--host", "x"])).toBeUndefined();
      expect(guestRefusal(["exec", "--host", "box", "--", "true"])).toBe(guestHostFlagLine);
    });

    it("prints a verb's own page where the line asked for it", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["run", "--help"] }));
      await settled(() => exitCode() !== undefined);
      expect(exitCode()).toBe(0);
      expect(outText()).toContain("usage: wsp run");
    });

    it("refuses a list that redraws where it stands, since nothing inside a machine has a terminal to redraw on", async () => {
      const token = await tokenOn(workspaceId);
      door.event(link, opened({ token, argv: ["threads", "--watch"] }));
      await settled(() => exitCode() !== undefined);
      expect(errText()).toContain("no terminal to redraw on");
      expect(exitCode()).toBe(EXIT_CODES.usage);
    });
  });

  /** A door of its own over a kind that counts what it opens and what it closes, which is what every case about
   * a session named twice reads its answer off. */
  const countingDoor = (lines: string[][], closed: number[]): GuestDoor => {
    const kind: GuestKindModule = {
      open: o => {
        const at = lines.push([...o.argv]) - 1;
        return { message: () => undefined, close: () => closed.push(at) };
      },
    };
    return guestDoor({
      authorize: t => rt.devices.match(t).then(device => (device === undefined ? undefined : { kind: "device", device })),
      hostUrl: () => `http://${LOOPBACK}:1`,
      kinds: { mcp: kind, cli: kind },
    });
  };

  it("runs a session named again by the run that opened it once, however alike a later one would read", async () => {
    const token = await tokenOn(workspaceId);
    const lines: string[][] = [];
    const closed: number[] = [];
    const counting = countingDoor(lines, closed);
    counting.event(link, opened({ token, argv: ["new", "beta"] }));
    await settled(() => lines.length === 1);

    // The link dropped and the machine named the session it still holds to the socket that watches now. The same
    // run said it, so it is that session: running the line again here is a second wsp new.
    counting.event(link, opened({ token, argv: ["new", "beta"] }));
    counting.event(link, opened({ token, argv: ["new", "beta"] }));

    // A name this run has not used yet, sent after those two and opened through the same token read: by the time
    // its line is here, a line either of them had opened would be here too, so two lines is the whole answer.
    counting.event(link, opened({ token, argv: ["threads"], session: "g1" }));
    await settled(() => lines.length === 2);
    expect(lines).toEqual([["new", "beta"], ["threads"]]);
    expect(closed).toEqual([]);
  });

  it("ends a held session and runs the new one when another run of the machine's daemon names that name", async () => {
    const token = await tokenOn(workspaceId);
    const lines: string[][] = [];
    const closed: number[] = [];
    const counting = countingDoor(lines, closed);
    counting.event(link, opened({ token, argv: ["new", "beta"] }));
    await settled(() => lines.length === 1);

    // The machine was rebuilt under this host and its daemon counts session names from the start again. The line
    // reads exactly like the one still held here, so nothing but the run it names tells the two apart: a person's
    // shell running the same line from the same folder carries no turn token to differ by.
    counting.event(link, opened({ token, argv: ["new", "beta"], life: "life-2" }));
    await settled(() => lines.length === 2);
    expect(lines).toEqual([["new", "beta"], ["new", "beta"]]);
    expect(closed).toEqual([0]);
  });

  it("ends every session of the run before it, not only the one whose name the new run took", async () => {
    const token = await tokenOn(workspaceId);
    const lines: string[][] = [];
    const closed: number[] = [];
    const counting = countingDoor(lines, closed);
    counting.event(link, opened({ token, argv: ["threads"] }));
    counting.event(link, opened({ token, argv: ["workspaces"], session: "g1" }));
    await settled(() => lines.length === 2);

    // g0 under a new run says the machine those two ran on is gone; g1 is never named again, and a row left
    // standing for it holds its session open for the life of this host.
    counting.event(link, opened({ token, argv: ["threads"], life: "life-2" }));
    await settled(() => lines.length === 3);
    expect(closed).toEqual([0, 1]);
  });

  it("holds as many sessions of one workspace as its machine's daemon may, and ends the one past that in the daemon's words", async () => {
    // Each session here can be a process on the person's computer, and a machine whose agent is root can bypass its
    // own daemon's count: this door keeps the same count on this side.
    const token = await tokenOn(workspaceId);
    const lines: string[][] = [];
    const closed: number[] = [];
    const counting = countingDoor(lines, closed);
    for (let at = 0; at < GUEST_SESSIONS_PER_WORKSPACE_CAP; at++) counting.event(link, opened({ token, argv: ["threads"], session: `g${at}` }));
    await settled(() => lines.length === GUEST_SESSIONS_PER_WORKSPACE_CAP);
    counting.event(link, opened({ token, argv: ["threads"], session: "g-over" }));
    await settled(() => closes().some(c => c.params["session"] === "g-over"));
    expect(closes().find(c => c.params["session"] === "g-over")?.params["error"]).toBe(GUEST_WORKSPACE_FULL);
    expect(lines).toHaveLength(GUEST_SESSIONS_PER_WORKSPACE_CAP);
    // A session that ends makes room for the next.
    counting.event(link, { type: "guest.closed", session: "g0" });
    counting.event(link, opened({ token, argv: ["threads"], session: "g-after" }));
    await settled(() => lines.length === GUEST_SESSIONS_PER_WORKSPACE_CAP + 1);
  });

  it("drops every session of a workspace that is gone, and ends the next frame that arrives for one", async () => {
    const token = await tokenOn(workspaceId);
    door.event(link, opened({ token, kind: "mcp", argv: ["mcp"] }));
    await call(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    door.closeAll(workspaceId);
    sent = [];
    door.event(link, { type: "guest.message", session: "g0", message: { jsonrpc: "2.0", id: 9, method: "tools/list" } });
    await settled(() => closes().length > 0);
    expect(closes()[0]!.params).toEqual({ session: "g0", error: guestNoSessionLine });
    expect(replies()).toEqual([]);
  });
});
