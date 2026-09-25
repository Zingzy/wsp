// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { AgentsChangedEvent, AgentsReport, AgentsSignInEvent, EventUnion, RuntimeRequest, SECRET_REQUEST_FIELDS, ServerToolsAnswer, SignInLine, THREAD_OPS, DEVICE_OPS, requestSecrets, serverToolsLateRefusal } from "../src/index.js";

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

  it("the sign-in acts name their target and agent, carry the code and the key in the fields a log hides, and are shut to threads and paired devices", () => {
    const acts = [
      { id: "1", op: "agents.signIn", target: { placeId: "p_spoo" }, agent: "codex" },
      { id: "2", op: "servers.signIn", target: { workspaceId: "ws_1" }, agent: "claude", name: "notion" },
      { id: "3", op: "agents.signInCode", signInId: "si_1", code: "ABCD-1234" },
      { id: "4", op: "agents.signInLine", target: { placeId: "here" }, agent: "opencode" },
      { id: "5", op: "agents.signInLine", target: { placeId: "here" }, agent: "claude", name: "notion" },
      { id: "6", op: "agents.key", agent: "claude", key: "sk-ant-oat01-x" },
      { id: "7", op: "agents.addTools", target: { placeId: "here" }, agent: "codex" },
    ];
    for (const act of acts) {
      expect(RuntimeRequest.parse(act)).toEqual(act);
      expect(THREAD_OPS).not.toContain(act.op);
      expect(DEVICE_OPS).not.toContain(act.op);
    }
    expect(SECRET_REQUEST_FIELDS).toEqual(expect.arrayContaining(["code", "key"]));
    expect(requestSecrets(acts[2])).toEqual(["ABCD-1234"]);
    expect(requestSecrets(acts[5])).toEqual(["sk-ant-oat01-x"]);
    expect(() => RuntimeRequest.parse({ id: "8", op: "agents.signIn", target: { placeId: "p" } })).toThrow();
  });

  it("a sign-in's progress carries the page, the code it printed and whether a code goes back, and the change event rides the stream", () => {
    const waiting = { type: "agents.signIn", signInId: "si_1", state: "waiting", url: "https://auth.openai.com/device", code: "ABCD-1234", paste: false };
    expect(AgentsSignInEvent.parse(waiting)).toEqual(waiting);
    expect(AgentsSignInEvent.parse({ type: "agents.signIn", signInId: "si_1", state: "failed", said: "Not logged in" }).said).toBe("Not logged in");
    expect(() => AgentsSignInEvent.parse({ ...waiting, state: "maybe" })).toThrow();
    expect(AgentsChangedEvent.parse({ type: "agents.changed", target: { placeId: "here" } })).toMatchObject({ target: { placeId: "here" } });
    expect(EventUnion.parse({ type: "agents.changed", seq: 3 })).toMatchObject({ type: "agents.changed" });
    expect(SignInLine.parse({ command: "codex login --device-auth", env: { CODEX_HOME: "/var/lib/wsp/logins/codex" }, prepare: "mkdir -p x", status: "codex login status" })).toMatchObject({ prepare: "mkdir -p x" });
  });
});
