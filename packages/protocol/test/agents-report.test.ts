// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { AgentsReport, RuntimeRequest, THREAD_OPS, DEVICE_OPS } from "../src/index.js";

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
});
