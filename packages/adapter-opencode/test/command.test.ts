// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { AUTO_MODE, buildCommand, buildEnv } from "../src/command.js";

describe("the opencode run line", () => {
  it("runs one JSON turn in the folder, resumes by session, and takes the model, the variant and the title", () => {
    const line = buildCommand({ prompt: "list the files", cwd: "/root/app", resume: "ses_f1d55cde0ffe2JZqKKpAnaa1c3", model: "openrouter/anthropic/claude-sonnet-4.5", effort: "high", title: "Largest files", permissionMode: AUTO_MODE });
    expect(line.startsWith("cd '/root/app' && opencode run --format json --print-logs --log-level ERROR --dir '/root/app'")).toBe(true);
    expect(line).toContain(" -s ses_f1d55cde0ffe2JZqKKpAnaa1c3");
    expect(line).toContain(" -m openrouter/anthropic/claude-sonnet-4.5");
    expect(line).toContain(" --variant high");
    expect(line).toContain(" --title='Largest files'");
    expect(line).toContain(" --auto");
  });

  it("sends --auto on the Auto mode alone and refuses any other mode", () => {
    expect(buildCommand({ prompt: "hi" })).not.toContain("--auto");
    expect(() => buildCommand({ prompt: "hi", permissionMode: "default" })).toThrow(/permissionMode must be auto/);
  });

  it("carries the prompt on stdin, never as an argument, so no length meets the per-argument cap", () => {
    const prompt = `${"x".repeat(200_000)}\nit's "quoted" $HOME \`not run\``;
    const line = buildCommand({ prompt });
    expect(line).toContain(`<<'WSP_PROMPT_END'\n${prompt}\nWSP_PROMPT_END`);
    expect(() => buildCommand({ prompt: "one\nWSP_PROMPT_END\ntwo" })).toThrow(/ends the prompt/);
  });

  it("the heredoc reaches the binary's stdin whole, with nothing on its argument list", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-opencode-line-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // A stand-in that prints its arguments and then its stdin, so the shell line runs as the machine would run it.
    writeStub(join(dir, "opencode"), '#!/bin/sh\nprintf "args:%s\\n" "$*"\ncat\n');
    const out = execFileSync("bash", ["-c", buildCommand({ prompt: "it's $HOME\nline two", cwd: dir })], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } });
    expect(out).toBe(`args:run --format json --print-logs --log-level ERROR --dir ${dir}\nit's $HOME\nline two\n`);
  });

  it("takes one -f per image, each an absolute path, after every other flag", () => {
    const line = buildCommand({ prompt: "what is this", images: ["/root/.wsp/images/t1/a.png", "/root/.wsp/images/t1/b c.png"] });
    expect(line).toContain(" -f '/root/.wsp/images/t1/a.png' -f '/root/.wsp/images/t1/b c.png' <<'WSP_PROMPT_END'");
    expect(() => buildCommand({ prompt: "x", images: ["-rf"] })).toThrow(/absolute path/);
  });

  it("refuses a value that would read as a flag or break out of its word", () => {
    expect(() => buildCommand({ prompt: "x", resume: "--auto" })).toThrow(/resume/);
    expect(() => buildCommand({ prompt: "x", model: "-m" })).toThrow(/provider\/model/);
    expect(() => buildCommand({ prompt: "x", model: "claude-sonnet" })).toThrow(/provider\/model/);
    expect(() => buildCommand({ prompt: "x", effort: "high; rm -rf /" })).toThrow(/effort/);
  });
});

describe("the opencode turn's environment", () => {
  it("is the machine's login environment, with the vault's key under the variable its row names", () => {
    expect(buildEnv({ base: { PATH: "/usr/bin", GONE: undefined } })).toEqual({ PATH: "/usr/bin" });
    expect(buildEnv({ base: { PATH: "/usr/bin" }, apiKey: "sk-x", keyEnv: "OPENCODE_API_KEY" })).toEqual({ PATH: "/usr/bin", OPENCODE_API_KEY: "sk-x" });
  });
});
