// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one computer or workspace. Which machine a target is,
// and what that computer already said about itself, is the runtime's to know;
// reading the agents, skills and servers off it is the host's, since the
// catalog's readers live there. A read never wakes a machine.
import { randomBytes } from "node:crypto";
import { AgentsReport, HERE_PLACE_ID, ServerToolsAnswer, SignInLine, isJoinedComputer, nappingAgentsRefusal, nappingSignInRefusal, nappingToolsRefusal, noSignInRefusal, noSuchPlaceRefusal, providerAgentsRefusal, type AgentSignInState, type AgentsSignInEvent, type AgentsTarget, type DaemonFrame, type WorkspacePhase } from "@wsp/protocol";
import type { Machine } from "@wsp/engine";
import type { DaemonChannel } from "./daemon-channel.js";
import { NO_PLACE_DOOR, type PlaceDoor } from "./places.js";

/** What the host reads off a target: the report less what the runtime stamps on it. */
export type AgentsRead = Omit<AgentsReport, "target" | "readAt" | "stale">;

/** Where a read runs: this computer, with a project's folder when a workspace here is the target; a computer you
 * joined, over its link, with the login and the sign-ins and versions its own report carries; or any other machine,
 * with the project's folder on it. */
export type AgentsOn =
  | { kind: "here"; project?: string }
  | { kind: "box"; machine: Pick<Machine, "exec">; login: { HOME?: string; PATH?: string }; signIns?: Record<string, AgentSignInState>; versions?: Record<string, string>; logins?: string }
  | { kind: "machine"; machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; project?: string };

/** One MCP server of one agent's config on a target, asked for its tools. `key` names the target, which is what an
 * answer is kept under. */
export interface ServerToolsAsk {
  key: string;
  agent: string;
  name: string;
  refresh?: boolean;
}

/** How the host reads the agents off a target, and asks one server there for its tools. Absent on a runtime wired
 * without it, where every read is refused. */
export interface AgentsReader {
  read(on: AgentsOn): Promise<AgentsRead>;
  tools(on: AgentsOn, ask: ServerToolsAsk): Promise<ServerToolsAnswer>;
}

/** A pty road to a target's daemon, frame by frame, with every event it pushes: what a sign-in's pty runs over. */
export interface PtyLink {
  op(op: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Daemon events as they arrive; the return detaches. */
  onEvent(fn: (e: Record<string, unknown>) => void): () => void;
  /** Settles when the link is gone. */
  closed?: Promise<unknown>;
}

/** An agent's sign-in, or with `server` one MCP server's in that agent's config. */
export interface SignInAsk {
  agent: string;
  server?: string;
}

/** What one watched sign-in is handed: the link its pty runs over, where its steps go, where it hands the writer a
 * code from a page is typed with (nothing once it is gone), and the stop from whoever started it. */
export interface SignInRun {
  link: PtyLink;
  emit(step: Omit<AgentsSignInEvent, "type" | "signInId">): void;
  typing(write: ((code: string) => Promise<void>) | undefined): void;
  stop: Promise<void>;
}

/** What the host writes and runs for the agents on a target, beside reading them. */
export interface AgentsActs {
  /** The sign-in as the line the person's own terminal runs there, a row that asks them to pick included. */
  signInLine(on: AgentsOn, ask: SignInAsk): Promise<SignInLine>;
  /** Plans the sign-in, refusing what cannot run in a watched pty, and answers the run. */
  signIn(on: AgentsOn, ask: SignInAsk): Promise<(run: SignInRun) => Promise<void>>;
  /** Writes an agent's token or key into this host's vault. */
  key(agent: string, key: string): Promise<void>;
  /** Writes the wsp server into that agent's own config there. */
  addTools(on: AgentsOn, agent: string): Promise<{ file: string }>;
}

/** The refusal for a runtime served without the readers. */
export const NO_AGENTS_READER = "this runtime carries no agents reader; the host that serves the app wires one";

/** One workspace as the read needs it. */
export interface AgentsWorkspace {
  name: string;
  phase: WorkspacePhase;
  local: boolean;
  machine: Machine;
  project: string;
}

export interface AgentsReadOptions<Caller> {
  reader: AgentsReader | undefined;
  places: () => PlaceDoor | undefined;
  workspace: (id: string, origin?: Caller) => Promise<AgentsWorkspace>;
  acts?: AgentsActs;
  /** One channel to the target's daemon: this computer's, a joined computer's over its link, or a workspace's. */
  channel: (target: AgentsTarget, onEvent: (event: Record<string, unknown>) => void, origin?: Caller) => Promise<DaemonChannel>;
  /** Something written changed what a report reads there; no target is every report. */
  changed: (target?: AgentsTarget) => void;
  now: () => number;
}

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** A workspace that is napping, which nothing here wakes. */
interface Napping {
  napping: string;
}

export function agentsReads<Caller>(o: AgentsReadOptions<Caller>): {
  read(target: AgentsTarget, origin?: Caller): Promise<AgentsReport>;
  tools(target: AgentsTarget, ask: { agent: string; name: string; refresh?: boolean }, origin?: Caller): Promise<ServerToolsAnswer>;
  forget(workspaceId: string): void;
  signIn(target: AgentsTarget, ask: SignInAsk, emit: (event: AgentsSignInEvent) => void, origin?: Caller): Promise<{ signInId: string; stop(): void }>;
  signInCode(signInId: string, code: string): Promise<void>;
  signInLine(target: AgentsTarget, ask: SignInAsk, origin?: Caller): Promise<SignInLine>;
  key(agent: string, key: string): Promise<void>;
  addTools(target: AgentsTarget, agent: string, origin?: Caller): Promise<{ file: string }>;
} {
  /** The last report read off each workspace while it ran, which is what a napping one answers. */
  const last = new Map<string, AgentsReport>();
  const stamped = (target: AgentsTarget, read: AgentsRead): AgentsReport => AgentsReport.parse({ target, readAt: new Date(o.now()).toISOString(), ...read });
  const readerOf = (): AgentsReader => {
    if (o.reader === undefined) throw new Error(NO_AGENTS_READER);
    return o.reader;
  };
  const actsOf = (): AgentsActs => {
    if (o.acts === undefined) throw new Error(NO_AGENTS_READER);
    return o.acts;
  };
  /** The code writer of each sign-in running, by its id. */
  const running = new Map<string, { type?: (code: string) => Promise<void> }>();
  /** Where a target's lines run, or the napping workspace's name. */
  const onOf = async (target: AgentsTarget, origin?: Caller): Promise<AgentsOn | Napping> => {
    if ("placeId" in target) {
      if (target.placeId === HERE_PLACE_ID) return { kind: "here" };
      const door = o.places();
      if (door === undefined) throw new Error(NO_PLACE_DOOR);
      const rows = await door.list(o.now());
      const row = rows.find(p => p.id === target.placeId);
      if (row === undefined) throw usage(noSuchPlaceRefusal(target.placeId, rows.map(p => p.name)));
      if (!isJoinedComputer(row)) throw usage(providerAgentsRefusal(row.name));
      const report = await door.reportOf(row.id);
      const signIns = door.signInsAt(row.id);
      const machine = { exec: (cmd: string, opts?: { timeoutMs?: number; stdin?: Uint8Array }) => door.exec(row.id, cmd, opts ?? {}) };
      const login = { ...(report?.login["HOME"] !== undefined ? { HOME: report.login["HOME"] } : {}), ...(report?.login["PATH"] !== undefined ? { PATH: report.login["PATH"] } : {}) };
      return { kind: "box", machine, login, ...(signIns !== undefined ? { signIns } : {}), ...(report?.agentVersions !== undefined ? { versions: report.agentVersions } : {}), ...(row.logins !== undefined ? { logins: row.logins } : {}) };
    }
    const ws = await o.workspace(target.workspaceId, origin);
    if (ws.phase === "napping") return { napping: ws.name };
    return ws.local ? { kind: "here", project: ws.project } : { kind: "machine", machine: ws.machine, project: ws.project };
  };
  return {
    async read(target, origin) {
      const reader = readerOf();
      const on = await onOf(target, origin);
      if ("napping" in on) {
        const held = "workspaceId" in target ? last.get(target.workspaceId) : undefined;
        if (held === undefined) throw usage(nappingAgentsRefusal(on.napping));
        return { ...held, stale: "napping" };
      }
      const report = stamped(target, await reader.read(on));
      if ("workspaceId" in target) last.set(target.workspaceId, report);
      return report;
    },
    async tools(target, ask, origin) {
      const reader = readerOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingToolsRefusal(on.napping));
      return ServerToolsAnswer.parse(await reader.tools(on, { key: JSON.stringify(target), ...ask }));
    },
    /** A removed workspace's last report goes with it. */
    forget: workspaceId => void last.delete(workspaceId),
    async signIn(target, ask, emit, origin) {
      const acts = actsOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
      const run = await acts.signIn(on, ask);
      const signInId = `si_${randomBytes(6).toString("hex")}`;
      const readers = new Set<(e: Record<string, unknown>) => void>();
      const channel = await o.channel(target, e => readers.forEach(read => read(e)), origin);
      let stop: () => void = () => {};
      const stopped = new Promise<void>(r => (stop = r));
      const slot: { type?: (code: string) => Promise<void> } = {};
      running.set(signInId, slot);
      const link: PtyLink = {
        op: async (op, extra) => (await channel.send({ op, ...extra } as DaemonFrame)) as Record<string, unknown>,
        onEvent: fn => {
          readers.add(fn);
          return () => readers.delete(fn);
        },
        closed: channel.closed,
      };
      const step = (s: Omit<AgentsSignInEvent, "type" | "signInId">): void => emit({ type: "agents.signIn", signInId, ...s });
      void run({ link, emit: step, typing: write => (write === undefined ? delete slot.type : (slot.type = write)), stop: stopped })
        .catch((e: unknown) => step({ state: "failed", said: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          running.delete(signInId);
          channel.close();
          o.changed(target);
        });
      return { signInId, stop };
    },
    async signInCode(signInId, code) {
      const type = running.get(signInId)?.type;
      if (type === undefined) throw usage(noSignInRefusal);
      await type(code);
    },
    async signInLine(target, ask, origin) {
      const acts = actsOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
      return SignInLine.parse(await acts.signInLine(on, ask));
    },
    async key(agent, key) {
      await actsOf().key(agent, key);
      o.changed();
    },
    async addTools(target, agent, origin) {
      const acts = actsOf();
      const on = await onOf(target, origin);
      if ("napping" in on) throw usage(nappingSignInRefusal(on.napping));
      const added = await acts.addTools(on, agent);
      o.changed(target);
      return added;
    },
  };
}
