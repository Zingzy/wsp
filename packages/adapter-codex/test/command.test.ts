// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildCommand, buildEnv } from "../src/command.js";

describe("buildEnv", () => {
  it("sets CODEX_HOME to the home named and keeps the base environment", () => {
    const env = buildEnv({ base: { PATH: "/usr/bin", HOME: "/Users/z", GONE: undefined }, home: "/root/.codex" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/z", CODEX_HOME: "/root/.codex" });
  });

  it("refuses a relative home", () => {
    expect(() => buildEnv({ home: ".codex" })).toThrow("home must be an absolute path");
  });
});

describe("buildCommand", () => {
  it("runs codex exec with JSONL events, outside a git checkout allowed, no sandbox, the prompt on stdin, in the guest home", () => {
    const command = buildCommand({ prompt: "Reply with exactly the word ok." });
    expect(command).toBe(`cd ~ && codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox - <<'WSP_PROMPT_END'\nReply with exactly the word ok.\nWSP_PROMPT_END`);
  });

  it("asks nothing of codex login: a provider configured on the machine needs none, so the turn's own 401 says it", () => {
    expect(buildCommand({ prompt: "x" })).not.toContain("codex login");
  });

  it("starts in the folder named, quoted", () => {
    expect(buildCommand({ prompt: "x", cwd: "/root/my project" }).startsWith("cd '/root/my project' && ")).toBe(true);
  });

  it("resumes the thread the CLI announced, with the same flags", () => {
    const command = buildCommand({ prompt: "next", resume: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
    expect(command).toContain("codex exec resume 0199a213-81c0-7800-8aa1-bbab2a035a53 --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -");
    expect(() => buildCommand({ prompt: "x", resume: "$(rm -rf /)" })).toThrow("resume must be a plain slug");
  });

  it("a prompt with quotes, dollars and several lines travels as written", () => {
    const prompt = "Say \"hi\" and 'bye'.\nThen print $HOME and `date`.";
    expect(buildCommand({ prompt })).toContain(`<<'WSP_PROMPT_END'\n${prompt}\nWSP_PROMPT_END`);
    expect(() => buildCommand({ prompt: "a\nWSP_PROMPT_END\nb" })).toThrow("ends the prompt");
  });

  it("passes the model as -m and the effort as the config key, both as plain slugs", () => {
    const command = buildCommand({ prompt: "x", model: "gpt-5.5", effort: "high" });
    expect(command).toContain("-m gpt-5.5");
    expect(command).toContain(`-c model_reasoning_effort='"high"'`);
    expect(() => buildCommand({ prompt: "x", model: "a b" })).toThrow("model must be a plain slug");
    expect(() => buildCommand({ prompt: "x", effort: "high;ls" })).toThrow("effort must be a plain slug");
  });

  it("a sandboxed access mode sets the sandbox and turns approvals off; full access is the bypass flag; anything else is refused", () => {
    expect(buildCommand({ prompt: "x", permissionMode: "workspace-write" })).toContain(`-c sandbox_mode='"workspace-write"' -c approval_policy='"never"'`);
    expect(buildCommand({ prompt: "x", permissionMode: "read-only" })).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(buildCommand({ prompt: "x", permissionMode: "danger-full-access" })).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(() => buildCommand({ prompt: "x", permissionMode: "yolo" })).toThrow("permissionMode must be one of read-only, workspace-write, danger-full-access");
  });
});
