// SPDX-License-Identifier: AGPL-3.0-only
// The agents report off one computer or workspace. Which machine a target is,
// and what that computer already said about itself, is the runtime's to know;
// reading the agents, skills and servers off it is the host's, since the
// catalog's readers live there. A read never wakes a machine.
import { AgentsReport, HERE_PLACE_ID, isJoinedComputer, nappingAgentsRefusal, noSuchPlaceRefusal, providerAgentsRefusal, type AgentSignInState, type AgentsTarget, type WorkspacePhase } from "@wsp/protocol";
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
  | { kind: "machine"; machine: Pick<Machine, "exec">; project?: string };

/** How the host reads the agents off a target. Absent on a runtime wired without it, where every read is refused. */
export interface AgentsReader {
  read(on: AgentsOn): Promise<AgentsRead>;
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

export function agentsReads<Caller>(o: AgentsReadOptions<Caller>): { read(target: AgentsTarget, origin?: Caller): Promise<AgentsReport> } {
  /** The last report read off each workspace while it ran, which is what a napping one answers. */
  const last = new Map<string, AgentsReport>();
  const stamped = (target: AgentsTarget, read: AgentsRead): AgentsReport => AgentsReport.parse({ target, readAt: new Date(o.now()).toISOString(), ...read });
  return {
    async read(target, origin) {
      const reader = o.reader;
      if (reader === undefined) throw new Error(NO_AGENTS_READER);
      if ("placeId" in target) {
        if (target.placeId === HERE_PLACE_ID) return stamped(target, await reader.read({ kind: "here" }));
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
        return stamped(target, await reader.read({ kind: "box", machine, login, ...(signIns !== undefined ? { signIns } : {}), ...(report?.agentVersions !== undefined ? { versions: report.agentVersions } : {}) }));
      }
      const ws = await o.workspace(target.workspaceId, origin);
      if (ws.phase === "napping") {
        const held = last.get(target.workspaceId);
        if (held === undefined) throw usage(nappingAgentsRefusal(ws.name));
        return { ...held, stale: "napping" };
      }
      const on: AgentsOn = ws.local ? { kind: "here", project: ws.project } : { kind: "machine", machine: ws.machine, project: ws.project };
      const report = stamped(target, await reader.read(on));
      last.set(target.workspaceId, report);
      return report;
    },
  };
}
