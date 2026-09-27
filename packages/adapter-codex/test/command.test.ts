// SPDX-License-Identifier: AGPL-3.0-only
import { HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LAUNCH_ENV, TURN_TOKEN_ENV, WSP_TOOL_TIMEOUT_SEC } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { accessParams, buildCommand, buildEnv } from "../src/command.js";
import { threadResumeLine, threadStartLine } from "../src/rpc.js";

describe("buildEnv", () => {
  it("sets CODEX_HOME to the home named and keeps the base environment", () => {
    const env = buildEnv({ base: { PATH: "/usr/bin", HOME: "/Users/z", GONE: undefined }, home: "/root/.codex" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/z", CODEX_HOME: "/root/.codex" });
  });

  it("sets the API key the vault handed it under both names, and neither when it handed none", () => {
    // CODEX_API_KEY is the variable this CLI's own login reads; OPENAI_API_KEY is the catalog's name for the key
    // and what a provider a person configured with env_key reads. A turn that got no key is set neither.
    const env = buildEnv({ home: "/root/.codex", apiKey: "sk-x-fake-openai" });
    expect(env.CODEX_API_KEY).toBe("sk-x-fake-openai");
    expect(env.OPENAI_API_KEY).toBe("sk-x-fake-openai");
    expect(buildEnv({ home: "/root/.codex" }).CODEX_API_KEY).toBeUndefined();
    expect(buildEnv({ home: "/root/.codex" }).OPENAI_API_KEY).toBeUndefined();
  });

  it("refuses a relative home", () => {
    expect(() => buildEnv({ home: ".codex" })).toThrow("home must be an absolute path");
  });
});

describe("buildCommand", () => {
  it("runs the app server on stdio in the guest home, with no prompt and no turn flags on the line", () => {
    // The plan tool is off in a headless 0.155.1 unless its config turns it on, and its updates are the steps card.
    expect(buildCommand({})).toBe("cd ~ && codex app-server -c tools.update_plan.enabled='true'");
  });

  it("never names a listener: the server speaks on the process's own stdio and nothing else", () => {
    const lines = [
      buildCommand({}),
      buildCommand({ cwd: "/root/w" }),
      buildCommand({ mcpServers: { wsp: { command: "/opt/wsp/bin/wsp", args: ["mcp"] } } }),
    ];
    for (const line of lines) {
      expect(line).not.toContain("--listen");
      expect(line).not.toContain("ws://");
      expect(line).not.toContain("unix://");
      expect(line).not.toContain("exec");
    }
  });

  it("hands each server named on the launch to codex whole, and the wsp one the launch pair by name alone", () => {
    const command = buildCommand({ mcpServers: { wsp: { command: "/opt/wsp/bin/wsp", args: ["mcp"] }, docs: { command: "npx", args: ["-y", "docs-mcp"] } } });
    // A whole entry per server: codex refuses to start on an override that names env_vars for a server its config
    // does not hold (measured on codex-cli 0.155.1: "invalid transport in mcp_servers.wsp").
    expect(command).toContain(`-c mcp_servers.wsp.command='"/opt/wsp/bin/wsp"'`);
    expect(command).toContain(`-c mcp_servers.wsp.args='["mcp"]'`);
    // Codex clears a server's environment down to its own short list, so the pair is named for it to pass through.
    expect(command).toContain(`-c mcp_servers.wsp.env_vars='${JSON.stringify(LAUNCH_ENV)}'`);
    expect([...LAUNCH_ENV].sort()).toEqual([HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV].sort());
    expect(command).toContain(`-c mcp_servers.docs.args='["-y","docs-mcp"]'`);
    expect(command).not.toContain("mcp_servers.docs.env_vars");
    // Codex ends a tool call past its own limit, and a send can wait through a paused Boat's wake before its turn.
    expect(command).toContain(`-c mcp_servers.wsp.tool_timeout_sec='${WSP_TOOL_TIMEOUT_SEC}'`);
    expect(command).not.toContain("mcp_servers.docs.tool_timeout_sec");
    expect(command.startsWith("cd ~ && codex app-server -c tools.update_plan.enabled='true' -c ")).toBe(true);
  });

  it("refuses a server name that is not one plain word of a config key", () => {
    expect(() => buildCommand({ mcpServers: { "a.b": { command: "x", args: [] } } })).toThrow("server name");
  });

  it("asks nothing of codex login: a provider configured on the machine needs none, so the turn's own 401 says it", () => {
    expect(buildCommand({})).not.toContain("codex login");
  });

  it("starts in the folder named, quoted", () => {
    expect(buildCommand({ cwd: "/root/my project" })).toBe("cd '/root/my project' && codex app-server -c tools.update_plan.enabled='true'");
  });
});

describe("accessParams", () => {
  it("the two sandboxed modes keep their sandbox and ask the person when the agent wants past it", () => {
    expect(accessParams("read-only")).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" });
    expect(accessParams("workspace-write")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });

  it("full access, and a turn that names no mode, runs with no sandbox and asks nobody", () => {
    expect(accessParams("danger-full-access")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(accessParams(undefined)).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
  });

  it("refuses any other mode by the three it takes", () => {
    expect(() => accessParams("yolo")).toThrow("permissionMode must be one of read-only, workspace-write, danger-full-access");
    expect(() => accessParams("plan")).toThrow('permissionMode must be one of read-only, workspace-write, danger-full-access, got "plan"');
  });

  it("a fast thread asks the server for the fast service tier, and a thread that is not fast names no tier", () => {
    const access = accessParams(undefined);
    expect(JSON.parse(threadStartLine({ access, serviceTier: "fast" })).params.serviceTier).toBe("fast");
    expect(JSON.parse(threadResumeLine({ access, serviceTier: "fast", threadId: "t1" })).params.serviceTier).toBe("fast");
    expect(JSON.parse(threadStartLine({ access })).params).not.toHaveProperty("serviceTier");
  });
});

