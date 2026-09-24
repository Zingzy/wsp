// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { AgentsReport, RuntimeRequest, ServerToolsAnswer, THREAD_OPS, DEVICE_OPS, serverToolsLateRefusal } from "../src/index.js";

const report = {
  target: { placeId: "here" },
  home: "/Users/ada",
  user: "ada",
  readAt: "2026-09-24T12:00:00.000Z",
  agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.281", road: "own", path: "~/.local/bin/claude", signIn: "signed-in", signInRoad: "token", wspTools: true }],
  skills: [{ name: "pdf", description: "Read PDFs", scope: "user", paths: [{ path: "~/.agents/skills/pdf" }, { path: "~/.claude/skills/pdf", agent: "claude", linkTo: "~/.agents/skills/pdf" }] }],
  servers: [{ agent: "codex", name: "notion", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.notion.com" }, envNames: ["NOTION_TOKEN"], auth: "unknown", enabled: true }],
  refused: [],
};

describe("the agents report on the wire", () => {
  it("carries names and states, and a value that rode along on a row is dropped by the parse", () => {
    expect(AgentsReport.parse(report)).toEqual(report);
    const leaked = { ...report, servers: [{ ...report.servers[0], env: { NOTION_TOKEN: "ntn_x" }, headers: { Authorization: "Bearer x" } }] };
    expect(JSON.stringify(AgentsReport.parse(leaked))).not.toMatch(/ntn_x|Bearer/);
    expect(AgentsReport.parse({ ...report, stale: "napping" }).stale).toBe("napping");
    expect(() => AgentsReport.parse({ ...report, skills: [{ name: "pdf", scope: "user", paths: [] }] })).toThrow();
    expect(() => AgentsReport.parse({ ...report, agents: [{ ...report.agents[0], signIn: "maybe" }] })).toThrow();
  });

  it("agents.read names a computer or a workspace, never both, and is shut to threads and paired devices", () => {
    expect(RuntimeRequest.parse({ id: "1", op: "agents.read", target: { placeId: "here" } })).toMatchObject({ op: "agents.read", target: { placeId: "here" } });
    expect(RuntimeRequest.parse({ id: "1", op: "agents.read", target: { workspaceId: "ws_1" } })).toMatchObject({ target: { workspaceId: "ws_1" } });
    expect(() => RuntimeRequest.parse({ id: "1", op: "agents.read", target: { placeId: "here", workspaceId: "ws_1" } })).toThrow();
    expect(() => RuntimeRequest.parse({ id: "1", op: "agents.read", target: {} })).toThrow();
    expect(THREAD_OPS).not.toContain("agents.read");
    expect(DEVICE_OPS).not.toContain("agents.read");
  });

  it("servers.tools names one server by its agent on a computer or a workspace, and is shut to threads and paired devices", () => {
    const ask = { id: "1", op: "servers.tools", target: { placeId: "p_spoo" }, agent: "claude", name: "airtable" };
    expect(RuntimeRequest.parse(ask)).toEqual(ask);
    expect(RuntimeRequest.parse({ ...ask, refresh: true })).toMatchObject({ refresh: true });
    expect(() => RuntimeRequest.parse({ ...ask, agent: undefined })).toThrow();
    expect(THREAD_OPS).not.toContain("servers.tools");
    expect(DEVICE_OPS).not.toContain("servers.tools");
  });

  it("a tools answer carries the tools, or the harness that holds the sign-in, or why nothing came back", () => {
    const listed = { auth: "open", tools: [{ name: "list_records", description: "List records" }], readAt: "2026-09-24T12:00:00.000Z" };
    expect(ServerToolsAnswer.parse(listed)).toEqual(listed);
    expect(ServerToolsAnswer.parse({ auth: "signed-in", holder: "claude", readAt: listed.readAt })).toMatchObject({ holder: "claude" });
    expect(ServerToolsAnswer.parse({ auth: "failed", refused: serverToolsLateRefusal(20_000), readAt: listed.readAt }).refused).toBe("Did not answer in 20 s.");
    expect(() => ServerToolsAnswer.parse({ auth: "maybe", readAt: listed.readAt })).toThrow();
  });
});
