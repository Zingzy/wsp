// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine } from "@wsp/engine";
import { nappingAgentsRefusal, type WorkspacePhase } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { agentsReads, type AgentsOn, type AgentsWorkspace } from "../src/agents-read.js";

const READ = { home: "/root", user: "root", agents: [], skills: [], servers: [], refused: [] };

function reads(phase: { now: WorkspacePhase }, local = false): { asked: AgentsOn[]; api: ReturnType<typeof agentsReads<undefined>> } {
  const asked: AgentsOn[] = [];
  const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
  const api = agentsReads<undefined>({
    reader: { read: async on => (asked.push(on), READ) },
    places: () => undefined,
    workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local, machine, project: "/root/landing" }),
    now: () => Date.parse("2026-09-24T12:00:00Z"),
  });
  return { asked, api };
}

describe("the agents in a workspace", () => {
  it("are read off its machine with its project, and a napping one answers the last report marked stale without being asked", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { asked, api } = reads(phase);
    const first = await api.read({ workspaceId: "ws_1" });
    expect(first).toMatchObject({ target: { workspaceId: "ws_1" }, readAt: "2026-09-24T12:00:00.000Z", ...READ });
    expect(asked).toEqual([{ kind: "machine", machine: expect.anything(), project: "/root/landing" }]);
    phase.now = "napping";
    expect(await api.read({ workspaceId: "ws_1" })).toEqual({ ...first, stale: "napping" });
    expect(asked).toHaveLength(1);
  });

  it("refuses a napping one it never read while it ran, and reads a workspace on this computer as this computer with its project", async () => {
    await expect(reads({ now: "napping" }).api.read({ workspaceId: "ws_2" })).rejects.toThrow(nappingAgentsRefusal("landing"));
    const here = reads({ now: "running" }, true);
    await here.api.read({ workspaceId: "ws_3" });
    expect(here.asked).toEqual([{ kind: "here", project: "/root/landing" }]);
  });

  it("forgets a workspace's last report once the workspace is removed, so nothing holds it for the host's life", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { api } = reads(phase);
    await api.read({ workspaceId: "ws_4" });
    api.forget("ws_4");
    phase.now = "napping";
    await expect(api.read({ workspaceId: "ws_4" })).rejects.toThrow(nappingAgentsRefusal("landing"));
  });
});
