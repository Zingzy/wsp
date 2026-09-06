import { describe, expect, it } from "vitest";

import { buildCommand, buildEnv, newSessionId, userMessageLine } from "../src/landmines.js";

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

  it("carries every required flag for a fresh session and reads its messages from stdin as stream-json", () => {
    const cmd = buildCommand({ sessionId });
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--input-format stream-json");
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain(`--session-id ${sessionId}`);
    // stdin is the message channel now: never closed on the command, never a positional prompt
    expect(cmd).not.toContain("</dev/null");
    expect(cmd).toMatch(/claude -p --/);
    expect(cmd).not.toContain("--resume");
  });

  it("uses --resume instead of --session-id when resuming", () => {
    const cmd = buildCommand({ resume: sessionId });
    expect(cmd).toContain(`--resume ${sessionId}`);
    expect(cmd).not.toContain("--session-id");
  });

  it("prefixes cd when a cwd is given", () => {
    const cmd = buildCommand({ sessionId, cwd: "/root/app" });
    expect(cmd.startsWith("cd '/root/app' && claude -p")).toBe(true);
  });

  it("maps the picked model, effort and permission mode to the CLI's flags", () => {
    const cmd = buildCommand({ sessionId, model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits" });
    expect(cmd).toContain("--model 'claude-opus-5'");
    expect(cmd).toContain("--effort 'high'");
    expect(cmd).toContain("--permission-mode 'acceptEdits'");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("no permission mode and bypassPermissions both skip permissions; default sends no permission flag at all", () => {
    expect(buildCommand({ sessionId })).toContain("--dangerously-skip-permissions");
    const bypass = buildCommand({ sessionId, permissionMode: "bypassPermissions" });
    expect(bypass).toContain("--dangerously-skip-permissions");
    expect(bypass).not.toContain("--permission-mode");
    const plain = buildCommand({ sessionId, permissionMode: "default" });
    expect(plain).not.toContain("--dangerously-skip-permissions");
    expect(plain).not.toContain("--permission-mode");
  });

  it("a context window rides the model as the CLI's own suffix; 200k is the plain slug", () => {
    expect(buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "1m" })).toContain("--model 'claude-opus-5[1m]'");
    expect(buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "200k" })).toContain("--model 'claude-opus-5'");
    expect(() => buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "2m" })).toThrow(/contextWindow/);
    expect(() => buildCommand({ sessionId, contextWindow: "1m" })).toThrow(/contextWindow/);
  });

  it("sends no model or effort flag when none was picked", () => {
    const cmd = buildCommand({ sessionId });
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--effort");
  });

  it("rejects a picked value that is not a plain slug", () => {
    expect(() => buildCommand({ sessionId, model: "opus; rm -rf /" })).toThrow(/model/);
    expect(() => buildCommand({ sessionId, effort: "" })).toThrow(/effort/);
    expect(() => buildCommand({ sessionId, permissionMode: "plan mode" })).toThrow(/permissionMode/);
    expect(buildCommand({ sessionId, model: "claude-opus-5[1m]" })).toContain("--model 'claude-opus-5[1m]'");
  });

  it("rejects zero or two session identifiers", () => {
    expect(() => buildCommand({})).toThrow(/exactly one/);
    expect(() => buildCommand({ sessionId, resume: sessionId })).toThrow(
      /exactly one/,
    );
  });

  it("rejects a session identifier that is not a UUID", () => {
    expect(() => buildCommand({ resume: "$(rm -rf /)" })).toThrow(/UUID/);
    expect(() => buildCommand({ sessionId: "abc" })).toThrow(/UUID/);
  });
});

describe("userMessageLine", () => {
  const sessionId = "e16ed170-8257-4668-879e-fe836341633c";

  it("is one stream-json user line the CLI takes on stdin, with the text intact", () => {
    const text = "don't run $(reboot) `id`\nsecond line with \"quotes\"";
    const line = userMessageLine(text, sessionId);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
  });
});
