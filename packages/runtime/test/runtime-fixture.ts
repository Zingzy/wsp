// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterEvent, TurnResult } from "@wsp/protocol";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { harnessCatalog } from "../src/harness-catalog.js";
import type { HarnessAdapterFactory, HarnessStartOptions } from "../src/runtime.js";
import { WebSocketServer } from "ws";

/** What a catalog served from the table carries as its version: that harness's own pin, never another's. */
export const CLAUDE_PIN = harnessCatalog("claude")!.version;

/** The recipes here set up with "true", which the harness stage runs under its guard like every installer. */
export const setupRan = (cmd: string): boolean => cmd.includes("\ntrue' &");

export const TOKEN_PATH = DAEMON_TOKEN_PATH;
export const TOKEN = "deadbeef".repeat(3);

/** A daemon on a loopback port that answers every op ok and announces the version it is set to right after the auth
 * reply, as the real one does: the one way a client learns a daemon's version, and the only way to stand an old one
 * up here, since the daemon in this checkout only ever announces the current version. */
export async function helloingDaemon(version: number, holdHello = false): Promise<{ port: number; announce: (v: number) => void; release: () => void; hits: () => number; dials: () => number; close: () => Promise<void> }> {
  let announced = version;
  let held = holdHello;
  let hits = 0;
  let dials = 0;
  const waiting: (() => void)[] = [];
  // A plain GET is the reach probe, answered as the daemon's own ws server answers it.
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(426).end();
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  wss.on("connection", socket => {
    dials++;
    const hello = (): void => socket.send(JSON.stringify({ type: "daemon.hello", root: "/root", version: announced }));
    socket.on("message", raw => {
      const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
      socket.send(JSON.stringify({ id, ok: true }));
      if (op !== "auth") return;
      if (held) waiting.push(hello);
      else hello();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    announce: v => (announced = v),
    release: () => {
      held = false;
      for (const say of waiting.splice(0)) say();
    },
    hits: () => hits,
    dials: () => dials,
    close: () =>
      new Promise<void>(done => {
        for (const socket of wss.clients) socket.terminate();
        server.closeAllConnections();
        wss.close(() => server.close(() => done()));
      }),
  };
}

/** The version a daemon on this port announces, read the way any client reads it: dial, auth, listen. */
export async function helloOf(port: number): Promise<number> {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    return await new Promise<number>((done, fail) => {
      socket.on("open", () => socket.send(JSON.stringify({ id: 1, op: "auth", token: TOKEN })));
      socket.on("message", raw => {
        const m = JSON.parse(String(raw)) as { type?: string; version?: number };
        if (m.type === "daemon.hello") done(m.version ?? 1);
      });
      socket.on("error", fail);
    });
  } finally {
    socket.close();
  }
}

/** A real daemon on a loopback port for the runtime to ping, holding the first machine's own token, torn down with
 * its inbox and its fake machine. */
export async function withDaemon<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const { fakeProcTree } = await import("../../daemon/test/fake-proc.js");
  const { daemonUnderTest } = await import("../../daemon/test/harness.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const inboxDir = mkdtempSync(join(tmpdir(), "wsp-wake-inbox-"));
  const procRoot = fakeProcTree([]);
  const { machineDaemonToken } = await import("../../daemon/test/harness.js");
  const daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: machineDaemonToken(TOKEN, "m1"), inbox: inboxDir, inboxQuietMs: 100, inboxPollMs: 25, procRoot, portsIntervalMs: 25 });
  try {
    return await fn(daemon.port);
  } finally {
    await daemon.close();
    rmSync(inboxDir, { recursive: true, force: true });
    rmSync(procRoot, { recursive: true, force: true });
  }
}

/** A harness whose every turn runs until the test ends it; a resumed start keeps the session id, as the real one
 * does, and steers when told to. `end` completes a turn with the text, and whatever else of the result is given.
 * `envs` is the launch environment of each turn, in the order they were launched. */
export const held = (steers: boolean) => {
  const starts: HarnessStartOptions[] = [];
  const envs: Readonly<Record<string, string>>[] = [];
  const steered: string[] = [];
  const turns: { sessionId: string; onEvent: (e: AdapterEvent) => void; finish: (r: TurnResult) => void }[] = [];
  const adapter: HarnessAdapterFactory = ctx => ({
    steers,
    start: o => {
      starts.push(o);
      envs.push({ ...ctx.env });
      const sessionId = o.resume ?? randomUUID();
      let finish!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (finish = r));
      turns.push({ sessionId, onEvent: o.onEvent, finish });
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {},
        ...(steers
          ? {
              steer: async (prompt: string) => {
                steered.push(prompt);
                return "accepted" as const;
              },
            }
          : {}),
      };
    },
  });
  const results: TurnResult[] = [];
  /** The harness's result lands while its process keeps running. */
  const reply = (turn: number, text: string, more: Partial<TurnResult> = {}): void => {
    const t = turns[turn]!;
    results[turn] = { status: "completed", text, ...more };
    t.onEvent({ type: "turn.done", sessionId: t.sessionId, result: results[turn]! });
  };
  /** The process exits, after its reply. */
  const exit = (turn: number): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "session.end", sessionId: t.sessionId, exitCode: 0, sawResult: true });
    t.finish(results[turn]!);
  };
  const end = (turn: number, text: string, more: Partial<TurnResult> = {}): void => {
    reply(turn, text, more);
    exit(turn);
  };
  return { adapter, starts, envs, steered, reply, exit, end };
};
export const settle = () => new Promise<void>(r => setTimeout(r, 20));
