// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one computer or workspace. Which machine a target is,
// and what that computer already said about itself, is the runtime's to know;
// reading the agents, skills and servers off it is the host's, since the
// catalog's readers live there. A read never wakes a machine.
import { AgentsReport, HERE_PLACE_ID, ServerToolsAnswer, isJoinedComputer, nappingAgentsRefusal, nappingToolsRefusal, noSuchPlaceRefusal, providerAgentsRefusal, type AgentSignInState, type AgentsTarget, type WorkspacePhase } from "@wsp/protocol";
import type { Machine } from "@wsp/engine";
import { NO_PLACE_DOOR, type PlaceDoor } from "./places.js";

/** What the host reads off a target: the report less what the runtime stamps on it. */
export type AgentsRead = Omit<AgentsReport, "target" | "readAt" | "stale">;

/** Where a read runs: this computer, with a project's folder when a workspace here is the target; a computer you
 * joined, over its link, with the login and the sign-ins and versions its own report carries; or any other machine,
 * with the project's folder on it. */
export type AgentsOn =
  | { kind: "here"; project?: string }
  | { kind: "box"; machine: Pick<Machine, "exec">; login: { HOME?: string; PATH?: string }; signIns?: Record<string, AgentSignInState>; versions?: Record<string, string> }
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
} {
  /** The last report read off each workspace while it ran, which is what a napping one answers. */
  const last = new Map<string, AgentsReport>();
  const stamped = (target: AgentsTarget, read: AgentsRead): AgentsReport => AgentsReport.parse({ target, readAt: new Date(o.now()).toISOString(), ...read });
  const readerOf = (): AgentsReader => {
    if (o.reader === undefined) throw new Error(NO_AGENTS_READER);
    return o.reader;
  };
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
      return { kind: "box", machine, login, ...(signIns !== undefined ? { signIns } : {}), ...(report?.agentVersions !== undefined ? { versions: report.agentVersions } : {}) };
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
  };
}
