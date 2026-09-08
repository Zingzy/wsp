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

  it("passes one -i per image, in the message's order, and still reads the prompt from stdin", () => {
    const command = buildCommand({ prompt: "what is this?", images: ["/root/.wsp/threads/thr_1/images/1.png", "/root/.wsp/threads/thr_1/images/2.jpg"] });
    expect(command).toContain("-i '/root/.wsp/threads/thr_1/images/1.png' -i '/root/.wsp/threads/thr_1/images/2.jpg' -");
    expect(command).toContain(`<<'WSP_PROMPT_END'\nwhat is this?\nWSP_PROMPT_END`);
  });

  it("a resumed turn carries its images too, since resume takes the same flag", () => {
    const command = buildCommand({ prompt: "and this?", resume: "01a07eb8-df2d-7051-bace-d55c9283c26d", images: ["/root/.wsp/threads/thr_1/images/1.png"] });
    expect(command).toContain("codex exec resume 01a07eb8-df2d-7051-bace-d55c9283c26d");
    expect(command).toContain("-i '/root/.wsp/threads/thr_1/images/1.png' -");
  });

  it("a turn with no image carries no flag", () => {
    expect(buildCommand({ prompt: "x", images: [] })).not.toContain("-i ");
    expect(buildCommand({ prompt: "x" })).not.toContain("-i ");
  });

  it("refuses a path that is not one absolute path on the machine, since the flag would read a dash as the next flag", () => {
    expect(() => buildCommand({ prompt: "x", images: ["--help"] })).toThrow("must be one absolute path");
    expect(() => buildCommand({ prompt: "x", images: ["shot.png"] })).toThrow("must be one absolute path");
    expect(() => buildCommand({ prompt: "x", images: ["/tmp/a\n/tmp/b"] })).toThrow("must be one absolute path");
  });

  it("quotes a path with a space rather than letting it become two values", () => {
    expect(buildCommand({ prompt: "x", images: ["/root/my shots/1.png"] })).toContain("-i '/root/my shots/1.png'");
  });
});
