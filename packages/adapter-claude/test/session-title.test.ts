// SPDX-License-Identifier: AGPL-3.0-only
// The fixture is the record shape of a real session file under
// CLAUDE_CONFIG_DIR/projects/, with the ordering measured on 2.1.263: the last
// ai-title line of a renamed session sits AFTER its last custom-title.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseSessionTitle, parseTitleFor, sessionTitleCommand, titleForCommand } from "../src/session-title.js";

const SESSION = "5b3d3ddb-86d6-47ba-b216-0a510284d8b6";
const FIXTURE = new URL("./fixtures/session-titles.jsonl", import.meta.url);
const run = promisify(execFile);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A config dir with one project folder holding the named session files, as the CLI lays them out. */
function configDir(files: Record<string, string | URL>): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-claude-title-"));
  roots.push(root);
  const project = join(root, "projects", "-root-work-proj");
  mkdirSync(project, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    if (typeof source === "string") writeFileSync(join(project, name), source);
    else copyFileSync(source, join(project, name));
  }
  return root;
}

/** The command as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const titleOf = async (configDir: string, sessionId: string): Promise<string | null> =>
  parseSessionTitle((await run("bash", ["-c", sessionTitleCommand({ configDir, sessionId })])).stdout);

describe("the title Claude Code keeps for a session", () => {
  it("comes out of the session file under whichever project folder holds it, the person's rename beating a generated title written after it", async () => {
    expect(await titleOf(configDir({ [`${SESSION}.jsonl`]: FIXTURE }), SESSION)).toBe("the sidebar's own name");
  });

  it("is the generated one until the person renames the session", async () => {
    const only = `{"type":"ai-title","aiTitle":"Understanding the build","sessionId":"${SESSION}"}\n`;
    expect(await titleOf(configDir({ [`${SESSION}.jsonl`]: only }), SESSION)).toBe("Understanding the build");
  });

  it("is nothing when the file carries no title record, and nothing when there is no such session", async () => {
    const bare = `{"type":"user","sessionId":"${SESSION}","message":{"role":"user","content":"..."}}\n`;
    expect(await titleOf(configDir({ [`${SESSION}.jsonl`]: bare }), SESSION)).toBeNull();
    expect(await titleOf(configDir({}), SESSION)).toBeNull();
  });

  it("takes the last record of each kind, so a rename made after an earlier one is the one that shows", () => {
    const lines = [
      `{"type":"custom-title","customTitle":"first name","sessionId":"${SESSION}"}`,
      `{"type":"custom-title","customTitle":"second name","sessionId":"${SESSION}"}`,
    ].join("\n");
    expect(parseSessionTitle(lines)).toBe("second name");
  });

  it("falls back to the generated title when the rename is blank, and reads nothing out of a line that is not a record", () => {
    expect(parseSessionTitle(`{"type":"custom-title","customTitle":"   ","sessionId":"x"}\n{"type":"ai-title","aiTitle":"Understanding the build","sessionId":"x"}`)).toBe("Understanding the build");
    expect(parseSessionTitle("grep: no such file\nnot json at all\n[]\n")).toBeNull();
  });

  it("quotes the config dir and the session id, so a folder with a space or a quote in it is still one word", () => {
    const command = sessionTitleCommand({ configDir: "/root/it's here", sessionId: SESSION });
    expect(command).toContain(String.raw`'/root/it'\''s here/projects'/*/`);
    expect(command).toContain(`'${SESSION}.jsonl'`);
  });
});

/** A folder holding a `claude` that answers whatever the test wants, first on PATH: what is under test is a shell
 * line, so the binary it runs has to be a real one. */
function fakeClaude(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-claude-bin-"));
  roots.push(root);
  const bin = join(root, "claude");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return root;
}

describe("the title Claude Code makes for a thread", () => {
  it("sends the question on stdin, whatever it holds, and reads the answer out of the print-mode result", async () => {
    const seen = join(mkdtempSync(join(tmpdir(), "wsp-claude-seen-")), "seen");
    const bin = fakeClaude(`{ printf '%s\\n' "$*"; cat; } > ${seen}\nprintf '{"type":"result","is_error":false,"result":"Seed thread titles here"}\\n'`);
    const prompt = "Name it. It's a thread's own \"words\"; nothing else.";
    const command = titleForCommand({ configDir: "/root/.claude-cfg", prompt, model: "claude-sonnet-5" });
    const { stdout } = await run("bash", ["-c", command], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` } });
    expect(parseTitleFor(stdout)).toBe("Seed thread titles here");
    const [argv, ...rest] = readFileSync(seen, "utf8").split("\n");
    expect(argv).toBe("-p --bare --output-format json --allowed-tools  --model claude-sonnet-5");
    expect(rest.join("\n")).toBe(prompt);
  });

  it("runs under the session's own config dir and drops the marks that would make it a nested run", () => {
    const command = titleForCommand({ configDir: "/root/it's here", prompt: "name it", baseEnv: { CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin" } });
    expect(command).toContain(String.raw`CLAUDE_CONFIG_DIR='/root/it'\''s here'`);
    expect(command).toContain("unset ${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL");
    expect(command).not.toContain("CLAUDE_CODE_ENTRYPOINT=");
    expect(command).toContain("printf '%s' 'name it'");
  });

  it("leaves the model to the CLI when the catalog named none", () => {
    expect(titleForCommand({ configDir: "/root/.claude-cfg", prompt: "name it" })).not.toContain("--model");
  });

  it("reads no title out of an answer that is not one: an error, an explanation, a refusal, or nothing at all", () => {
    expect(parseTitleFor('{"type":"result","is_error":false,"result":"Seed thread titles from opening turn"}')).toBe("Seed thread titles from opening turn");
    expect(parseTitleFor('{"type":"result","is_error":true,"result":"Credit balance is too low"}')).toBeNull();
    expect(parseTitleFor('{"type":"result","is_error":false,"result":"Sure!\\nHere it is"}')).toBeNull();
    expect(parseTitleFor("Invalid API key\n")).toBeNull();
    expect(parseTitleFor("")).toBeNull();
  });
});
