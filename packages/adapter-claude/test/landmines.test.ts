import { describe, expect, it } from "vitest";

import { buildCommand, buildEnv, newSessionId } from "../src/landmines.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("buildEnv", () => {
  const base = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "12345",
    FORCE_CODE_TERMINAL: "true",
    PATH: "/root/.local/bin:/usr/bin",
    HOME: "/Users/z",
  };

  it("strips inherited CLAUDE_CODE_*, CLAUDECODE and FORCE_CODE_TERMINAL", () => {
    const env = buildEnv({ base, configDir: "/root/.claude-cfg" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.FORCE_CODE_TERMINAL).toBeUndefined();
    expect(env.PATH).toBe(base.PATH);
  });

  it("sets CLAUDE_CONFIG_DIR and leaves HOME alone", () => {
    const env = buildEnv({ base, configDir: "/root/.claude-cfg" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/root/.claude-cfg");
    expect(env.HOME).toBe("/Users/z");
  });

  it("sets the headless flags: IS_SANDBOX plus IDE-discovery suppression", () => {
    const env = buildEnv({ base, configDir: "/root/.claude-cfg" });
    expect(env.IS_SANDBOX).toBe("1");
    expect(env.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("0");
    expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe("1");
    const leaked = Object.keys(env).filter(
      (k) =>
        (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") &&
        k !== "CLAUDE_CODE_AUTO_CONNECT_IDE" &&
        k !== "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
    );
    expect(leaked).toEqual([]);
  });

  it("passes the API key through when given", () => {
    const env = buildEnv({ base: {}, configDir: "/root/.claude-cfg", apiKey: "sk-ant-x" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });

  it("refuses an empty or relative configDir", () => {
    expect(() => buildEnv({ base: {}, configDir: "" })).toThrow(/configDir/);
    expect(() => buildEnv({ base: {}, configDir: ".claude-cfg" })).toThrow(/configDir/);
  });
});

describe("newSessionId", () => {
  it("returns unique v4-shaped UUIDs", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});

describe("buildCommand", () => {
  const sessionId = "e16ed170-8257-4668-879e-fe836341633c";

  it("carries every required flag for a fresh session", () => {
    const cmd = buildCommand({ prompt: "say ok", sessionId });
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain(`--session-id ${sessionId}`);
    expect(cmd.endsWith("</dev/null")).toBe(true);
    expect(cmd).not.toContain("--resume");
  });

  it("uses --resume instead of --session-id when resuming", () => {
    const cmd = buildCommand({ prompt: "say ok", resume: sessionId });
    expect(cmd).toContain(`--resume ${sessionId}`);
    expect(cmd).not.toContain("--session-id");
  });

  it("prefixes cd when a cwd is given", () => {
    const cmd = buildCommand({ prompt: "say ok", sessionId, cwd: "/root/app" });
    expect(cmd.startsWith("cd '/root/app' && claude -p")).toBe(true);
  });

  it("single-quotes the prompt so shell metacharacters stay inert", () => {
    const cmd = buildCommand({ prompt: "don't run $(reboot) `id`", sessionId });
    expect(cmd).toContain(String.raw`'don'\''t run $(reboot) ` + "`id`'");
  });

  it("rejects zero or two session identifiers", () => {
    expect(() => buildCommand({ prompt: "x" })).toThrow(/exactly one/);
    expect(() => buildCommand({ prompt: "x", sessionId, resume: sessionId })).toThrow(
      /exactly one/,
    );
  });

  it("rejects a session identifier that is not a UUID", () => {
    expect(() => buildCommand({ prompt: "x", resume: "$(rm -rf /)" })).toThrow(/UUID/);
    expect(() => buildCommand({ prompt: "x", sessionId: "abc" })).toThrow(/UUID/);
  });
});
