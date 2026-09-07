// SPDX-License-Identifier: AGPL-3.0-only
// The fixture is the record shape of a real session file under
// CLAUDE_CONFIG_DIR/projects/, with the ordering measured on 2.1.263: the last
// ai-title line of a renamed session sits AFTER its last custom-title.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRenameWrite } from "@wsp/protocol";
import { parseRename, parseSessionTitle, renameCommand, sessionTitleCommand } from "../src/session-title.js";

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

/** The rename as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const renameTo = async (configDir: string, sessionId: string, title: string): Promise<SessionRenameWrite> =>
  parseRename((await run("bash", ["-c", renameCommand({ configDir, sessionId, title })])).stdout);

describe("naming a Claude Code session from wsp", () => {
  it("appends the record the CLI's own rename appends, and the read gives that name back", async () => {
    const dir = configDir({ [`${SESSION}.jsonl`]: `{"type":"ai-title","aiTitle":"Understanding the build","sessionId":"${SESSION}"}\n` });
    expect(await renameTo(dir, SESSION, "the name he typed in wsp")).toEqual({ kind: "written" });
    const lines = readFileSync(join(dir, "projects", "-root-work-proj", `${SESSION}.jsonl`), "utf8").split("\n").filter(l => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ type: "custom-title", customTitle: "the name he typed in wsp", sessionId: SESSION });
    expect(await titleOf(dir, SESSION)).toBe("the name he typed in wsp");
  });

  it("keeps a name holding a quote, a newline and a percent sign as one record", async () => {
    const dir = configDir({ [`${SESSION}.jsonl`]: `{"type":"user","sessionId":"${SESSION}"}\n` });
    expect(await renameTo(dir, SESSION, "it's 100%\nhere")).toEqual({ kind: "written" });
    expect(readFileSync(join(dir, "projects", "-root-work-proj", `${SESSION}.jsonl`), "utf8").split("\n").filter(l => l !== "")).toHaveLength(2);
    expect(await titleOf(dir, SESSION)).toBe("it's 100%\nhere");
  });

  it("closes a half-written last line rather than being swallowed by it", async () => {
    const dir = configDir({ [`${SESSION}.jsonl`]: `{"type":"ai-title","aiTitle":"Understanding the build","sessionId":"${SESSION}"}\n{"type":"assis` });
    expect(await renameTo(dir, SESSION, "the name")).toEqual({ kind: "written" });
    expect(await titleOf(dir, SESSION)).toBe("the name");
  });

  it("says no session when the glob answered and no file of that id is there", async () => {
    expect(await renameTo(configDir({}), SESSION, "the name")).toEqual({ kind: "no-session" });
  });

  it("says failed with the machine's own line when the append cannot run, never that the session is not there", async () => {
    // The id is there for the glob to find and cannot be appended to, whatever user the machine runs the line as.
    const dir = configDir({});
    mkdirSync(join(dir, "projects", "-root-work-proj", `${SESSION}.jsonl`), { recursive: true });
    const wrote = await renameTo(dir, SESSION, "the name");
    expect(wrote.kind).toBe("failed");
    expect(wrote.kind === "failed" ? wrote.error : "").toContain("Is a directory");
  });

  it("quotes the config dir and the session id, and a name that reads as shell lands as the bytes it is", async () => {
    const command = renameCommand({ configDir: "/root/it's here", sessionId: SESSION, title: "x" });
    expect(command).toContain(String.raw`'/root/it'\''s here/projects'/*/`);
    expect(command).toContain(`'${SESSION}.jsonl'`);
    const dir = configDir({ [`${SESSION}.jsonl`]: `{"type":"user","sessionId":"${SESSION}"}\n` });
    expect(await renameTo(dir, SESSION, "$(touch /tmp/wsp-402-never) 'x'")).toEqual({ kind: "written" });
    expect(await titleOf(dir, SESSION)).toBe("$(touch /tmp/wsp-402-never) 'x'");
    expect(existsSync("/tmp/wsp-402-never")).toBe(false);
  });

  it("reads a stdout it does not know as a failure carrying what was said, since an unconfirmed write is not a missing session", () => {
    expect(parseRename("")).toEqual({ kind: "failed", error: "the machine said nothing about the write" });
    expect(parseRename("bash: no such file\n")).toEqual({ kind: "failed", error: "bash: no such file" });
    expect(parseRename("no-session\n")).toEqual({ kind: "no-session" });
    expect(parseRename("wrote\n")).toEqual({ kind: "written" });
  });
});
