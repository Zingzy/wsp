// SPDX-License-Identifier: AGPL-3.0-only
// A computer the person joined, as its daemon answers the host over the link:
// the login read, the login shell's PATH, the folder an add claims, a turn's
// launch, its polls and its signals, a pane's ptys, and every frame kept; and a
// lead thread on the computer the app runs on, beside one such computer.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { HERE_PLACE_ID, type Caller, type ThreadScope, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory, HarnessStartOptions } from "../src/runtime.js";
import type { Store } from "../src/store.js";
import type { ServersActs } from "../src/agents-read.js";
import { MCP_READ_END } from "@wsp/engine";
import { ctx, sockets, serving, code, join, KEEPS_NO_IMAGE } from "./places-fixture.js";
import { fakeLocal } from "./stub-backend.js";
import { report } from "./place-join.js";
import type { WsClient } from "./ws-client.js";

/** One frame's command and what rode its input, as the computer was sent it. */
export interface Exec {
  cmd: string;
  stdin: string;
}

export interface Box {
  ops: string[];
  execs: Exec[];
  /** Every frame that is no command, as it reached the computer. */
  frames: Record<string, unknown>[];
  /** Folders already standing in the home, which an add's claim finds taken. */
  taken: Set<string>;
  /** The process group signals sent, in order. */
  kills: string[];
  /** An event the computer's daemon pushes up the link. */
  push(event: Record<string, unknown>): void;
  /** The files the agents' configs read finds there, by path. */
  configs: Map<string, string>;
  /** How the configs read answers, given what it printed: as printed and exiting 0 unless a test says otherwise. */
  readAs?: (stdout: string) => { stdout: string; exitCode: number; stderr?: string };
}

export interface BoxLogin {
  home: string;
  owner: string;
  /** What the login's own login shell prints for its PATH; nothing prints none. */
  shellPath?: string;
}

/** A line handed to the owner of the home rides inside one quoted argument; read it back out. */
export const handedLine = (cmd: string): string => {
  const handed = /^runuser -u '[^']+' -- bash -c '(.*)'$/s.exec(cmd);
  return handed === null ? cmd : handed[1]!.replaceAll("'\\''", "'");
};

export function box(client: WsClient, login: BoxLogin, o: { failClone?: boolean } = {}): Box {
  let ptys = 0;
  const seen: Box = { ops: [], execs: [], frames: [], taken: new Set(), kills: [], push: event => client.say(event), configs: new Map() };
  let stopped = false;
  client.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const say = (payload: Record<string, unknown>): void => client.say({ id: frame["id"], ok: true, ...payload });
    seen.ops.push(op);
    if (op === "machine.backend") return say(KEEPS_NO_IMAGE);
    if (op === "machine.capacity") return say({ cores: 4, memMb: 8192, memRoomMb: 4096, machineMemMb: 4096, diskFreeBytes: 10 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } });
    if (op !== "exec") {
      seen.frames.push(frame);
      if (op === "pty.create") return say({ ptyId: `p${++ptys}` });
      if (op === "git.status") return say({ branch: "main" });
      return say({});
    }
    const cmd = String(frame["cmd"]);
    const stdin = frame["stdin"] === undefined ? "" : Buffer.from(String(frame["stdin"]), "base64").toString("utf8");
    seen.execs.push({ cmd, stdin });
    const out = (stdout: string, exitCode = 0): void => say({ exitCode, stdout, stderr: exitCode === 0 ? "" : "fatal: repository not found", truncated: false });
    if (cmd.includes("command -v runuser")) return out(`Linux\n0\nroot\n${login.owner}\n1\n${login.home}\n/usr/bin\n`);
    const line = handedLine(cmd);
    if (line.includes("-ilc")) return login.shellPath === undefined ? out("", 1) : out(`welcome back\n${login.shellPath}`);
    const claim = /mkdir '([^']+)'"\$n"/.exec(line);
    if (claim !== null) {
      const at = [claim[1]!, `${claim[1]!}-2`, `${claim[1]!}-3`].find(path => !seen.taken.has(path))!;
      seen.taken.add(at);
      return out(`${at}\n`);
    }
    if (o.failClone === true && line.includes("git clone")) return out("", 128);
    if (line.includes("wsp_mcp_read()")) {
      const said = [...line.matchAll(/^wsp_mcp_read (\d+) '([^']+)'$/gm)].map(([, i, path]) => {
        const text = seen.configs.get(path!);
        return text === undefined ? `wsp-mcp ${i} - -` : `wsp-mcp ${i} 0 ${Buffer.from(text).toString("base64")}`;
      });
      const printed = `${[...said, MCP_READ_END].join("\n")}\n`;
      const read = seen.readAs?.(printed) ?? { stdout: printed, exitCode: 0 };
      return say({ exitCode: read.exitCode, stdout: read.stdout, stderr: read.stderr ?? "", truncated: false });
    }
    if (cmd.includes("WSP_LAUNCHED")) return out("WSP_LAUNCHED\n");
    const sentinel = /(__WSP_EOF_[0-9a-f]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) return out(stopped ? `\n${sentinel} 143 down \n` : `\n${sentinel}  up \n`);
    if (cmd.includes("kill -TERM -- -$P") || cmd.includes("kill -KILL -- -$P")) {
      seen.kills.push(cmd);
      stopped = true;
    }
    return out("");
  });
  return seen;
}

export type Started = { o: HarnessStartOptions; env: Readonly<Record<string, string>> };

/** A harness that records what each turn was started with and answers at once. */
export function answering(starts: Started[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    start: o => {
      starts.push({ o, env: hctx.env });
      const sessionId = randomUUID();
      const result: TurnResult = { status: "completed", text: "ok" };
      o.onEvent({ type: "session.start", sessionId });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
    },
  });
}

export const HETZNER: BoxLogin = { home: "/root", owner: "root" };

/** A host holding one joined computer, hetzner, its login root unless named, and a project added there by url. */
export async function joined(o: { login?: BoxLogin; adapters?: Record<string, HarnessAdapterFactory>; taken?: string[]; store?: Store; vault?: Record<string, string>; failClone?: boolean; serversActs?: ServersActs } = {}) {
  const login = o.login ?? HETZNER;
  const { hostKey } = await serving({ adapters: o.adapters ?? {}, ...(o.store !== undefined ? { store: o.store } : {}), ...(o.vault !== undefined ? { vault: o.vault } : {}), ...(o.serversActs !== undefined ? { serversActs: o.serversActs } : {}) });
  let seen!: Box;
  const { client, placeId, pair } = await join(hostKey, {
    code: await code(),
    report: report("hetzner", { login: { HOME: login.home, USER: "root", PATH: "/usr/bin" } }),
    answers: c => {
      seen = box(c, login, o.failClone === true ? { failClone: true } : {});
      for (const path of o.taken ?? []) seen.taken.add(path);
    },
  });
  sockets.push(client.ws);
  const rt = ctx.runtime!;
  const project = o.failClone === true ? undefined : await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "hetzner", name: "spoo-ts" });
  return { rt, placeId, project: project!, seen, pair, hostKey };
}

export const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

/** What a message starts with to hold its turn open until the case answers it. */
export const HOLD = "hold: ";

export interface Held {
  o: HarnessStartOptions;
  env: Readonly<Record<string, string>>;
  answer(text: string): void;
}

/** A harness whose lead turn runs until the case answers it, as a coordinator's does while its children work, and
 * whose every other turn answers at once, but one the case marks to hold the same way, as a builder's turn runs. */
export function leading(starts: Held[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      let answer = (_text: string): void => {};
      const finished = new Promise<TurnResult>(resolve => {
        answer = text => {
          const result: TurnResult = { status: "completed", text };
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      starts.push({ o, env: hctx.env, answer });
      o.onEvent({ type: "session.start", sessionId });
      if (o.prompt !== "coordinate" && !o.prompt.startsWith(HOLD)) answer("built it");
      return { localId: sessionId, finished, interrupt: async () => answer("stopped") };
    },
  });
}

/** A host holding this computer's folder of acme/lab in `root`, with a lead thread running on it, hetzner joined as
 * root, the same repository added there and another repository there. With `reach`, the lead's launch carries the
 * host's address and its own token, as a launch on this computer does under the host. */
export async function leadAndBox(root: string, o: { agents?: { spawn: boolean; maxDepth?: number }; reach?: true } = {}) {
  const repo = joinPath(root, "lab");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/lab.git"]);
  const starts: Held[] = [];
  const here: { url?: string } = {};
  const { hostKey, store } = await serving({ adapters: { claude: leading(starts) }, local: fakeLocal(joinPath(root, "home")), ...(o.reach === true ? { agents: { here, wspMcp: { command: "wsp", args: ["mcp"] } } } : {}) });
  here.url = `ws://127.0.0.1:${ctx.srv!.port}`;
  let seen!: Box;
  const { client, placeId } = await join(hostKey, {
    code: await code(),
    report: report("hetzner", { login: { HOME: HETZNER.home, USER: "root", PATH: "/usr/bin" } }),
    answers: c => void (seen = box(c, HETZNER)),
  });
  sockets.push(client.ws);
  const rt = ctx.runtime!;
  const mac = await rt.projects.add({ source: repo, on: HERE_PLACE_ID, name: "lab" });
  const onBox = await rt.projects.add({ source: "https://github.com/acme/lab", on: "hetzner", name: "lab-box" });
  await rt.projects.add({ source: "https://github.com/acme/else", on: "hetzner", name: "else-box" });
  const folder = await rt.workspaces.create({ project: mac.id, name: "lab", agents: o.agents ?? { spawn: true } });
  const turn = await rt.sessions.start(folder.id, { prompt: "coordinate", harness: "claude" });
  const threadId = turn.view().threadId!;
  const lead: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: folder.id, rootThreadId: threadId } };
  return { rt, seen, starts, mac, onBox, folder, threadId, lead, launch: starts[0]!.env, turn, hostKey, store, placeId, repo };
}
