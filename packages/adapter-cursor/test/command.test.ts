// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { FORCE_MODE, buildCommand, buildEnv } from "../src/command.js";

const CHAT = "c6b62c6f-7ead-4fd6-9922-e952131177ff";

describe("the agent print line", () => {
  it("runs one stream-json turn in the folder it trusts, resumes by chat and takes the model", () => {
    const line = buildCommand({ prompt: "list the files", cwd: "/root/app", resume: CHAT, model: "claude-opus-4-8[context=1m,effort=high]" });
    expect(line.startsWith("cd '/root/app' && cursor-agent -p --output-format stream-json --stream-partial-output --trust --workspace '/root/app'")).toBe(true);
    expect(line).toContain(" --model 'claude-opus-4-8[context=1m,effort=high]'");
    expect(line).toContain(` --resume ${CHAT}`);
  });

  it("sends --force on the force mode alone and refuses a mode the row does not carry", () => {
    expect(buildCommand({ prompt: "hi" })).not.toContain("--force");
    expect(buildCommand({ prompt: "hi", permissionMode: "default" })).not.toContain("--force");
    expect(buildCommand({ prompt: "hi", permissionMode: FORCE_MODE })).toContain(" --force");
    expect(() => buildCommand({ prompt: "hi", permissionMode: "yolo" })).toThrow(/permissionMode must be one of default, force/);
  });

  it("never carries a key: it rides the environment, where no process list shows it", () => {
    expect(buildCommand({ prompt: "hi", permissionMode: FORCE_MODE, model: "gpt-5" })).not.toMatch(/api-key|CURSOR_API_KEY/);
    expect(buildEnv({ base: { PATH: "/usr/bin", GONE: undefined }, apiKey: "key_x", keyEnv: "CURSOR_API_KEY" })).toEqual({ PATH: "/usr/bin", CURSOR_API_KEY: "key_x" });
    expect(buildEnv({ base: { PATH: "/usr/bin" } })).toEqual({ PATH: "/usr/bin" });
  });

  it("the prompt reaches the binary's stdin whole through the heredoc, with no prompt word on its argument list", () => {
    const prompt = `${"y".repeat(200_000)}\nit's "quoted" $HOME`;
    expect(buildCommand({ prompt })).toContain(`<<'WSP_PROMPT_END'\n${prompt}\nWSP_PROMPT_END`);
    expect(() => buildCommand({ prompt: "a\nWSP_PROMPT_END" })).toThrow(/ends the prompt/);
    const dir = mkdtempSync(join(tmpdir(), "wsp-cursor-line-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeStub(join(dir, "cursor-agent"), '#!/bin/sh\nprintf "args:%s\\n" "$*"\ncat\n');
    const out = execFileSync("bash", ["-c", buildCommand({ prompt: "it's $HOME\nline two", cwd: dir })], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } });
    expect(out).toBe(`args:-p --output-format stream-json --stream-partial-output --trust --workspace ${dir}\nit's $HOME\nline two\n`);
  });

  it("refuses a model or a chat id that would read as a flag", () => {
    expect(() => buildCommand({ prompt: "x", model: "--force" })).toThrow(/model/);
    expect(() => buildCommand({ prompt: "x", resume: "--force" })).toThrow(/resume/);
  });
});
